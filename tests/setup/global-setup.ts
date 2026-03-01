/**
 * Global test setup — runs before all test suites.
 *
 * Sets environment variables, silences logger, and initializes
 * test-specific configuration.
 */

import path from "path";
import dotenv from "dotenv";
import { beforeAll, afterAll } from "vitest";

// Load root .env BEFORE setting defaults so real DATABASE_URL is picked up
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: false });

beforeAll(() => {
  // Force test environment
  process.env.NODE_ENV = "test";

  // Silence logs during tests (override with LOG_LEVEL=debug to see them)
  if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = "error";
  }

  // Provide dummy env vars so schemas don't fail validation
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/watchtower_test";
  process.env.REDIS_HOST ??= "127.0.0.1";
  process.env.REDIS_PORT ??= "6379";
  process.env.API_KEY ??= "test-api-key";
  process.env.PORT ??= "3099";
  process.env.OPENAI_API_KEY ??= "sk-test-dummy-key";
  process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-dummy-key";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-bot-token";
  process.env.TELEGRAM_CHAT_ID ??= "-100test";
});

afterAll(() => {
  // Cleanup if needed
});
