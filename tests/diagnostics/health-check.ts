/**
 * Watch Tower — System Health Check Diagnostics
 *
 * Checks every component of the system and prints a formatted status table.
 * Run with: npx tsx tests/diagnostics/health-check.ts
 *
 * Exit codes:
 *   0 — no critical failures
 *   1 — one or more critical failures
 */

// Load .env from project root before any other imports
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Walk up from tests/diagnostics/ to find project root (.env lives there)
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const ENV_FILE = path.join(PROJECT_ROOT, ".env");

if (fs.existsSync(ENV_FILE)) {
  const raw = fs.readFileSync(ENV_FILE, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

import pg from "pg";
import Redis from "ioredis";

// ─── Types ───────────────────────────────────────────────────────────────────

type StatusLevel = "OK" | "WARN" | "FAIL";

interface CheckResult {
  component: string;
  status: StatusLevel;
  details: string;
}

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const COLOR = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
};

function colorize(text: string, level: StatusLevel): string {
  switch (level) {
    case "OK":
      return `${COLOR.green}${text}${COLOR.reset}`;
    case "WARN":
      return `${COLOR.yellow}${text}${COLOR.reset}`;
    case "FAIL":
      return `${COLOR.red}${text}${COLOR.reset}`;
  }
}

function bold(text: string): string {
  return `${COLOR.bold}${text}${COLOR.reset}`;
}

function dim(text: string): string {
  return `${COLOR.dim}${text}${COLOR.reset}`;
}

function cyan(text: string): string {
  return `${COLOR.cyan}${text}${COLOR.reset}`;
}

// ─── BullMQ Redis Key Patterns ───────────────────────────────────────────────

const BULLMQ_QUEUES = [
  "pipeline-ingest",
  "pipeline-semantic-dedup",
  "pipeline-llm-brain",
  "pipeline-distribution",
  "pipeline-translation",
  "pipeline-image-generation",
  "maintenance",
] as const;

// BullMQ stores waiting jobs under "bull:{queue}:wait" (list) and
// delayed jobs under "bull:{queue}:delayed" (sorted set).
// We sum llen + zcard across all queues for an approximate backlog count.

// ─── Intermediate pipeline stages (neither terminal nor start) ───────────────

const STUCK_STAGES = ["embedded", "translating"] as const;

// ─── Helper: format relative time ────────────────────────────────────────────

function formatAge(date: Date | null): string {
  if (!date) return "never";
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} hour${diffH === 1 ? "" : "s"} ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD} day${diffD === 1 ? "" : "s"} ago`;
}

// ─── Individual Checks ───────────────────────────────────────────────────────

async function checkPostgres(): Promise<{
  result: CheckResult;
  client: pg.Client | null;
}> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    return {
      result: {
        component: "PostgreSQL",
        status: "FAIL",
        details: "DATABASE_URL not set",
      },
      client: null,
    };
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const res = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM information_schema.tables
       WHERE table_schema = 'public'`,
    );
    const tableCount = parseInt(res.rows[0]?.count ?? "0", 10);
    return {
      result: {
        component: "PostgreSQL",
        status: "OK",
        details: `Connected, ${tableCount} table${tableCount === 1 ? "" : "s"}`,
      },
      client,
    };
  } catch (err) {
    await client.end().catch(() => undefined);
    return {
      result: {
        component: "PostgreSQL",
        status: "FAIL",
        details: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      client: null,
    };
  }
}

