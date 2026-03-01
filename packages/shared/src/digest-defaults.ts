/**
 * Single source of truth for digest slot defaults.
 * Used by: DB schema (column defaults), API (GET /digest-slots/defaults), frontend (new slot form).
 */
export const DIGEST_SLOT_DEFAULTS = {
  enabled: true,
  time: "08:00",
  timezone: "Asia/Tbilisi",
  days: [1, 2, 3, 4, 5, 6, 7] as number[],
  min_score: 3,
  max_articles: 50,
  language: "en" as "en" | "ka",
  provider: "openai",
  model: "gpt-4o",
  translation_provider: "gemini",
  translation_model: "gemini-2.5-flash",
  auto_post: true,
  telegram_enabled: true,
  facebook_enabled: false,
  linkedin_enabled: false,
  telegram_language: "en" as "en" | "ka",
  facebook_language: "en" as "en" | "ka",
  linkedin_language: "en" as "en" | "ka",
  image_telegram: false,
  image_facebook: false,
  image_linkedin: false,
} as const;

export type DigestSlotDefaults = typeof DIGEST_SLOT_DEFAULTS;
