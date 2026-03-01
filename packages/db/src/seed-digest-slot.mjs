/**
 * Migrate app_config digest_* keys → digest_slots Slot #1.
 * Idempotent: skips if digest_slots already has rows.
 *
 * Usage: node --env-file=../../.env src/seed-digest-slot.mjs
 */
import pg from "pg";

const connectionString =
  process.env.DATABASE_URL || "postgres://watchtower:watchtower@127.0.0.1:5432/watchtower";

const pool = new pg.Pool({ connectionString });

try {
  // 1. Skip if any slot already exists
  const { rows: existing } = await pool.query(
    "SELECT id FROM digest_slots LIMIT 1",
  );
  if (existing.length > 0) {
    console.info("[seed-digest-slot] digest_slots already has rows — skipping");
    process.exit(0);
  }

  // 2. Read all digest_* keys from app_config
  const { rows: configs } = await pool.query(
    "SELECT key, value FROM app_config WHERE key LIKE 'digest_%' OR key IN ('posting_language', 'LLM_PROVIDER', 'translation_provider', 'translation_model')",
  );

  const m = new Map(configs.map((r) => [r.key, r.value]));

  // Helper: parse JSON string values (app_config stores some as JSON-encoded strings)
  const str = (key, fallback) => {
    const v = m.get(key);
    if (v === undefined || v === null) return fallback;
    if (typeof v === "string") {
      // Strip wrapping quotes if present (e.g., '"en"' → 'en')
      if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
      return v;
    }
    return String(v);
  };

  const bool = (key, fallback) => {
    const v = m.get(key);
    if (v === undefined || v === null) return fallback;
    return v === true || v === "true";
  };

  const num = (key, fallback) => {
    const v = m.get(key);
    if (v === undefined || v === null) return fallback;
    const n = Number(v);
    return Number.isNaN(n) ? fallback : n;
  };

  const jsonArr = (key, fallback) => {
    const v = m.get(key);
    if (Array.isArray(v)) return JSON.stringify(v);
    if (typeof v === "string") {
      try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) return JSON.stringify(parsed);
      } catch { /* ignore */ }
    }
    return JSON.stringify(fallback);
  };

  // 3. Resolve values with fallback chain matching readDigestConfig()
  const postingLanguage = str("posting_language", "en");
  const globalLlmProvider = str("LLM_PROVIDER", "claude");
  const globalTransProvider = str("translation_provider", "gemini");
  const globalTransModel = str("translation_model", "gemini-2.5-flash");

  const slot = {
    name: "Daily Digest",
    enabled: bool("digest_enabled", false),
    time: str("digest_time", "08:00"),
    timezone: str("digest_timezone", "UTC"),
    days: jsonArr("digest_days", [1, 2, 3, 4, 5, 6, 7]),
    min_score: num("digest_min_score", 3),
    max_articles: 50,
    sector_ids: null,
    language: str("digest_language", postingLanguage),
    system_prompt: m.has("digest_system_prompt") ? str("digest_system_prompt", null) : null,
    translation_prompt: m.has("digest_translation_prompt") ? str("digest_translation_prompt", null) : null,
    provider: str("digest_provider", globalLlmProvider),
    model: str("digest_model", "claude-sonnet-4-20250514"),
    translation_provider: str("digest_translation_provider", globalTransProvider),
    translation_model: str("digest_translation_model", globalTransModel),
    auto_post: true,
    telegram_chat_id: str("digest_telegram_chat_id", null),
    telegram_enabled: bool("digest_telegram_enabled", true),
    facebook_enabled: bool("digest_facebook_enabled", false),
    linkedin_enabled: bool("digest_linkedin_enabled", false),
    image_telegram: bool("digest_image_telegram", false),
    image_facebook: bool("digest_image_facebook", false),
    image_linkedin: bool("digest_image_linkedin", false),
  };

  // 4. Insert Slot #1
  await pool.query(
    `INSERT INTO digest_slots (
      name, enabled, time, timezone, days,
      min_score, max_articles, sector_ids, language,
      system_prompt, translation_prompt,
      provider, model, translation_provider, translation_model,
      auto_post, telegram_chat_id,
      telegram_enabled, facebook_enabled, linkedin_enabled,
      image_telegram, image_facebook, image_linkedin
    ) VALUES (
      $1, $2, $3, $4, $5::jsonb,
      $6, $7, $8, $9,
      $10, $11,
      $12, $13, $14, $15,
      $16, $17,
      $18, $19, $20,
      $21, $22, $23
    )`,
    [
      slot.name,
      slot.enabled,
      slot.time,
      slot.timezone,
      slot.days,
      slot.min_score,
      slot.max_articles,
      slot.sector_ids,
      slot.language,
      slot.system_prompt,
      slot.translation_prompt,
      slot.provider,
      slot.model,
      slot.translation_provider,
      slot.translation_model,
      slot.auto_post,
      slot.telegram_chat_id,
      slot.telegram_enabled,
      slot.facebook_enabled,
      slot.linkedin_enabled,
      slot.image_telegram,
      slot.image_facebook,
      slot.image_linkedin,
    ],
  );

  console.info("[seed-digest-slot] Created Slot #1 'Daily Digest' from app_config values:");
  console.info(`  enabled=${slot.enabled}, time=${slot.time} ${slot.timezone}`);
  console.info(`  days=${slot.days}, minScore=${slot.min_score}, language=${slot.language}`);
  console.info(`  provider=${slot.provider}, model=${slot.model}`);
  console.info(`  telegram=${slot.telegram_enabled}, facebook=${slot.facebook_enabled}, linkedin=${slot.linkedin_enabled}`);
} catch (err) {
  console.error("[seed-digest-slot] Failed:", err);
  process.exit(1);
} finally {
  await pool.end();
}
