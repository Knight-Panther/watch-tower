export const DEFAULT_TRANSLATION_INSTRUCTIONS =
  "Translate the following English news content into Georgian. " +
  "Maintain a professional, news-appropriate tone. " +
  "Keep proper nouns (company names, person names) in their original form. " +
  "Technical terms like Bitcoin, blockchain, AI may remain in English " +
  "if no widely-accepted Georgian equivalent exists. " +
  "The translation should be natural and fluent, not word-for-word.";

/**
 * Build the system prompt (style guide / translation instructions).
 * This goes into the system message role so the LLM treats it as authoritative instructions.
 */
export const buildSystemPrompt = (instructions?: string): string => {
  const base = instructions || DEFAULT_TRANSLATION_INSTRUCTIONS;
  return `${base}

You will receive an English news title and summary. Transform them according to your instructions above.
Respond with ONLY valid JSON in this exact format:
{"title_ka": "Georgian title here", "summary_ka": "Georgian summary here"}`;
};

/**
 * Build the user prompt (just the article content to translate).
 * Kept minimal so the LLM focuses on the content, not re-parsing instructions.
 */
export const buildUserPrompt = (title: string, summary: string): string => {
  return `TITLE (English):
${title}

SUMMARY (English):
${summary}`;
};

