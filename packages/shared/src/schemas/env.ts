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
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export const frontendEnvSchema = z.object({
  VITE_API_URL: z.string().url(),
  VITE_API_KEY: z.string().min(1),
});
