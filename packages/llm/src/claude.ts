import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider } from "./provider.js";
import type { ScoringRequest, ScoringResult } from "./types.js";
import { SCORING_WITH_SUMMARY_PROMPT, formatScoringPrompt } from "./prompts.js";
import { parseScoringResponse } from "./schemas.js";
import { logger } from "@watch-tower/shared";

/**
 * Default Claude model.
 * NOTE: Model IDs change over time. Override via LLM_MODEL env var.
 */
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

/**
 * Fallback score when parsing fails.
 * Score 3 = "needs manual review" — safe default.
 */
const FALLBACK_SCORE = 3;

export class ClaudeLLMProvider implements LLMProvider {
  private client: Anthropic;
  readonly name = "claude";
  readonly model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model ?? DEFAULT_MODEL;
  }

  async score(request: ScoringRequest): Promise<ScoringResult> {
    const prompt = formatScoringPrompt(request.promptTemplate ?? SCORING_WITH_SUMMARY_PROMPT, {
      title: request.title,
      content: request.contentSnippet ?? "",
      sector: request.sectorName ?? "General",
    });

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      });

      // Extract text from response
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      // Parse and validate with zod
      const parsed = parseScoringResponse(text);

      if (!parsed.success) {
        logger.warn(
          `[claude] Parse failed for ${request.articleId}: ${parsed.error}. Raw: ${text.slice(0, 200)}`,
        );
        // Return fallback score instead of throwing — keeps pipeline flowing
        return {
          articleId: request.articleId,
          score: FALLBACK_SCORE,
          summary: null,
          reasoning: `Parse error: ${parsed.error}`,
          error: parsed.error,
        };
      }

      return {
        articleId: request.articleId,
        score: parsed.data.score,
        summary: parsed.data.summary ?? null,
        reasoning: parsed.data.reasoning,
      };
    } catch (err) {
      logger.error(`[claude] API error for ${request.articleId}`, err);
      // Re-throw API errors (rate limits, network issues) for retry
      throw err;
    }
  }
}
