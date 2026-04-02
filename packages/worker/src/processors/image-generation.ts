import { Worker, Queue } from "bullmq";
import { and, eq, gt, inArray, notExists, sql } from "drizzle-orm";
import OpenAI from "openai";
import {
  QUEUE_IMAGE_GENERATION,
  JOB_IMAGE_GENERATE,
  JOB_DISTRIBUTION_IMMEDIATE,
  AUTO_POST_STAGGER_MS,
  logger,
  DEFAULT_IMAGE_TEMPLATE,
  type ImageTemplateConfig,
} from "@watch-tower/shared";
import type { Database } from "@watch-tower/db";
import { articles, articleImages, appConfig, llmTelemetry } from "@watch-tower/db";
import { composeNewsCard } from "../services/image-composer.js";
import type { R2Storage } from "../services/r2-storage.js";

// ─── Types ──────────────────────────────────────────────────────────────────

type ImageGenDeps = {
  connection: { host: string; port: number };
  db: Database;
  r2Storage: R2Storage;
  distributionQueue?: Queue;
  openaiApiKey?: string;
};

type ImageGenConfig = {
  enabled: boolean;
  minScore: number;
  quality: string;
  size: string;
  prompt: string;
  template: ImageTemplateConfig;
  postingLanguage: string;
};

type ClaimedArticle = {
  id: string;
  title: string;
  titleKa: string | null;
  llmSummaryKa: string | null;
  llmSummary: string | null;
  importanceScore: number | null;
  pipelineStage: string;
  translationStatus: string | null;
};

// ─── Config Reader ──────────────────────────────────────────────────────────

