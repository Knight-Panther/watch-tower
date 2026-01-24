import { z } from "zod";

export const baseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  API_KEY: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3001),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export const frontendEnvSchema = z.object({
  VITE_API_URL: z.string().url(),
  VITE_API_KEY: z.string().min(1),
});
