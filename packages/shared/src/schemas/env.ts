import { z } from "zod";

export const baseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  API_KEY: z.string().optional(),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