async function getImageGenConfig(db: Database): Promise<ImageGenConfig> {
  const keys = [
    "image_generation_enabled",
    "image_generation_min_score",
    "image_generation_quality",
    "image_generation_size",
    "image_generation_prompt",
    "image_template",
    "posting_language",
  ];

  const rows = await db
    .select({ key: appConfig.key, value: appConfig.value })
    .from(appConfig)
    .where(inArray(appConfig.key, keys));

  const m = new Map(rows.map((r) => [r.key, r.value]));

  return {
    enabled: (m.get("image_generation_enabled") as boolean) ?? false,
    minScore: (m.get("image_generation_min_score") as number) ?? 4,
    quality: (m.get("image_generation_quality") as string) ?? "medium",
    size: (m.get("image_generation_size") as string) ?? "1024x1536",
    prompt: (m.get("image_generation_prompt") as string) ?? "",
    template: (m.get("image_template") as ImageTemplateConfig) ?? DEFAULT_IMAGE_TEMPLATE,
    postingLanguage: (m.get("posting_language") as string) ?? "en",
  };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_BATCH_SIZE = 5;
const IMAGE_MODEL = "gpt-image-1-mini";
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 5_000;

// ─── Worker Factory ─────────────────────────────────────────────────────────

export const createImageGenerationWorker = ({
  connection,
  db,
  r2Storage,
  distributionQueue,
  openaiApiKey,
}: ImageGenDeps) => {
  const openai = new OpenAI({ apiKey: openaiApiKey });

  return new Worker(
    QUEUE_IMAGE_GENERATION,
    async (job) => {
      if (job.name !== JOB_IMAGE_GENERATE) {
        return { skipped: true, reason: "unknown_job_type" };
      }

      // 1. Read config
      const config = await getImageGenConfig(db);

      if (!config.enabled) {
        return { skipped: true, reason: "image_generation_disabled" };
      }

      if (!openaiApiKey) {
        logger.warn("[image-gen] OPENAI_API_KEY not set, skipping");
        return { skipped: true, reason: "no_api_key" };
      }

      // 2. If job has specific articleId (queued from translation), process just that one
      const specificArticleId = job.data?.articleId as string | undefined;

      // 3. Find articles that need image generation
      let articlesToProcess: ClaimedArticle[];

      if (specificArticleId) {
        // Single article (chained from translation)
        const rows = await db
          .select({
            id: articles.id,
            title: articles.title,
            titleKa: articles.titleKa,
            llmSummaryKa: articles.llmSummaryKa,
            llmSummary: articles.llmSummary,
            importanceScore: articles.importanceScore,
            pipelineStage: articles.pipelineStage,
            translationStatus: articles.translationStatus,
          })
          .from(articles)
          .where(eq(articles.id, specificArticleId))
          .limit(1);

        if (rows.length === 0) {
          return { skipped: true, reason: "article_not_found" };
        }

        // Check if image already exists
        const [existing] = await db
          .select({ id: articleImages.id })
          .from(articleImages)
          .where(
            and(
              eq(articleImages.articleId, specificArticleId),
              inArray(articleImages.status, ["ready", "generating", "pending"]),
            ),
          )
          .limit(1);

        if (existing) {
          logger.info({ articleId: specificArticleId }, "[image-gen] image already exists, skipping");
          return { skipped: true, reason: "image_already_exists" };
        }

        articlesToProcess = rows;
      } else {
        // Batch mode (recurring job) — find unprocessed articles
        // Time guard: only process articles from last 48h to prevent backfill on first deploy
        const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

        articlesToProcess = await db
          .select({
            id: articles.id,
            title: articles.title,
            titleKa: articles.titleKa,
            llmSummaryKa: articles.llmSummaryKa,
            llmSummary: articles.llmSummary,
            importanceScore: articles.importanceScore,
            pipelineStage: articles.pipelineStage,
            translationStatus: articles.translationStatus,
          })
          .from(articles)
          .where(
            and(
              inArray(articles.pipelineStage, ["approved", "posted", "posting"]),
              gt(articles.importanceScore, config.minScore - 1),
              gt(articles.scoredAt, cutoff),
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(articleImages)
                  .where(
                    and(
                      eq(articleImages.articleId, articles.id),
                      inArray(articleImages.status, [
                        "ready",
                        "generating",
                        "pending",
                        "failed",
                      ]),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(sql`${articles.importanceScore} DESC, ${articles.scoredAt} ASC`)
          .limit(MAX_BATCH_SIZE);
      }

      if (articlesToProcess.length === 0) {
        return { processed: 0, reason: "no_articles_pending" };
      }

      // Georgian mode guard: skip untranslated articles to avoid wasting image generation costs.
      // Images overlay the Georgian title, so generating without translation is pointless.
      if (config.postingLanguage === "ka") {
        const before = articlesToProcess.length;
        const skipped: string[] = [];
        articlesToProcess = articlesToProcess.filter((a) => {
          if (!a.titleKa || !a.llmSummaryKa) {
            skipped.push(a.id.slice(0, 8));
            return false;
          }
          return true;
        });
        if (skipped.length > 0) {
          logger.debug(
            { skipped: skipped.length, articleIds: skipped },
            "[image-gen] Georgian mode: skipping untranslated articles",
          );
        }
        if (articlesToProcess.length === 0) {
          return {
            processed: 0,
            reason: "all_articles_awaiting_georgian_translation",
            skippedCount: before,
          };
        }
      }

      logger.info(
        { count: articlesToProcess.length },
        "[image-gen] processing batch",
      );

      // 4. Process each article
      let successCount = 0;
      let autoPostIndex = 0;

      for (const article of articlesToProcess) {
        const startTime = Date.now();

        try {
          // Insert pending record (prevents duplicate processing)
          const [imageRow] = await db
            .insert(articleImages)
            .values({
              articleId: article.id,
              provider: IMAGE_MODEL,
              model: IMAGE_MODEL,
              prompt: article.llmSummary || article.title,
              status: "generating",
            })
            .returning({ id: articleImages.id });

          // Generate background image via OpenAI (with in-worker retry for transient errors)
          const prompt = buildImagePrompt(article.llmSummary || article.title, config.prompt);

          logger.info(
            { articleId: article.id, promptLength: prompt.length },
            "[image-gen] calling OpenAI",
          );

          let base64: string | undefined;
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              const response = await openai.images.generate({
                model: IMAGE_MODEL,
                prompt,
                n: 1,
                size: config.size as "1024x1024" | "1024x1536" | "1536x1024",
                quality: config.quality as "low" | "medium" | "high",
                output_format: "png",
              });

              base64 = response.data?.[0]?.b64_json;
              if (!base64) throw new Error("No image data in OpenAI response");
              break; // success
            } catch (apiErr) {
              const isTransient = isTransientError(apiErr);
              if (!isTransient || attempt === MAX_RETRIES) {
                throw apiErr; // permanent error or exhausted retries → bubble up
              }
              const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
              logger.warn(
                { articleId: article.id, attempt, delayMs, error: String(apiErr) },
                "[image-gen] transient error, retrying",
              );
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
          }

          // Compose news card: use translated title when posting in Georgian, English otherwise
          const overlayTitle =
            config.postingLanguage === "ka" ? article.titleKa || article.title : article.title;
          const composedBuffer = await composeNewsCard(base64!, overlayTitle, config.template);

          // Upload to R2
          const r2Key = `images/${article.id}.webp`;
          const imageUrl = await r2Storage.uploadImage(composedBuffer, r2Key);

          // Calculate cost (gpt-image-1-mini medium 1024x1536 ≈ $0.015)
          const latencyMs = Date.now() - startTime;
          const costMicrodollars = estimateCost(config.quality, config.size);

          // Update article_images row
          await db
            .update(articleImages)
            .set({
              status: "ready",
              imageUrl,
              r2Key,
              costMicrodollars,
              latencyMs,
            })
            .where(eq(articleImages.id, imageRow.id));

          successCount++;

          logger.info(
            {
              articleId: article.id,
              imageUrl,
              latencyMs,
              costMicrodollars,
            },
            "[image-gen] image ready",
          );

          // Write telemetry
          await db
            .insert(llmTelemetry)
            .values({
              articleId: article.id,
              operation: "image_generation",
              provider: "openai",
              model: IMAGE_MODEL,
              isFallback: false,
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
              costMicrodollars,
              latencyMs,
              status: "success",
              errorMessage: null,
            })
            .catch((err) =>
              logger.error({ articleId: article.id, error: String(err) }, "[image-gen] telemetry insert failed"),
            );

          // Queue distribution if auto-post is enabled
          if (article.pipelineStage === "approved" && distributionQueue) {
            const autoPostRows = await db
              .select({ key: appConfig.key, value: appConfig.value })
              .from(appConfig)
              .where(
                inArray(appConfig.key, [
                  "auto_post_telegram",
                  "auto_post_facebook",
                  "auto_post_linkedin",
                ]),
              );
            const autoPostEnabled = autoPostRows.some(
              (r) => r.value === true || r.value === "true",
            );

            if (autoPostEnabled) {
              const delay = autoPostIndex * AUTO_POST_STAGGER_MS;
              await distributionQueue.add(
                JOB_DISTRIBUTION_IMMEDIATE,
                { articleId: article.id },
                { jobId: `dist-img-${article.id}`, delay },
              );
              autoPostIndex++;
              logger.info(
                { articleId: article.id, delayMs: delay },
                "[image-gen] queued for distribution",
              );
            }
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.error(
            { articleId: article.id, error: errorMsg },
            "[image-gen] failed",
          );

          // Mark as failed — distribution can still post text-only
          const failLatencyMs = Date.now() - startTime;
          await db
            .update(articleImages)
            .set({
              status: "failed",
              errorMessage: errorMsg.slice(0, 500),
              latencyMs: failLatencyMs,
            })
            .where(
              and(
                eq(articleImages.articleId, article.id),
                eq(articleImages.status, "generating"),
              ),
            );

          // Write failure telemetry
          await db
            .insert(llmTelemetry)
            .values({
              articleId: article.id,
              operation: "image_generation",
              provider: "openai",
              model: IMAGE_MODEL,
              isFallback: false,
              costMicrodollars: 0,
              latencyMs: failLatencyMs,
              status: "error",
              errorMessage: errorMsg.slice(0, 500),
            })
            .catch(() => {}); // best-effort

          // Still queue for distribution (text-only fallback)
          if (article.pipelineStage === "approved" && distributionQueue && specificArticleId) {
            await distributionQueue.add(
              JOB_DISTRIBUTION_IMMEDIATE,
              { articleId: article.id },
              { jobId: `dist-img-fail-${article.id}` },
            );
            logger.info(
              { articleId: article.id },
              "[image-gen] queued for distribution (text-only fallback)",
            );
          }
        }
      }

      return { processed: articlesToProcess.length, success: successCount };
    },
    {
      connection,
      concurrency: 2,
      limiter: { max: 5, duration: 60_000 }, // Max 5 images per minute
    },
  );
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const DEFAULT_IMAGE_PROMPT =
  `Create a professional, visually striking editorial illustration for a news article. ` +
  `The image should work well as a social media news card background with text overlay. ` +
  `Use modern, clean design with bold colors and clear visual hierarchy. ` +
  `Do NOT include any text, words, or letters in the image. ` +
  `Article topic: {summary}`;

/**
 * Build a prompt for the AI image generator.
 * Uses the custom prompt from app_config if set, otherwise falls back to default.
 * The placeholder {summary} is replaced with the article's English summary.
 */
function buildImagePrompt(englishSummary: string, customPrompt?: string): string {
  const template = customPrompt && customPrompt.trim() ? customPrompt : DEFAULT_IMAGE_PROMPT;
  return template.replace(/\{summary\}/g, englishSummary);
}

/**
 * Estimate cost in microdollars based on quality and size.
 * gpt-image-1-mini approximate rates:
 * - low 1024x1024: $0.005, low 1024x1536: $0.006
 * - medium 1024x1024: $0.011, medium 1024x1536: $0.015
 * - high 1024x1024: $0.036, high 1024x1536: $0.052
 */
/**
 * Detect transient errors that are worth retrying:
 * - HTTP 429 (rate limit), 500, 502, 503, 504 (server issues)
 * - Network errors (ECONNRESET, ETIMEDOUT, etc.)
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // OpenAI SDK wraps status codes in the error
    if ("status" in err) {
      const status = (err as { status: number }).status;
      return status === 429 || status >= 500;
    }
    // Network errors
    if (
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("econnrefused") ||
      msg.includes("socket hang up") ||
      msg.includes("network") ||
      msg.includes("timeout") ||
      msg.includes("rate limit") ||
      msg.includes("429")
    ) {
      return true;
    }
  }
  return false;
}

function estimateCost(quality: string, size: string): number {
  const isLarge = size !== "1024x1024";
  switch (quality) {
    case "low":
      return isLarge ? 6000 : 5000; // $0.006 / $0.005
    case "medium":
      return isLarge ? 15000 : 11000; // $0.015 / $0.011
    case "high":
      return isLarge ? 52000 : 36000; // $0.052 / $0.036
    default:
      return 15000; // default to medium large
  }
}
