import type { ScoringConfig } from "./schemas/scoring-config.js";

/**
 * Builds a complete scoring prompt from structured configuration.
 *
 * Called by the worker at runtime. Performance cost is negligible (~0.01ms)
 * compared to the LLM API call (~1000-2000ms).
 *
 * @param config - Structured scoring configuration
 * @param sectorName - Name of the sector (e.g., "Technology", "Finance")
 * @returns Complete prompt string ready for LLM
 */
export function buildScoringPrompt(config: ScoringConfig, sectorName: string): string {
  // Build optional sections only if arrays have content
  const prioritiesSection =
    config.priorities.length > 0
      ? `\nPRIORITIZE articles about: ${config.priorities.join(", ")}`
      : "";

  const ignoreSection =
    config.ignore.length > 0
      ? `\nDE-PRIORITIZE articles about: ${config.ignore.join(", ")}`
      : "";

  return `You are a ${sectorName} news analyst for a media monitoring system.

Analyze the following article and provide:
1. An importance score (1-5)
2. A concise summary (max ${config.summaryMaxChars} characters)
${prioritiesSection}${ignoreSection}

SCORING CRITERIA:
1 = ${config.score1}
2 = ${config.score2}
3 = ${config.score3}
4 = ${config.score4}
5 = ${config.score5}

SUMMARY REQUIREMENTS:
- Maximum ${config.summaryMaxChars} characters
- Tone: ${config.summaryTone}
- Language: ${config.summaryLanguage}
- Style: ${config.summaryStyle}

Article Title: {title}
Article Content: {content}

Respond with ONLY valid JSON: {"score": N, "summary": "...", "reasoning": "..."}`;
}
