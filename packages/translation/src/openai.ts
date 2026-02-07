import OpenAI from "openai";
import type { TranslationResult } from "./types.js";
import { buildTranslationPrompt, DEFAULT_TRANSLATION_INSTRUCTIONS } from "./prompts.js";
import { logger } from "@watch-tower/shared";

export const translateWithOpenAI = async (
  apiKey: string,
  model: string,
  title: string,
  summary: string,
  instructions?: string,
): Promise<TranslationResult> => {
  const prompt = buildTranslationPrompt(
    title,
    summary,
    instructions || DEFAULT_TRANSLATION_INSTRUCTIONS,
  );

  const startTime = Date.now();

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const latencyMs = Date.now() - startTime;
    const text = response.choices[0]?.message?.content ?? "";

    // Parse JSON response
    let parsed: { title_ka?: string; summary_ka?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.warn(`[translation] OpenAI JSON parse failed: ${text.slice(0, 200)}`);
      return {
        titleKa: null,
        summaryKa: null,
        error: "Failed to parse translation response",
        latencyMs,
      };
    }

    const usage = response.usage
      ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : undefined;

    return {
      titleKa: parsed.title_ka ?? null,
      summaryKa: parsed.summary_ka ?? null,
      usage,
      latencyMs,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    logger.error(`[translation] OpenAI API error: ${errorMsg}`);
    return {
      titleKa: null,
      summaryKa: null,
      error: errorMsg,
      latencyMs: Date.now() - startTime,
    };
  }
};