async function checkPgVector(client: pg.Client | null): Promise<CheckResult> {
  if (!client) {
    return {
      component: "pgvector extension",
      status: "FAIL",
      details: "Skipped — PostgreSQL unavailable",
    };
  }
  try {
    const res = await client.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
    );
    if (res.rows.length > 0) {
      return {
        component: "pgvector extension",
        status: "OK",
        details: "vector type available",
      };
    }
    return {
      component: "pgvector extension",
      status: "FAIL",
      details: "Extension not installed (run: CREATE EXTENSION vector)",
    };
  } catch (err) {
    return {
      component: "pgvector extension",
      status: "FAIL",
      details: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkRedis(): Promise<{ result: CheckResult; redis: Redis | null }> {
  const host = process.env["REDIS_HOST"] ?? "127.0.0.1";
  const port = parseInt(process.env["REDIS_PORT"] ?? "6379", 10);

  const redis = new Redis({
    host,
    port,
    connectTimeout: 5_000,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
  });

  try {
    await redis.connect();
    const pong = await redis.ping();
    return {
      result: {
        component: "Redis",
        status: "OK",
        details: `Connected (${host}:${port}), ${pong}`,
      },
      redis,
    };
  } catch (err) {
    redis.disconnect();
    return {
      result: {
        component: "Redis",
        status: "FAIL",
        details: `Connection failed (${host}:${port}): ${err instanceof Error ? err.message : String(err)}`,
      },
      redis: null,
    };
  }
}

function checkEnvKey(
  component: string,
  envVar: string,
  required: boolean,
): CheckResult {
  const value = process.env[envVar];
  if (value && value.trim().length > 0) {
    const masked = `${value.slice(0, 6)}${"*".repeat(Math.min(8, Math.max(0, value.length - 6)))}`;
    return {
      component,
      status: "OK",
      details: `${envVar} set (${masked})`,
    };
  }
  return {
    component,
    status: required ? "FAIL" : "WARN",
    details: `${envVar} not set${required ? " (required)" : " (optional)"}`,
  };
}

function checkMultiEnvKeys(
  component: string,
  envVars: string[],
  required: boolean,
): CheckResult {
  const missing: string[] = [];
  const found: string[] = [];
  for (const v of envVars) {
    const val = process.env[v];
    if (val && val.trim().length > 0) {
      found.push(v);
    } else {
      missing.push(v);
    }
  }

  if (missing.length === 0) {
    return {
      component,
      status: "OK",
      details: `${found.join(", ")} set`,
    };
  }
  if (found.length > 0) {
    return {
      component,
      status: "WARN",
      details: `Partial — missing: ${missing.join(", ")}`,
    };
  }
  return {
    component,
    status: required ? "FAIL" : "WARN",
    details: `Not set: ${missing.join(", ")}${required ? " (required)" : " (optional)"}`,
  };
}

async function checkRssSources(client: pg.Client | null): Promise<CheckResult> {
  if (!client) {
    return {
      component: "RSS Sources",
      status: "FAIL",
      details: "Skipped — PostgreSQL unavailable",
    };
  }
  try {
    const res = await client.query<{ total: string; active: string }>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE active = true) AS active
       FROM rss_sources`,
    );
    const total = parseInt(res.rows[0]?.total ?? "0", 10);
    const active = parseInt(res.rows[0]?.active ?? "0", 10);

    if (active === 0) {
      return {
        component: "RSS Sources",
        status: "WARN",
        details: `No active sources (${total} total)`,
      };
    }
    return {
      component: "RSS Sources",
      status: "OK",
      details: `${active} active, ${total} total`,
    };
  } catch (err) {
    return {
      component: "RSS Sources",
      status: "FAIL",
      details: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkDomainWhitelist(client: pg.Client | null): Promise<CheckResult> {
  if (!client) {
    return {
      component: "Domain Whitelist",
      status: "FAIL",
      details: "Skipped — PostgreSQL unavailable",
    };
  }
  try {
    const res = await client.query<{ total: string; active: string }>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE is_active = true) AS active
       FROM allowed_domains`,
    );
    const total = parseInt(res.rows[0]?.total ?? "0", 10);
    const active = parseInt(res.rows[0]?.active ?? "0", 10);

    if (active === 0) {
      return {
        component: "Domain Whitelist",
        status: "WARN",
        details: `No active domains (${total} total) — all RSS sources will be blocked`,
      };
    }
    return {
      component: "Domain Whitelist",
      status: "OK",
      details: `${active} active domain${active === 1 ? "" : "s"} (${total} total)`,
    };
  } catch (err) {
    return {
      component: "Domain Whitelist",
      status: "FAIL",
      details: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkStuckArticles(client: pg.Client | null): Promise<CheckResult> {
  if (!client) {
    return {
      component: "Stuck articles",
      status: "FAIL",
      details: "Skipped — PostgreSQL unavailable",
    };
  }
  try {
    // Intermediate stages that should not stay stuck for more than 1 hour
    const res = await client.query<{ stage: string; count: string }>(
      `SELECT pipeline_stage AS stage, COUNT(*) AS count
       FROM articles
       WHERE pipeline_stage = ANY($1::text[])
         AND created_at < NOW() - INTERVAL '1 hour'
       GROUP BY pipeline_stage
       ORDER BY pipeline_stage`,
      [STUCK_STAGES as unknown as string[]],
    );

    if (res.rows.length === 0) {
      return {
        component: "Stuck articles",
        status: "OK",
        details: "0 articles stuck in intermediate stages",
      };
    }

    const summary = res.rows
      .map((r) => `${r.count} × ${r.stage}`)
      .join(", ");
    const total = res.rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
    return {
      component: "Stuck articles",
      status: "WARN",
      details: `${total} stuck >1h: ${summary}`,
    };
  } catch (err) {
    return {
      component: "Stuck articles",
      status: "FAIL",
      details: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkQueueBacklog(redis: Redis | null): Promise<CheckResult> {
  if (!redis) {
    return {
      component: "Queue backlog",
      status: "FAIL",
      details: "Skipped — Redis unavailable",
    };
  }
  try {
    let totalWaiting = 0;
    let totalDelayed = 0;

    const pipeline = redis.pipeline();
    for (const queue of BULLMQ_QUEUES) {
      // BullMQ v5 uses "bull:{queue}:wait" for waiting jobs
      pipeline.llen(`bull:${queue}:wait`);
      // BullMQ v5 uses "bull:{queue}:delayed" for delayed jobs
      pipeline.zcard(`bull:${queue}:delayed`);
    }
    const results = await pipeline.exec();

    if (results) {
      for (let i = 0; i < results.length; i += 2) {
        const waitErr = results[i]?.[0];
        const waitVal = results[i]?.[1];
        const delayErr = results[i + 1]?.[0];
        const delayVal = results[i + 1]?.[1];

        if (!waitErr && typeof waitVal === "number") totalWaiting += waitVal;
        if (!delayErr && typeof delayVal === "number") totalDelayed += delayVal;
      }
    }

    const total = totalWaiting + totalDelayed;
    if (total === 0) {
      return {
        component: "Queue backlog",
        status: "OK",
        details: "0 pending jobs across all queues",
      };
    }
    // A moderate backlog is normal during active processing
    const level: StatusLevel = total > 500 ? "WARN" : "OK";
    return {
      component: "Queue backlog",
      status: level,
      details: `${totalWaiting} waiting, ${totalDelayed} delayed (${total} total)`,
    };
  } catch (err) {
    return {
      component: "Queue backlog",
      status: "FAIL",
      details: `Redis query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkLastIngest(client: pg.Client | null): Promise<CheckResult> {
  if (!client) {
    return {
      component: "Last ingest",
      status: "FAIL",
      details: "Skipped — PostgreSQL unavailable",
    };
  }
  try {
    const res = await client.query<{ latest: Date | null }>(
      `SELECT MAX(started_at) AS latest FROM feed_fetch_runs`,
    );
    const latest: Date | null = res.rows[0]?.latest ?? null;

    if (!latest) {
      return {
        component: "Last ingest",
        status: "WARN",
        details: "No ingest runs recorded yet",
      };
    }

    const ageMs = Date.now() - latest.getTime();
    const ageMin = Math.floor(ageMs / 60_000);

    // Warn if no ingest in the last 2 hours
    const status: StatusLevel = ageMin > 120 ? "WARN" : "OK";
    return {
      component: "Last ingest",
      status,
      details: formatAge(latest),
    };
  } catch (err) {
    return {
      component: "Last ingest",
      status: "FAIL",
      details: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkEmergencyStop(client: pg.Client | null): Promise<CheckResult> {
  if (!client) {
    return {
      component: "Emergency stop",
      status: "FAIL",
      details: "Skipped — PostgreSQL unavailable",
    };
  }
  try {
    const res = await client.query<{ value: string }>(
      `SELECT value FROM app_config WHERE key = 'emergency_stop' LIMIT 1`,
    );
    const raw = res.rows[0]?.value ?? "false";
    // app_config stores JSON-encoded values or raw strings
    let isActive = false;
    try {
      isActive = JSON.parse(raw) === true;
    } catch {
      isActive = raw === "true";
    }

    return {
      component: "Emergency stop",
      // Emergency stop being ON is a WARN for diagnostics — it's intentional sometimes
      status: isActive ? "WARN" : "OK",
      details: isActive ? "ACTIVE — social posting is DISABLED" : "OFF — posting enabled",
    };
  } catch (err) {
    return {
      component: "Emergency stop",
      status: "FAIL",
      details: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const COL_COMPONENT = 26;
const COL_STATUS = 10;
const DIVIDER = "─".repeat(COL_COMPONENT + COL_STATUS + 40);

function padRight(str: string, len: number): string {
  // Strip ANSI codes for length calculation
  const visibleLen = str.replace(/\x1b\[[0-9;]*m/g, "").length;
  return str + " ".repeat(Math.max(0, len - visibleLen));
}

function formatRow(component: string, status: StatusLevel, details: string): string {
  const coloredStatus = colorize(status, status);
  return `  ${padRight(component, COL_COMPONENT)}${padRight(coloredStatus, COL_STATUS + 10)}${details}`;
}

function printSection(title: string): void {
  console.log(`\n${bold(title)}`);
  console.log(dim(DIVIDER));
}

function printHeader(label: string): void {
  console.log(
    `  ${dim(padRight(label, COL_COMPONENT))}${dim(padRight("Status", COL_STATUS))}${dim("Details")}`,
  );
  console.log(dim(DIVIDER));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const now = new Date().toISOString();

  console.log("\n" + bold("=== Watch Tower System Diagnostics ==="));
  console.log(dim(`Timestamp: ${now}`));
  console.log(dim(`Project:   ${PROJECT_ROOT}`));
  console.log(dim(`Env file:  ${fs.existsSync(ENV_FILE) ? ENV_FILE : "(not found)"}`));

  const allResults: CheckResult[] = [];

  // ── Infrastructure ────────────────────────────────────────────────────────

  printSection("Infrastructure");
  printHeader("Component");

  const { result: pgResult, client } = await checkPostgres();
  allResults.push(pgResult);
  console.log(formatRow(pgResult.component, pgResult.status, pgResult.details));

  const pgvResult = await checkPgVector(client);
  allResults.push(pgvResult);
  console.log(formatRow(pgvResult.component, pgvResult.status, pgvResult.details));

  const { result: redisResult, redis } = await checkRedis();
  allResults.push(redisResult);
  console.log(formatRow(redisResult.component, redisResult.status, redisResult.details));

  // ── API Keys ─────────────────────────────────────────────────────────────

  printSection("API Keys & Credentials");
  printHeader("Service");

  // Embedding (OpenAI) — required for semantic dedup
  const embeddingCheck = checkEnvKey("Embedding API (OpenAI)", "OPENAI_API_KEY", true);
  allResults.push(embeddingCheck);
  console.log(formatRow(embeddingCheck.component, embeddingCheck.status, embeddingCheck.details));

  // LLM (Anthropic is default, but check whichever provider is configured)
  const llmProvider = process.env["LLM_PROVIDER"] ?? "claude";
  let llmCheck: CheckResult;
  if (llmProvider === "openai") {
    llmCheck = checkEnvKey("LLM API (OpenAI)", "OPENAI_API_KEY", true);
  } else if (llmProvider === "deepseek") {
    llmCheck = checkEnvKey("LLM API (DeepSeek)", "DEEPSEEK_API_KEY", true);
  } else {
    llmCheck = checkEnvKey("LLM API (Anthropic)", "ANTHROPIC_API_KEY", true);
  }
  allResults.push(llmCheck);
  console.log(formatRow(llmCheck.component, llmCheck.status, llmCheck.details));

  // Translation (Gemini) — required for Georgian translation
  const geminiCheck = checkEnvKey("Translation (Gemini)", "GOOGLE_AI_API_KEY", false);
  allResults.push(geminiCheck);
  console.log(formatRow(geminiCheck.component, geminiCheck.status, geminiCheck.details));

  // Telegram Bot
  const telegramCheck = checkEnvKey("Telegram Bot", "TELEGRAM_BOT_TOKEN", false);
  allResults.push(telegramCheck);
  console.log(
    formatRow(telegramCheck.component, telegramCheck.status, telegramCheck.details),
  );

  // Facebook
  const fbCheck = checkMultiEnvKeys(
    "Facebook",
    ["FB_PAGE_ID", "FB_ACCESS_TOKEN"],
    false,
  );
  allResults.push(fbCheck);
  console.log(formatRow(fbCheck.component, fbCheck.status, fbCheck.details));

  // LinkedIn
  const linkedinCheck = checkMultiEnvKeys(
    "LinkedIn",
    ["LINKEDIN_AUTHOR_ID", "LINKEDIN_ACCESS_TOKEN"],
    false,
  );
  allResults.push(linkedinCheck);
  console.log(
    formatRow(linkedinCheck.component, linkedinCheck.status, linkedinCheck.details),
  );

  // R2 Storage
  const r2Check = checkMultiEnvKeys(
    "R2 Storage (Cloudflare)",
    ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"],
    false,
  );
  allResults.push(r2Check);
  console.log(formatRow(r2Check.component, r2Check.status, r2Check.details));

  // ── Database Content ──────────────────────────────────────────────────────

  printSection("Database Content");
  printHeader("Resource");

  const sourcesCheck = await checkRssSources(client);
  allResults.push(sourcesCheck);
  console.log(
    formatRow(sourcesCheck.component, sourcesCheck.status, sourcesCheck.details),
  );

  const domainCheck = await checkDomainWhitelist(client);
  allResults.push(domainCheck);
  console.log(formatRow(domainCheck.component, domainCheck.status, domainCheck.details));

  // ── Pipeline Status ───────────────────────────────────────────────────────

  printSection("Pipeline Status");
  printHeader("Check");

  const stuckCheck = await checkStuckArticles(client);
  allResults.push(stuckCheck);
  console.log(formatRow(stuckCheck.component, stuckCheck.status, stuckCheck.details));

  const backlogCheck = await checkQueueBacklog(redis);
  allResults.push(backlogCheck);
  console.log(
    formatRow(backlogCheck.component, backlogCheck.status, backlogCheck.details),
  );

  const ingestCheck = await checkLastIngest(client);
  allResults.push(ingestCheck);
  console.log(formatRow(ingestCheck.component, ingestCheck.status, ingestCheck.details));

  const emergencyCheck = await checkEmergencyStop(client);
  allResults.push(emergencyCheck);
  // Special label for emergency stop
  const emergencyLabel =
    emergencyCheck.status === "OK"
      ? colorize("OFF", "OK")
      : colorize("ON", "WARN");
  console.log(
    `  ${padRight("Emergency stop", COL_COMPONENT)}${padRight(emergencyLabel, COL_STATUS + 10)}${emergencyCheck.details}`,
  );

  // ── Summary ───────────────────────────────────────────────────────────────

  const okCount = allResults.filter((r) => r.status === "OK").length;
  const warnCount = allResults.filter((r) => r.status === "WARN").length;
  const failCount = allResults.filter((r) => r.status === "FAIL").length;
  const total = allResults.length;

  console.log("\n" + dim(DIVIDER));

  const summaryParts: string[] = [
    `${colorize(`${okCount}/${total} OK`, "OK")}`,
  ];
  if (warnCount > 0) {
    summaryParts.push(colorize(`${warnCount} WARNING${warnCount === 1 ? "" : "S"}`, "WARN"));
  }
  if (failCount > 0) {
    summaryParts.push(colorize(`${failCount} CRITICAL`, "FAIL"));
  }

  const overallStatus: StatusLevel = failCount > 0 ? "FAIL" : warnCount > 0 ? "WARN" : "OK";
  const overallLabel =
    overallStatus === "OK"
      ? colorize("HEALTHY", "OK")
      : overallStatus === "WARN"
        ? colorize("DEGRADED", "WARN")
        : colorize("UNHEALTHY", "FAIL");

  console.log(`\n${bold("Overall:")} ${overallLabel}   ${summaryParts.join("  ")}`);

  if (failCount > 0) {
    console.log(
      `\n${colorize("Critical failures detected:", "FAIL")} fix the issues above before starting the pipeline.\n`,
    );
  } else if (warnCount > 0) {
    console.log(
      `\n${colorize("Warnings present:", "WARN")} pipeline may run with reduced functionality.\n`,
    );
  } else {
    console.log(`\n${colorize("All systems operational.", "OK")}\n`);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  if (client) {
    await client.end().catch(() => undefined);
  }
  if (redis) {
    redis.disconnect();
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(
    `\n${COLOR.red}Fatal error during diagnostics:${COLOR.reset}`,
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
