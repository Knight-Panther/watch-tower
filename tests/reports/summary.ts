/**
 * Print a human-readable summary of the latest test results.
 *
 * Usage: npx tsx tests/reports/summary.ts
 *
 * Reads latest_*.json files from tests/results/ and prints a table.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import path from "path";

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
  tests: { name: string; status: string; duration: number; error?: string }[];
}

const RESULTS_DIR = path.resolve(__dirname, "../results");

function loadLatestResults(): RunResult[] {
  if (!existsSync(RESULTS_DIR)) {
    console.log("No results directory found. Run tests first.");
    process.exit(0);
  }

  const files = readdirSync(RESULTS_DIR).filter((f) => f.startsWith("latest_") && f.endsWith(".json"));

  if (files.length === 0) {
    console.log("No test results found. Run tests first.");
    process.exit(0);
  }

  return files.map((f) => JSON.parse(readFileSync(path.join(RESULTS_DIR, f), "utf-8")));
}

function printSummary(results: RunResult[]) {
  console.log("=== Watch Tower Test Summary ===\n");

  const pad = (s: string, n: number) => s.padEnd(n);

  console.log(
    `${pad("Suite", 16)} ${pad("Passed", 10)} ${pad("Failed", 10)} ${pad("Skipped", 10)} ${pad("Total", 8)} ${pad("Duration", 12)} ${pad("When", 24)}`,
  );
  console.log("─".repeat(90));

  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalTests = 0;

  for (const r of results) {
    const { passed, failed, skipped, total } = r.summary;
    const status = failed > 0 ? "❌" : "✅";
    const duration = `${(r.duration / 1000).toFixed(1)}s`;
    const when = new Date(r.timestamp).toLocaleString();

    console.log(
      `${status} ${pad(r.suite, 14)} ${pad(String(passed), 10)} ${pad(String(failed), 10)} ${pad(String(skipped), 10)} ${pad(String(total), 8)} ${pad(duration, 12)} ${when}`,
    );

    totalPassed += passed;
    totalFailed += failed;
    totalSkipped += skipped;
    totalTests += total;
  }

  console.log("─".repeat(90));
  const overallStatus = totalFailed > 0 ? "❌" : "✅";
  console.log(
    `${overallStatus} ${pad("TOTAL", 14)} ${pad(String(totalPassed), 10)} ${pad(String(totalFailed), 10)} ${pad(String(totalSkipped), 10)} ${pad(String(totalTests), 8)}`,
  );

  if (totalFailed > 0) {
    console.log("\n--- Failed Tests ---");
    for (const r of results) {
      const failures = r.tests.filter((t) => t.status === "failed");
      if (failures.length > 0) {
        console.log(`\n[${r.suite}]`);
        for (const f of failures) {
          console.log(`  ✗ ${f.name}`);
          if (f.error) {
            console.log(`    ${f.error.split("\n")[0]}`);
          }
        }
      }
    }
  }
}

const results = loadLatestResults();
printSummary(results);
