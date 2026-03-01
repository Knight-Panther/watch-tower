/**
 * Compare two test result files and show differences.
 *
 * Usage: npx tsx tests/reports/compare.ts <file1> <file2>
 *
 * Shows:
 * - New failures (were passing, now failing)
 * - Fixed tests (were failing, now passing)
 * - Performance regressions (duration changes > 50%)
 */

import { readFileSync, existsSync } from "fs";
import path from "path";

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

function loadResult(filepath: string): RunResult {
  const resolved = filepath.startsWith("tests/results/")
    ? path.resolve(process.cwd(), filepath)
    : path.resolve(process.cwd(), "tests/results", filepath);

  if (!existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  return JSON.parse(readFileSync(resolved, "utf-8"));
}

function compare(oldResult: RunResult, newResult: RunResult) {
  const oldMap = new Map(oldResult.tests.map((t) => [t.name, t]));
  const newMap = new Map(newResult.tests.map((t) => [t.name, t]));

  const newFailures: string[] = [];
  const fixed: string[] = [];
  const regressions: { name: string; oldDuration: number; newDuration: number }[] = [];
  const newTests: string[] = [];
  const removedTests: string[] = [];

  // Check new results against old
  for (const [name, newTest] of newMap) {
    const oldTest = oldMap.get(name);
    if (!oldTest) {
      newTests.push(name);
      continue;
    }

    if (oldTest.status === "passed" && newTest.status === "failed") {
      newFailures.push(name);
    }
    if (oldTest.status === "failed" && newTest.status === "passed") {
      fixed.push(name);
    }
    if (
      oldTest.duration > 0 &&
      newTest.duration > oldTest.duration * 1.5 &&
      newTest.duration > 100
    ) {
      regressions.push({
        name,
        oldDuration: oldTest.duration,
        newDuration: newTest.duration,
      });
    }
  }

  // Check for removed tests
  for (const name of oldMap.keys()) {
    if (!newMap.has(name)) {
      removedTests.push(name);
    }
  }

  // Print report
  console.log("=== Test Result Comparison ===\n");
  console.log(`Old: ${oldResult.timestamp} (${oldResult.suite})`);
  console.log(`New: ${newResult.timestamp} (${newResult.suite})\n`);

  console.log("Summary:");
  console.log(
    `  Old: ${oldResult.summary.passed}/${oldResult.summary.total} passed, ${oldResult.summary.failed} failed`,
  );
  console.log(
    `  New: ${newResult.summary.passed}/${newResult.summary.total} passed, ${newResult.summary.failed} failed`,
  );
  console.log();

  if (newFailures.length > 0) {
    console.log(`❌ New failures (${newFailures.length}):`);
    newFailures.forEach((t) => console.log(`  - ${t}`));
    console.log();
  }

  if (fixed.length > 0) {
    console.log(`✅ Fixed (${fixed.length}):`);
    fixed.forEach((t) => console.log(`  - ${t}`));
    console.log();
  }

  if (regressions.length > 0) {
    console.log(`⚠️  Performance regressions (${regressions.length}):`);
    regressions.forEach((r) => {
      const pct = Math.round(((r.newDuration - r.oldDuration) / r.oldDuration) * 100);
      console.log(`  - ${r.name}: ${r.oldDuration}ms → ${r.newDuration}ms (+${pct}%)`);
    });
    console.log();
  }

  if (newTests.length > 0) {
    console.log(`🆕 New tests (${newTests.length}):`);
    newTests.forEach((t) => console.log(`  - ${t}`));
    console.log();
  }

  if (removedTests.length > 0) {
    console.log(`🗑️  Removed tests (${removedTests.length}):`);
    removedTests.forEach((t) => console.log(`  - ${t}`));
    console.log();
  }

  if (
    newFailures.length === 0 &&
    fixed.length === 0 &&
    regressions.length === 0 &&
    newTests.length === 0 &&
    removedTests.length === 0
  ) {
    console.log("No differences found between the two runs.");
  }
}

// CLI entry
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log("Usage: npx tsx tests/reports/compare.ts <old-result.json> <new-result.json>");
  console.log("Example: npx tsx tests/reports/compare.ts latest_unit.json 2026-03-01_unit.json");
  process.exit(1);
}

const oldResult = loadResult(args[0]);
const newResult = loadResult(args[1]);
compare(oldResult, newResult);
