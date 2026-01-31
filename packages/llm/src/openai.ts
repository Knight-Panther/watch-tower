import OpenAI from "openai";
import type { LLMProvider } from "./provider.js";
import type { ScoringRequest, ScoringResult } from "./types.js";
import { DEFAULT_MODELS, DEFAULT_BASE_URLS } from "./types.js";
import { SCORING_WITH_SUMMARY_PROMPT, formatScoringPrompt } from "./prompts.js";
import { parseScoringResponse } from "./schemas.js";
import { logger } from "@watch-tower/shared";

/**
 * Fallback score when parsing fails.
 * Score 3 = "needs manual review" — safe default.
 */
const FALLBACK_SCORE = 3;

/**
 * Models that support JSON mode (response_format: { type: "json_object" })
 */
const JSON_MODE_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo", "deepseek-chat"];

export class OpenAILLMProvider implements LLMProvider {
  private client: OpenAI;
  readonly name: string;
  readonly model: string;

  /**
   * Create OpenAI-compatible provider.
   * @param apiKey - API key
   * @param model - Model to use (default: gpt-4o-mini)
   * @param baseUrl - Custom base URL (for DeepSeek, proxies, local models)
   * @param providerName - Provider name for logging (default: "openai")
   */
  constructor(apiKey: string, model?: string, baseUrl?: string, providerName?: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl ?? DEFAULT_BASE_URLS.openai,
    });
    this.model = model ?? DEFAULT_MODELS.openai;
    this.name = providerName ?? "openai";
  }

  async score(request: ScoringRequest): Promise<ScoringResult> {
    const prompt = formatScoringPrompt(request.promptTemplate ?? SCORING_WITH_SUMMARY_PROMPT, {
      title: request.title,
      content: request.contentSnippet ?? "",
      sector: request.sectorName ?? "General",
    });

    try {
      // Check if model supports JSON mode
      const supportsJsonMode = JSON_MODE_MODELS.some((m) => this.model.includes(m));

      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
        ...(supportsJsonMode && { response_format: { type: "json_object" } }),
      });

      const text = response.choices[0]?.message?.content ?? "";
      const parsed = parseScoringResponse(text);

      if (!parsed.success) {
        logger.warn(
          `[${this.name}] Parse failed for ${request.articleId}: ${parsed.error}. Raw: ${text.slice(0, 200)}`,
        );
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
      logger.error(`[${this.name}] API error for ${request.articleId}`, err);
      throw err;
    }
  }
}
