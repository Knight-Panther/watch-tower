import { z } from "zod";

export const baseEnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  LLM_PROVIDER: z.union([z.string().min(1), z.literal("")]).optional(),
  LLM_API_KEY: z.union([z.string().min(1), z.literal("")]).optional(),
  LLM_MODEL: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  API_KEY: z.union([z.string().min(8), z.literal("")]).optional(),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
