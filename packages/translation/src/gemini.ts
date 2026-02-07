import { GoogleGenerativeAI } from "@google/generative-ai";
import type { TranslationResult } from "./types.js";
import { buildTranslationPrompt, DEFAULT_TRANSLATION_INSTRUCTIONS } from "./prompts.js";
import { logger } from "@watch-tower/shared";

export const translateWithGemini = async (
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
    const client = new GoogleGenerativeAI(apiKey);
    const genModel = client.getGenerativeModel({
      model,
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 1024,
      },
    });

    const result = await genModel.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    const latencyMs = Date.now() - startTime;

    // Parse JSON response
    let parsed: { title_ka?: string; summary_ka?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.warn(`[translation] JSON parse failed: ${text.slice(0, 200)}`);
      return {
        titleKa: null,
        summaryKa: null,
        error: "Failed to parse translation response",
        latencyMs,
      };
    }

    // Extract usage metadata
    const usageMetadata = response.usageMetadata;
    const usage = usageMetadata
      ? {
          inputTokens: usageMetadata.promptTokenCount ?? 0,
          outputTokens: usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: usageMetadata.totalTokenCount ?? 0,
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
    logger.error(`[translation] Gemini API error: ${errorMsg}`);
    return {
      titleKa: null,
      summaryKa: null,
      error: errorMsg,
      latencyMs: Date.now() - startTime,
    };
  }
};
