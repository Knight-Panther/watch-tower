import { z } from "zod";

// ─── Security Environment Schema ─────────────────────────────────────────────
// All security fields have sensible defaults and are optional.

export const securityEnvSchema = z.object({
  // Feed limits (Layer 3 & 5)
  MAX_FEED_SIZE_MB: z.coerce.number().min(1).max(50).default(5),
  MAX_ARTICLES_PER_FETCH: z.coerce.number().min(10).max(500).default(100),
  MAX_ARTICLES_PER_SOURCE_DAILY: z.coerce.number().min(50).max(5000).default(500),
  // CORS (Layer 6)
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),
  // API rate limiting (Layer 7)
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().min(10).max(1000).default(200),
});

export type SecurityEnv = z.infer<typeof securityEnvSchema>;

// ─── Core Environment Schema (internal) ──────────────────────────────────────

const coreEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  API_KEY: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Embeddings (OpenAI) - empty string treated as undefined for rollback safety
  OPENAI_API_KEY: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  // LLM Provider API Keys - empty string treated as undefined for rollback safety
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),
  DEEPSEEK_API_KEY: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),
  // Translation (Gemini)
  GOOGLE_AI_API_KEY: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),

  // Primary LLM provider: "claude" | "openai" | "deepseek" (extensible)
  LLM_PROVIDER: z.string().default("claude"),

  // Per-provider model selection (optional, sensible defaults in provider)
  LLM_CLAUDE_MODEL: z.string().optional(),
  LLM_OPENAI_MODEL: z.string().optional(),
  LLM_DEEPSEEK_MODEL: z.string().optional(),

  // Fallback provider (used if primary API fails)
  LLM_FALLBACK_PROVIDER: z.string().optional(),
  LLM_FALLBACK_MODEL: z.string().optional(),

  // Auto-approve/reject thresholds
  LLM_AUTO_APPROVE_THRESHOLD: z.coerce.number().min(0).max(5).default(5),
  LLM_AUTO_REJECT_THRESHOLD: z.coerce.number().min(0).max(5).default(2),

  // Telegram distribution
  TELEGRAM_BOT_TOKEN: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),
  TELEGRAM_CHAT_ID: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),

  // Facebook distribution
  FB_PAGE_ID: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),
  FB_ACCESS_TOKEN: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),

  // LinkedIn distribution
  LINKEDIN_AUTHOR_ID: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),
  LINKEDIN_AUTHOR_TYPE: z.enum(["person", "organization"]).default("person"),
  LINKEDIN_ACCESS_TOKEN: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),

  // Cloudflare R2 storage (image generation)
  R2_ACCOUNT_ID: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),
  R2_ACCESS_KEY_ID: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),
  R2_SECRET_ACCESS_KEY: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),
  R2_BUCKET_NAME: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),
  R2_PUBLIC_URL: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val)),
});

// ─── Base Environment Schema (merged with security) ──────────────────────────

export const baseEnvSchema = coreEnvSchema.merge(securityEnvSchema);

export type BaseEnv = z.infer<typeof baseEnvSchema>;

