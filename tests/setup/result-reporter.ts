/**
 * Custom Vitest reporter that persists test results to tests/results/
 * with timestamps for cross-session tracking.
 *
 * Usage: Add to vitest.config.ts reporters array
 *   reporters: ["verbose", "./tests/setup/result-reporter.ts"]
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TestResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  duration: number;
  error?: string;
}

interface RunResult {
  timestamp: string;
  suite: string;
  duration: number;
  summary: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
  };
  tests: TestResult[];
}

interface RunManifestEntry {
  timestamp: string;
  suite: string;
  file: string;
  summary: RunResult["summary"];
}

const RESULTS_DIR = path.resolve(__dirname, "../results");

function getSuiteName(): string {
  const args = process.argv.join(" ");
  if (args.includes("tests/integration") || args.includes("tests\\integration"))
    return "integration";
  if (args.includes("tests/e2e") || args.includes("tests\\e2e")) return "e2e";
  if (args.includes("tests/unit") || args.includes("tests\\unit")) return "unit";
  return "all";
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-").replace("Z", "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectTests(files: any[]): TestResult[] {
  const results: TestResult[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function walk(tasks: any[]) {
    for (const task of tasks) {
      if (task.type === "test") {
        results.push({
          name: task.name,
          status:
            task.result?.state === "pass"
              ? "passed"
              : task.result?.state === "fail"
                ? "failed"
                : "skipped",
          duration: task.result?.duration ?? 0,
          error:
            task.result?.state === "fail"
              ? task.result?.errors?.map((e: { message: string }) => e.message).join("\n")
              : undefined,
        });
      }
      if (task.tasks && Array.isArray(task.tasks)) {
        walk(task.tasks);
      }
    }
  }

  for (const file of files) {
    walk(file.tasks || []);
  }

  return results;
}

export default class ResultReporter {
  private startTime = 0;

  onInit() {
    this.startTime = Date.now();
    if (!existsSync(RESULTS_DIR)) {
      mkdirSync(RESULTS_DIR, { recursive: true });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onFinished(files?: any[], _errors?: unknown[]) {
    if (!files || files.length === 0) return;

    const now = new Date();
    const suite = getSuiteName();
    const tests = collectTests(files);

    const result: RunResult = {
      timestamp: now.toISOString(),
      suite,
      duration: Date.now() - this.startTime,
      summary: {
        passed: tests.filter((t) => t.status === "passed").length,
        failed: tests.filter((t) => t.status === "failed").length,
        skipped: tests.filter((t) => t.status === "skipped").length,
        total: tests.length,
      },
      tests,
    };

    // Write timestamped result file
    const timestamp = formatTimestamp(now);
    const filename = `${timestamp}_${suite}.json`;
    const filepath = path.join(RESULTS_DIR, filename);
    writeFileSync(filepath, JSON.stringify(result, null, 2));

    // Write latest (copy, for Windows compatibility)
    const latestPath = path.join(RESULTS_DIR, `latest_${suite}.json`);
    writeFileSync(latestPath, JSON.stringify(result, null, 2));

    // Update manifest index
    const manifestPath = path.join(RESULTS_DIR, "index.json");
    let manifest: RunManifestEntry[] = [];
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      } catch {
        manifest = [];
      }
    }

    manifest.push({
      timestamp: now.toISOString(),
      suite,
      file: filename,
      summary: result.summary,
    });

    if (manifest.length > 100) {
      manifest = manifest.slice(-100);
    }

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const { passed, failed, skipped, total } = result.summary;
    console.log(`\nResults saved to: tests/results/${filename}`);
    console.log(`  ${passed}/${total} passed, ${failed} failed, ${skipped} skipped`);
  }
}
