import { z } from "zod";

export const baseEnvSchema = z.object({
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
  LLM_AUTO_APPROVE_THRESHOLD: z.coerce.number().min(1).max(5).default(5),
  LLM_AUTO_REJECT_THRESHOLD: z.coerce.number().min(1).max(5).default(2),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export const frontendEnvSchema = z.object({
  VITE_API_URL: z.string().url(),
  VITE_API_KEY: z.string().min(1),
});
