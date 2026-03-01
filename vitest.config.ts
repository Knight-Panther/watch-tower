import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@watch-tower/shared": path.resolve(__dirname, "packages/shared/src"),
      "@watch-tower/db": path.resolve(__dirname, "packages/db/src"),
      "@watch-tower/llm": path.resolve(__dirname, "packages/llm/src"),
      "@watch-tower/embeddings": path.resolve(__dirname, "packages/embeddings/src"),
      "@watch-tower/translation": path.resolve(__dirname, "packages/translation/src"),
      "@watch-tower/social": path.resolve(__dirname, "packages/social/src"),
      "@watch-tower/worker": path.resolve(__dirname, "packages/worker/src"),
      "@watch-tower/api": path.resolve(__dirname, "packages/api/src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/setup/global-setup.ts"],
    reporters: ["verbose", "json"],
    outputFile: {
      json: "tests/results/.vitest-output.json",
    },
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Integration/E2E tests share a real database — run files sequentially
    // to prevent concurrent truncation of shared tables.
    fileParallelism: false,
    // BullMQ worker tests need more time for job processing
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json"],
      reportsDirectory: "tests/results/coverage",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/frontend/**", "**/index.ts", "**/*.d.ts"],
    },
  },
});
