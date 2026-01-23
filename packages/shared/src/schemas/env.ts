import { z } from "zod";

export const baseEnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  API_KEY: z.string().optional(),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
