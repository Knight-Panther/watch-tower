export const DEFAULT_TRANSLATION_INSTRUCTIONS =
  "Translate the following English news content into Georgian. " +
  "Maintain a professional, news-appropriate tone. " +
  "Keep proper nouns (company names, person names) in their original form. " +
  "Technical terms like Bitcoin, blockchain, AI may remain in English " +
  "if no widely-accepted Georgian equivalent exists. " +
  "The translation should be natural and fluent, not word-for-word.";

export const buildTranslationPrompt = (
  title: string,
  summary: string,
  instructions: string,
): string => {
  return `${instructions}

---

TITLE (English):
${title}

SUMMARY (English):
${summary}

---

Respond with ONLY valid JSON in this exact format:
{"title_ka": "Georgian title here", "summary_ka": "Georgian summary here"}`;
};
