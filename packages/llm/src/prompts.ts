/**
 * Input content is truncated to this length before sending to LLM.
 * Prevents context window overflow and controls costs.
 * ~10k chars ≈ ~2.5k tokens, leaving room for prompt + output.
 */
export const MAX_CONTENT_LENGTH = 10000;

/**
 * Scoring prompt template (includes summary).
 */
export const SCORING_WITH_SUMMARY_PROMPT = `You are a news analyst for a media monitoring system.

Analyze the following article and provide:
1. An importance score (1-5)
2. A concise 1-2 sentence summary (max 200 characters)

Scoring criteria:
1 = Not newsworthy (press releases, minor updates, promotional content)
2 = Low importance (routine news, minor developments)
3 = Moderate importance (notable but not urgent)
4 = High importance (significant developments, breaking news)
5 = Critical importance (major breaking news, market-moving events)

Consider: novelty, potential impact, timeliness, credibility.

Article Title: {title}
Article Content: {content}
Sector: {sector}

Respond with ONLY a valid JSON object, no markdown, no explanation:
{"score": 3, "summary": "One or two sentence summary here.", "reasoning": "Brief explanation"}`;

/**
 * Format prompt template with article data.
 * Truncates content to MAX_CONTENT_LENGTH.
 */
export const formatScoringPrompt = (
  template: string,
  article: { title: string; content: string; sector: string },
): string => {
  const truncatedContent =
    article.content.length > MAX_CONTENT_LENGTH
      ? article.content.slice(0, MAX_CONTENT_LENGTH) + "... [truncated]"
      : article.content;

  return template
    .replace("{title}", article.title)
    .replace("{content}", truncatedContent || "No content available")
    .replace("{sector}", article.sector || "General");
};
