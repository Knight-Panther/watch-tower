import type { ScoringConfig, ScoringExample } from "./schemas/scoring-config.js";
import { DEFAULT_SCORING_EXAMPLES } from "./schemas/scoring-config.js";

/**
 * Builds the SYSTEM prompt — stable instructions that don't change per article.
 * Contains: role, rubric, decision signals, output format, calibration examples.
 *
 * This goes in the `system` parameter for Claude or the `system` role message
 * for OpenAI/DeepSeek. Enables prompt caching (Claude caches repeated system prompts).
 */
export function buildScoringSystemPrompt(config: ScoringConfig, sectorName: string): string {
  const prioritiesSection =
    config.priorities.length > 0
      ? `\nPRIORITIZE articles about: ${config.priorities.join(", ")}`
      : "";

  const ignoreSection =
    config.ignore.length > 0
      ? `\nDE-PRIORITIZE articles about: ${config.ignore.join(", ")}`
      : "";

  // Use custom examples if provided, otherwise use built-in defaults
  // Defensive: old DB rows may lack `examples` field (pre-migration JSONB)
  const examples =
    config.examples && config.examples.length > 0 ? config.examples : DEFAULT_SCORING_EXAMPLES;
  const examplesSection = formatExamples(examples);

  return `You are a ${sectorName} news analyst for a professional media monitoring system.

Your task: analyze news articles and assign an importance score (1-5) with a concise summary.
${prioritiesSection}${ignoreSection}

SCORING RUBRIC:
1 = ${config.score1}
2 = ${config.score2}
3 = ${config.score3}
4 = ${config.score4}
5 = ${config.score5}

DECISION SIGNALS — evaluate each article against these factors:
- Novelty: Is this genuinely new information or a restatement of known facts?
- Surprise: Was this expected by the market/industry, or is it unexpected?
- Scope: Does this affect one company, a sector, or the broader market/public?
- Urgency: Does this require immediate attention or is it purely informational?
- Source credibility: Is this from a primary source or aggregated/rewritten reporting?

${examplesSection}

SUMMARY REQUIREMENTS:
- Maximum ${config.summaryMaxChars} characters
- Tone: ${config.summaryTone}
- Language: ${config.summaryLanguage}
- Style: ${config.summaryStyle}
- CRITICAL: Only include facts explicitly stated in the article. Do NOT infer, speculate, or add information not present in the provided text.

EDGE CASES:
- Empty or very short content (title only): Score based on title alone. Default to 2 unless the title clearly indicates high importance.
- Non-English article: Score the content as-is based on whatever you can understand. Do not penalize for language.
- Content marked "[truncated]": The full article was longer. Score based on available content without penalizing for incompleteness.
- Clearly promotional or sponsored content: Score 1 regardless of topic.

OUTPUT FORMAT:
Respond with ONLY a valid JSON object. No markdown, no code fences, no explanation outside the JSON.
Think step-by-step in the "reasoning" field BEFORE committing to a score.
{"reasoning": "Brief analysis of decision signals", "score": N, "summary": "Concise summary here"}`;
}

/**
 * Builds the USER message — article-specific data that changes per request.
 * Contains: sector label, title, and content.
 */
export function buildScoringUserMessage(
  title: string,
  content: string,
  sectorName: string,
  categories?: string[],
): string {
  const categoriesLine =
    categories && categories.length > 0
      ? `\nCategories: ${categories.join(", ")}`
      : "";
  return `Sector: ${sectorName}
Article Title: ${title}${categoriesLine}
Article Content: ${content || "No content available — score based on title only."}`;
}

/**
 * Builds a combined prompt (system + user in one string).
 * Used for:
 * - Legacy single-message provider path
 * - API prompt preview endpoint
 * - Backward compatibility with old scoring_rules.prompt_template
 */
export function buildScoringPrompt(config: ScoringConfig, sectorName: string): string {
  const systemPrompt = buildScoringSystemPrompt(config, sectorName);
  const userTemplate = `Article Title: {title}
Article Content: {content}
Sector: {sector}`;

  return `${systemPrompt}

${userTemplate}`;
}

/**
 * Formats calibration examples into a prompt section.
 */
function formatExamples(examples: ScoringExample[]): string {
  if (examples.length === 0) return "";

  const lines = examples.map(
    (ex) => `  Title: "${ex.title}"\n  Score: ${ex.score} | Reasoning: ${ex.reasoning}`,
  );

  return `CALIBRATION EXAMPLES:\n${lines.join("\n\n")}`;
}
