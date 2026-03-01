/**
 * Post-test script that saves Vitest JSON output to tests/results/
 * with timestamps for cross-session tracking.
 *
 * Used by npm scripts: vitest run ... | save-results.ts
 * Or standalone: npx tsx tests/setup/save-results.ts <suite> <json-file>
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RESULTS_DIR = path.resolve(__dirname, "../results");

interface VitestJsonResult {
  numTotalTestSuites: number;
  numPassedTestSuites: number;
  numFailedTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  startTime: number;
  success: boolean;
  testResults: Array<{
    name: string;
    assertionResults: Array<{
      fullName: string;
      status: "passed" | "failed" | "pending";
      duration: number;
      failureMessages?: string[];
    }>;
  }>;
}

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

interface ManifestEntry {
  timestamp: string;
  suite: string;
  file: string;
  summary: RunResult["summary"];
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-").replace("Z", "");
}

function detectSuite(): string {
  const args = process.argv.join(" ");
  if (args.includes("integration")) return "integration";
  if (args.includes("e2e")) return "e2e";
  if (args.includes("unit")) return "unit";
  return "all";
}

export function saveResults(suite: string, vitestJson: VitestJsonResult): string {
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const tests: TestResult[] = [];
  for (const file of vitestJson.testResults || []) {
    for (const assertion of file.assertionResults || []) {
      tests.push({
        name: assertion.fullName,
        status:
          assertion.status === "passed"
            ? "passed"
            : assertion.status === "failed"
              ? "failed"
              : "skipped",
        duration: assertion.duration ?? 0,
        error: assertion.failureMessages?.join("\n") || undefined,
      });
    }
  }

  const now = new Date();
  const result: RunResult = {
    timestamp: now.toISOString(),
    suite,
    duration: Date.now() - (vitestJson.startTime || Date.now()),
    summary: {
      passed: tests.filter((t) => t.status === "passed").length,
      failed: tests.filter((t) => t.status === "failed").length,
      skipped: tests.filter((t) => t.status === "skipped").length,
      total: tests.length,
    },
    tests,
  };

  // Write timestamped file
  const timestamp = formatTimestamp(now);
  const filename = `${timestamp}_${suite}.json`;
  const filepath = path.join(RESULTS_DIR, filename);
  writeFileSync(filepath, JSON.stringify(result, null, 2));

  // Write latest copy
  const latestPath = path.join(RESULTS_DIR, `latest_${suite}.json`);
  writeFileSync(latestPath, JSON.stringify(result, null, 2));

  // Update manifest
  const manifestPath = path.join(RESULTS_DIR, "index.json");
  let manifest: ManifestEntry[] = [];
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

  return filename;
}

// CLI entry point
const args = process.argv.slice(2);
const suite = args[0] || detectSuite();
const jsonFile = args[1];

if (jsonFile) {
  // Read from file
  const json = JSON.parse(readFileSync(jsonFile, "utf-8"));
  const filename = saveResults(suite, json);
  const result = JSON.parse(readFileSync(path.join(RESULTS_DIR, filename), "utf-8"));
  console.log(`\nResults saved: tests/results/${filename}`);
  console.log(
    `  ${result.summary.passed}/${result.summary.total} passed, ${result.summary.failed} failed, ${result.summary.skipped} skipped`,
  );
} else {
  // Read from stdin
  let data = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const json = JSON.parse(data);
      const filename = saveResults(suite, json);
      const result = JSON.parse(readFileSync(path.join(RESULTS_DIR, filename), "utf-8"));
      console.log(`\nResults saved: tests/results/${filename}`);
      console.log(
        `  ${result.summary.passed}/${result.summary.total} passed, ${result.summary.failed} failed, ${result.summary.skipped} skipped`,
      );
    } catch (err) {
      console.error("Failed to parse JSON from stdin:", err);
      process.exit(1);
    }
  });
}
