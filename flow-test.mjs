#!/usr/bin/env node
/**
 * FlowTest — End-to-End Pipeline Test with Translation
 *
 * Tests the complete pipeline: Ingest → Embed → Score → Translate
 * Resets all transient data, configures for Georgian translation,
 * triggers an ingest run, then monitors every stage via direct DB queries.
 *
 * PREREQUISITES (run these in separate terminals BEFORE this script):
 *   1. npm run infra:up            # PostgreSQL + Redis
 *   2. npm run dev:api             # API server on :3001
 *   3. LOG_LEVEL=debug npm run dev:worker   # Worker with verbose logs
 *
 * USAGE:
 *   node flow-test.mjs             # Full test (Georgian translation)
 *   node flow-test.mjs --english   # Test without translation (English mode)
 *   node flow-test.mjs --no-reset  # Skip the data reset (keep existing articles)
 */

import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

// ─── Configuration ───────────────────────────────────────────────────────────

const API_URL = process.env.VITE_API_URL || "http://localhost:3001";
const API_KEY = process.env.API_KEY || "";
const DB_URL = process.env.DATABASE_URL;
const POLL_MS = 3000;
const SETTLE_POLLS = 15; // 15 polls × 3s = 45s of no change → settled
const MAX_WAIT_MS = 8 * 60 * 1000; // 8 minutes

const TEST_LANG = process.argv.includes("--english") ? "en" : "ka";
const SKIP_RESET = process.argv.includes("--no-reset");

// ─── Utilities ───────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: { "x-api-key": API_KEY } };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (s, w = 18) => String(s).padEnd(w);
const ts = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

function divider(title) {
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(72)}`);
}

function sub(title) {
  console.log(`\n─── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

function ok(msg) {
  console.log(`  [OK] ${msg}`);
}
function info(msg) {
  console.log(`  [..] ${msg}`);
}
function warn(msg) {
  console.log(`  [!!] ${msg}`);
}
function fail(msg) {
  console.log(`  [XX] ${msg}`);
}

// ─── DB Queries ──────────────────────────────────────────────────────────────

async function qStageCounts(pool) {
  const { rows } = await pool.query(`
    SELECT pipeline_stage, COUNT(*)::int AS count
    FROM articles GROUP BY pipeline_stage ORDER BY pipeline_stage
  `);
  return Object.fromEntries(rows.map((r) => [r.pipeline_stage, r.count]));
}

async function qTransCounts(pool) {
  const { rows } = await pool.query(`
    SELECT COALESCE(translation_status, 'pending') AS status, COUNT(*)::int AS count
    FROM articles
    WHERE importance_score IS NOT NULL
    GROUP BY translation_status ORDER BY status
  `);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

async function qTotal(pool) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM articles");
  return rows[0].n;
}

async function qActiveSources(pool) {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM rss_sources WHERE active = true",
  );
  return rows[0].n;
}

async function qTranslatedArticles(pool) {
  const { rows } = await pool.query(`
    SELECT
      id,
      LEFT(title, 55)          AS title_en,
      LEFT(title_ka, 55)       AS title_ka,
      LEFT(llm_summary_ka, 90) AS summary_ka,
      importance_score          AS score,
      translation_status        AS status,
      translation_model         AS model,
      translated_at
    FROM articles
    WHERE translation_status IS NOT NULL
    ORDER BY translated_at DESC NULLS LAST
  `);
  return rows;
}

async function qRecentArticles(pool, limit = 10) {
  const { rows } = await pool.query(
    `SELECT
       id, LEFT(title, 50) AS title,
       importance_score AS score, pipeline_stage AS stage,
       translation_status AS trans,
       (title_ka IS NOT NULL) AS has_ka
     FROM articles ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

async function qScoredUntranslated(pool) {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS n
    FROM articles
    WHERE importance_score >= 4
      AND llm_summary IS NOT NULL
      AND translation_status IS NULL
      AND scored_at IS NOT NULL
  `);
  return rows[0].n;
}

async function qEnabledSince(pool) {
  const { rows } = await pool.query(
    "SELECT value FROM app_config WHERE key = 'translation_enabled_since'",
  );
  return rows.length ? rows[0].value : null;
}

async function qTelemetry(pool) {
  const { rows } = await pool.query(`
    SELECT operation, COUNT(*)::int AS calls,
           COALESCE(SUM(total_tokens), 0)::int AS tokens,
           COALESCE(SUM(cost_microdollars), 0)::int AS cost_micro,
           ROUND(AVG(latency_ms))::int AS avg_ms
    FROM llm_telemetry GROUP BY operation ORDER BY operation
  `);
  return rows;
}

// ─── Phase 0: Preflight ─────────────────────────────────────────────────────

async function phase0(pool) {
  divider("PHASE 0 — PREFLIGHT CHECKS");

  // Database
  try {
    await pool.query("SELECT 1");
    ok("PostgreSQL connected");
  } catch (e) {
    fail(`Database unreachable: ${e.message}`);
    process.exit(1);
  }

  // API
  try {
    const res = await fetch(`${API_URL}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    ok("API server reachable");
  } catch (e) {
    fail(`API unreachable at ${API_URL}: ${e.message}`);
    warn("Start it with:  npm run dev:api");
    process.exit(1);
  }

  // RSS sources
  const sources = await qActiveSources(pool);
  if (sources === 0) {
    fail("No active RSS sources configured! Ingest will produce 0 articles.");
    warn("Add sources via the dashboard or seed data first.");
    process.exit(1);
  }
  ok(`${sources} active RSS source(s) found`);

  // Current article count
  const total = await qTotal(pool);
  info(`Current articles in DB: ${total}`);

  // Translation config
  try {
    const cfg = await api("GET", "/config/translation");
    info(`posting_language: ${cfg.posting_language}`);
    info(`provider: ${cfg.provider} / ${cfg.model}`);
    info(`scores: [${cfg.scores.join(", ")}]`);
  } catch (e) {
    warn(`Could not read translation config: ${e.message}`);
  }

  // API keys
  sub("API Keys Available");
  info(`GOOGLE_AI_API_KEY : ${process.env.GOOGLE_AI_API_KEY ? "SET" : "MISSING"}`);
  info(`OPENAI_API_KEY    : ${process.env.OPENAI_API_KEY ? "SET" : "MISSING"}`);
  info(`DEEPSEEK_API_KEY  : ${process.env.DEEPSEEK_API_KEY ? "SET" : "MISSING"}`);
  info(`ANTHROPIC_API_KEY : ${process.env.ANTHROPIC_API_KEY ? "SET" : "MISSING"}`);

  console.log("");
  warn("IMPORTANT: Worker must be running in another terminal:");
  warn("  LOG_LEVEL=debug npm run dev:worker");
  warn("Watch that terminal for detailed pipeline logs.");
}

// ─── Phase 1: Reset ─────────────────────────────────────────────────────────

async function phase1(pool) {
  divider("PHASE 1 — RESET TRANSIENT DATA");

  if (SKIP_RESET) {
    info("--no-reset flag: skipping data reset");
    return;
  }

  const before = await qTotal(pool);
  info(`Articles before reset: ${before}`);

  const r = await api("POST", "/reset", { confirm: true });
  ok("Reset complete:");
  info(`  articles:         ${r.cleared.articles}`);
  info(`  feed_fetch_runs:  ${r.cleared.feed_fetch_runs}`);
  info(`  llm_telemetry:    ${r.cleared.llm_telemetry}`);
  info(`  post_deliveries:  ${r.cleared.post_deliveries}`);
  info(`  article_images:   ${r.cleared.article_images}`);
  info(`  redis keys:       ${r.cleared.redis_keys}`);

  // Give BullMQ a moment to stabilize after queue wipe
  await sleep(2000);

  const after = await qTotal(pool);
  ok(`Articles after reset: ${after}`);
}

// ─── Phase 2: Configure ─────────────────────────────────────────────────────

async function phase2() {
  divider(`PHASE 2 — CONFIGURE (${TEST_LANG === "ka" ? "GEORGIAN" : "ENGLISH"} MODE)`);

  // Determine translation provider (prefer OpenAI — more reliable billing)
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GOOGLE_AI_API_KEY;
  const provider = hasOpenAI ? "openai" : hasGemini ? "gemini" : null;
  const model =
    provider === "openai"
      ? "gpt-4o-mini"
      : provider === "gemini"
        ? "gemini-2.0-flash"
        : null;

  if (TEST_LANG === "ka" && !provider) {
    warn("No translation API key available — falling back to English mode.");
    warn("Set GOOGLE_AI_API_KEY or OPENAI_API_KEY in .env to test translation.");
  }

  const effectiveLang = TEST_LANG === "ka" && provider ? "ka" : "en";

  // Set translation config
  const translationPatch = { posting_language: effectiveLang };
  if (effectiveLang === "ka") {
    translationPatch.scores = [3, 4, 5];
    translationPatch.provider = provider;
    translationPatch.model = model;
  }
  await api("PATCH", "/config/translation", translationPatch);
  ok(`Posting language: ${effectiveLang}`);
  if (effectiveLang === "ka") {
    ok(`Translation provider: ${provider} / ${model}`);
    ok(`Scores to translate: [3, 4, 5]`);
  }

  // Disable auto-posting (don't spam real channels during test)
  try {
    await api("PATCH", "/config/auto-post-telegram", { enabled: false });
    ok("Auto-post Telegram: DISABLED (safe test mode)");
  } catch {
    info("Could not disable auto-post Telegram (may not exist)");
  }

  // Ensure emergency stop is off
  await api("POST", "/config/emergency-stop", { enabled: false });
  ok("Emergency stop: OFF");

  // Read back and verify
  sub("Config Verification (read-back)");
  const cfg = await api("GET", "/config/translation");
  info(`posting_language : ${cfg.posting_language}`);
  info(`provider         : ${cfg.provider}`);
  info(`model            : ${cfg.model}`);
  info(`scores           : [${cfg.scores.join(", ")}]`);

  return effectiveLang === "ka";
}

// ─── Phase 3: Trigger Ingest ────────────────────────────────────────────────

async function phase3() {
  divider("PHASE 3 — TRIGGER INGEST");

  const result = await api("POST", "/ingest/run", {});
  ok(`Ingest queued: ${result.queued}`);
  if (result.jobId) info(`Job ID: ${result.jobId}`);

  info("Articles will now flow: ingest -> embed -> score -> translate");
  info("Watch the worker terminal for real-time logs.");
}

// ─── Phase 4: Watch Pipeline ────────────────────────────────────────────────

async function phase4(pool, translationEnabled) {
  divider("PHASE 4 — WATCHING PIPELINE (live)");

  let prevStages = {};
  let prevTrans = {};
  let stablePolls = 0;
  const startTime = Date.now();

  // Milestone timestamps
  const milestones = {
    firstArticle: null,
    firstEmbedded: null,
    firstScored: null,
    firstTranslated: null,
  };

  info(`Polling every ${POLL_MS / 1000}s — will settle after ${SETTLE_POLLS * POLL_MS / 1000}s of no change`);
  info(`Max wait: ${MAX_WAIT_MS / 60000} minutes`);
  console.log("");

  while (Date.now() - startTime < MAX_WAIT_MS) {
    const stages = await qStageCounts(pool);
    const trans = translationEnabled ? await qTransCounts(pool) : {};
    const total = Object.values(stages).reduce((a, b) => a + b, 0);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    const stagesJSON = JSON.stringify(stages);
    const transJSON = JSON.stringify(trans);
    const changed =
      stagesJSON !== JSON.stringify(prevStages) ||
      transJSON !== JSON.stringify(prevTrans);

    if (changed) {
      stablePolls = 0;

      // Detect milestones
      if (total > 0 && !milestones.firstArticle) {
        milestones.firstArticle = Date.now();
        console.log(`  [>>] +${pad(elapsed + "s", 6)} ARTICLES INGESTED`);
      }
      if (stages.embedded && !milestones.firstEmbedded) {
        milestones.firstEmbedded = Date.now();
        console.log(`  [>>] +${pad(elapsed + "s", 6)} EMBEDDING STARTED`);
      }
      if ((stages.scored || stages.approved || stages.rejected) && !milestones.firstScored) {
        milestones.firstScored = Date.now();
        console.log(`  [>>] +${pad(elapsed + "s", 6)} SCORING STARTED`);
      }
      if (trans.translated && !milestones.firstTranslated) {
        milestones.firstTranslated = Date.now();
        console.log(`  [>>] +${pad(elapsed + "s", 6)} TRANSLATION STARTED`);
      }

      // Build status line
      const stageParts = Object.entries(stages)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      const transParts = Object.entries(trans)
        .filter(([k]) => k !== "pending")
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");

      let line = `  [..] +${pad(elapsed + "s", 6)} total:${total}  |  ${stageParts}`;
      if (transParts) line += `  |  trans: ${transParts}`;
      console.log(line);

      prevStages = stages;
      prevTrans = trans;
    } else {
      stablePolls++;
      if (stablePolls % 5 === 0) {
        console.log(
          `  [..] +${pad(elapsed + "s", 6)} (stable for ${(stablePolls * POLL_MS / 1000).toFixed(0)}s)`,
        );
      }

      // Check if we should keep waiting for translation
      if (stablePolls >= SETTLE_POLLS) {
        if (translationEnabled) {
          const untranslated = await qScoredUntranslated(pool);
          if (untranslated > 0 && stablePolls < SETTLE_POLLS * 3) {
            // Still have articles waiting for translation — keep going
            if (stablePolls === SETTLE_POLLS) {
              console.log(
                `  [!!] +${pad(elapsed + "s", 6)} ${untranslated} articles still awaiting translation — extending watch`,
              );
            }
            await sleep(POLL_MS);
            continue;
          }
        }
        console.log(
          `\n  [OK] Pipeline settled (no changes for ${(SETTLE_POLLS * POLL_MS / 1000).toFixed(0)}s)`,
        );
        break;
      }
    }

    await sleep(POLL_MS);
  }

  if (Date.now() - startTime >= MAX_WAIT_MS) {
    warn(`Timeout reached (${MAX_WAIT_MS / 60000} min). Pipeline may still be running.`);
  }

  // Timing summary
  sub("Pipeline Timing");
  const fmt = (ms) => ms ? `${((ms - startTime) / 1000).toFixed(1)}s` : "—";
  info(`First articles ingested : ${fmt(milestones.firstArticle)}`);
  info(`First article embedded  : ${fmt(milestones.firstEmbedded)}`);
  info(`First article scored    : ${fmt(milestones.firstScored)}`);
  info(`First article translated: ${fmt(milestones.firstTranslated)}`);
  info(`Total watch time        : ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

// ─── Phase 5: Translation Verification ──────────────────────────────────────

async function phase5(pool, translationEnabled) {
  divider("PHASE 5 — TRANSLATION VERIFICATION");

  if (!translationEnabled) {
    info("English mode — translation verification skipped.");
    return;
  }

  const articles = await qTranslatedArticles(pool);

  if (articles.length === 0) {
    warn("No articles have translation_status set.");
    warn("Possible reasons:");
    info("  1. No articles scored >= 3 (check translation_scores config)");
    info("  2. Worker translation module not started (check worker logs)");
    info("  3. Backfill guard: translation_enabled_since > article created_at");

    // Diagnostic: check scored but untranslated
    const untranslated = await qScoredUntranslated(pool);
    if (untranslated > 0) {
      warn(`${untranslated} articles with score >= 4 are awaiting translation`);
      const since = await qEnabledSince(pool);
      if (since) info(`translation_enabled_since: ${since}`);
      info("The translation worker may need more time, or check worker logs for errors.");
    }
    return;
  }

  ok(`${articles.length} article(s) with translation activity:\n`);

  for (const a of articles) {
    console.log(`  ID:     ${a.id.substring(0, 8)}...`);
    console.log(`  EN:     ${a.title_en || "(empty)"}`);
    if (a.title_ka) console.log(`  KA:     ${a.title_ka}`);
    if (a.summary_ka) console.log(`  Sum KA: ${a.summary_ka}`);
    console.log(
      `  Score: ${a.score}  |  Status: ${a.status}  |  Model: ${a.model || "—"}`,
    );
    if (a.translated_at) console.log(`  Translated: ${a.translated_at}`);
    console.log("");
  }

  const translated = articles.filter((a) => a.status === "translated").length;
  const failed = articles.filter((a) => a.status === "failed").length;
  const inProgress = articles.filter((a) => a.status === "translating").length;

  sub("Translation Summary");
  ok(`Translated: ${translated}`);
  if (failed) warn(`Failed: ${failed}`);
  if (inProgress) info(`In progress: ${inProgress}`);
}

// ─── Phase 5B: Posting Logic Verification ────────────────────────────────────

async function phase5b(pool, translationEnabled) {
  divider("PHASE 5B — POSTING & DISTRIBUTION LOGIC");

  // ── A. No premature auto-post deliveries ──────────────────────────────────
  sub("A. LLM Brain Gating (no premature deliveries)");

  const { rows: deliveries } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM post_deliveries",
  );
  const deliveryCount = deliveries[0].n;

  if (deliveryCount === 0) {
    ok("No post_deliveries created — LLM brain correctly skipped auto-post");
    if (translationEnabled) {
      info("In Georgian mode, LLM brain defers distribution to translation worker");
      info("auto_post_telegram was disabled, so translation worker also skipped");
    }
  } else {
    warn(`${deliveryCount} post_deliveries found — unexpected in test mode`);
    const { rows: details } = await pool.query(`
      SELECT pd.id, pd.platform, pd.status, LEFT(a.title, 40) AS title
      FROM post_deliveries pd
      LEFT JOIN articles a ON a.id = pd.article_id
      ORDER BY pd.created_at DESC LIMIT 5
    `);
    for (const d of details) {
      info(`  ${d.id.substring(0, 8)}... | ${d.platform} | ${d.status} | ${d.title}`);
    }
  }

  // ── B. Georgian content readiness for distribution ─────────────────────────
  sub("B. Georgian Content Readiness");

  if (!translationEnabled) {
    info("English mode — Georgian content check skipped");
  } else {
    // Check approved articles have Georgian content ready
    const { rows: approvedKa } = await pool.query(`
      SELECT
        id,
        LEFT(title, 40) AS title_en,
        LEFT(title_ka, 40) AS title_ka,
        (llm_summary_ka IS NOT NULL) AS has_summary_ka,
        translation_status
      FROM articles
      WHERE pipeline_stage IN ('approved', 'posted')
        AND importance_score >= 5
      ORDER BY scored_at DESC
      LIMIT 5
    `);

    if (approvedKa.length === 0) {
      info("No auto-approved articles (score 5) found — checking scored articles");
      const { rows: scoredKa } = await pool.query(`
        SELECT
          id,
          importance_score AS score,
          LEFT(title, 40) AS title_en,
          LEFT(title_ka, 40) AS title_ka,
          (llm_summary_ka IS NOT NULL) AS has_summary_ka,
          translation_status
        FROM articles
        WHERE translation_status = 'translated'
        ORDER BY translated_at DESC
        LIMIT 5
      `);

      if (scoredKa.length === 0) {
        warn("No translated articles found for content readiness check");
      } else {
        ok(`${scoredKa.length} translated article(s) — checking content fields:`);
        let allReady = true;
        for (const a of scoredKa) {
          const ready = a.title_ka && a.has_summary_ka;
          if (!ready) allReady = false;
          console.log(
            `  ${ready ? "[OK]" : "[XX]"} Score ${a.score} | title_ka: ${a.title_ka ? "YES" : "MISSING"} | summary_ka: ${a.has_summary_ka ? "YES" : "MISSING"}`,
          );
          if (a.title_ka) console.log(`       EN: ${a.title_en}`);
          if (a.title_ka) console.log(`       KA: ${a.title_ka}`);
        }
        if (allReady) {
          ok("All translated articles have complete Georgian content");
          info("Distribution worker would use title_ka + llm_summary_ka for these");
        } else {
          warn("Some articles missing Georgian content — distribution would roll back to 'approved'");
        }
      }
    } else {
      ok(`${approvedKa.length} auto-approved article(s):`);
      for (const a of approvedKa) {
        const ready = a.title_ka && a.has_summary_ka;
        console.log(
          `  ${ready ? "[OK]" : "[!!]"} ${a.id.substring(0, 8)}... | trans: ${a.translation_status || "NULL"} | title_ka: ${a.title_ka ? "YES" : "MISSING"}`,
        );
      }
    }
  }

  // ── C. Content Resolution Simulation ──────────────────────────────────────
  sub("C. Content Resolution Simulation");

  const { rows: simArticles } = await pool.query(`
    SELECT
      id,
      LEFT(title, 50) AS title_en,
      LEFT(title_ka, 50) AS title_ka,
      LEFT(llm_summary, 60) AS summary_en,
      LEFT(llm_summary_ka, 60) AS summary_ka,
      importance_score AS score
    FROM articles
    WHERE llm_summary IS NOT NULL
    ORDER BY importance_score DESC NULLS LAST, created_at DESC
    LIMIT 3
  `);

  if (simArticles.length === 0) {
    info("No scored articles — cannot simulate content resolution");
  } else {
    const cfg = await api("GET", "/config/translation");
    const lang = cfg.posting_language;
    info(`Simulating distribution with posting_language = "${lang}":\n`);

    for (const a of simArticles) {
      const resolvedTitle = lang === "ka" && a.title_ka ? a.title_ka : a.title_en;
      const resolvedSummary = lang === "ka" && a.summary_ka ? a.summary_ka : a.summary_en;
      const wouldUseKa = lang === "ka" && a.title_ka && a.summary_ka;
      const wouldRollback = lang === "ka" && (!a.title_ka || !a.summary_ka);

      console.log(`  Score ${a.score} | ${a.id.substring(0, 8)}...`);
      console.log(`    Title  → ${resolvedTitle}`);
      console.log(`    Summary→ ${resolvedSummary}`);
      if (wouldUseKa) console.log(`    Result → Would post in GEORGIAN`);
      else if (wouldRollback) console.log(`    Result → Would ROLL BACK (missing translation)`);
      else console.log(`    Result → Would post in ENGLISH`);
      console.log("");
    }
  }

  // ── D. Schedule + Cancel Round-Trip ───────────────────────────────────────
  sub("D. Schedule + Cancel Test");

  // Find a suitable article (translated if Georgian, scored if English)
  const { rows: candidates } = await pool.query(`
    SELECT id, LEFT(title, 50) AS title, importance_score AS score, pipeline_stage AS stage
    FROM articles
    WHERE pipeline_stage IN ('scored', 'approved')
      AND importance_score >= 3
      AND llm_summary IS NOT NULL
    ORDER BY importance_score DESC
    LIMIT 1
  `);

  if (candidates.length === 0) {
    info("No scored/approved articles available for schedule test");
  } else {
    const article = candidates[0];
    info(`Test article: [${article.score}] ${article.title}`);

    try {
      // Schedule for 1 hour from now (won't actually fire)
      const futureAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const schedResult = await api("POST", `/articles/${article.id}/schedule`, {
        platforms: ["telegram"],
        scheduled_at: futureAt,
      });
      ok(`Delivery created: ${schedResult.deliveries.length} delivery(ies)`);
      for (const d of schedResult.deliveries) {
        info(`  ID: ${d.delivery_id} | platform: ${d.platform} | status: ${d.status}`);
      }

      // Verify in DB
      const { rows: dbDelivery } = await pool.query(
        `SELECT id, platform, status, scheduled_at FROM post_deliveries
         WHERE article_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [article.id],
      );
      if (dbDelivery.length > 0) {
        ok(`DB verified: delivery exists (status: ${dbDelivery[0].status})`);
      }

      // Cancel it
      const cancelResult = await api("DELETE", `/articles/${article.id}/schedule?platform=telegram`);
      ok(`Delivery cancelled: ${cancelResult.cancelled} cancelled`);

      // Verify cancellation
      const { rows: afterCancel } = await pool.query(
        `SELECT status FROM post_deliveries WHERE article_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [article.id],
      );
      if (afterCancel.length > 0 && afterCancel[0].status === "cancelled") {
        ok("DB verified: delivery status = 'cancelled'");
      } else if (afterCancel.length === 0) {
        ok("DB verified: delivery removed");
      }
    } catch (e) {
      warn(`Schedule test failed: ${e.message}`);
    }
  }

  // ── E. Kill Switch Test ───────────────────────────────────────────────────
  sub("E. Kill Switch (Emergency Stop)");

  try {
    // Enable kill switch
    await api("POST", "/config/emergency-stop", { enabled: true });
    ok("Kill switch ACTIVATED");

    // Verify it reads back
    const state1 = await api("GET", "/config/emergency-stop");
    if (state1.enabled === true) {
      ok("Verified: emergency_stop = true");
      info("Distribution worker would skip ALL posting with this enabled");
    } else {
      fail("Kill switch state mismatch — expected true");
    }

    // Verify DB
    const { rows: dbKill } = await pool.query(
      "SELECT value FROM app_config WHERE key = 'emergency_stop'",
    );
    info(`DB value: ${JSON.stringify(dbKill[0]?.value)}`);

    // Disable kill switch
    await api("POST", "/config/emergency-stop", { enabled: false });
    ok("Kill switch DEACTIVATED");

    const state2 = await api("GET", "/config/emergency-stop");
    if (state2.enabled === false) {
      ok("Verified: emergency_stop = false (normal operation)");
    }
  } catch (e) {
    warn(`Kill switch test failed: ${e.message}`);
    // Make sure we don't leave it on
    try {
      await api("POST", "/config/emergency-stop", { enabled: false });
    } catch { /* ignore */ }
  }

  // ── F. Distribution Rollback Logic Check ──────────────────────────────────
  if (translationEnabled) {
    sub("F. Distribution Rollback Logic");

    // Check if any articles were rolled back from 'posting' to 'approved'
    // (This happens when distribution claims an article but Georgian translation is missing)
    const { rows: rolledBack } = await pool.query(`
      SELECT COUNT(*)::int AS n FROM articles
      WHERE pipeline_stage = 'approved'
        AND importance_score >= 5
        AND title_ka IS NULL
    `);

    if (rolledBack[0].n > 0) {
      info(`${rolledBack[0].n} approved article(s) without Georgian translation`);
      info("Distribution worker would roll these back to 'approved' if it tried to post");
      info("Translation worker will pick these up once it processes them");
    } else {
      ok("All approved articles either have Georgian content or translation is pending");
      info("Distribution rollback logic is not needed (all translations complete)");
    }
  }

  // ── G. Live Scheduled Dispatch (Worker Pickup) ─────────────────────────────
  sub("G. Live Scheduled Dispatch (Worker Pickup)");
  info("This test schedules a delivery for NOW and watches the maintenance worker claim it.");
  info("The worker polls every ~30s — we'll watch for up to 90s.\n");

  // Find a suitable article
  const { rows: liveCandidates } = await pool.query(`
    SELECT id, LEFT(title, 50) AS title, importance_score AS score, pipeline_stage AS stage
    FROM articles
    WHERE pipeline_stage IN ('scored', 'approved')
      AND importance_score >= 3
      AND llm_summary IS NOT NULL
    ORDER BY importance_score DESC
    LIMIT 1
  `);

  if (liveCandidates.length === 0) {
    info("No scored/approved articles available for live dispatch test — skipping");
  } else {
    const liveArticle = liveCandidates[0];
    info(`Test article: [${liveArticle.score}] ${liveArticle.title} (stage: ${liveArticle.stage})`);

    try {
      // Schedule for NOW — maintenance worker should pick this up within 30s
      const liveResult = await api("POST", `/articles/${liveArticle.id}/schedule`, {
        platforms: ["telegram"],
        scheduled_at: new Date().toISOString(),
      });
      ok(`Delivery scheduled for NOW: ${liveResult.deliveries.length} delivery(ies)`);

      const deliveryId = liveResult.deliveries[0]?.delivery_id;
      info(`  Delivery ID: ${deliveryId}`);
      info("  Watching for maintenance worker pickup...\n");

      // Poll for status change
      const dispatchStart = Date.now();
      const DISPATCH_TIMEOUT = 90_000;
      let lastStatus = "scheduled";

      while (Date.now() - dispatchStart < DISPATCH_TIMEOUT) {
        await sleep(3000);
        const elapsed = ((Date.now() - dispatchStart) / 1000).toFixed(0);

        const { rows: statusRows } = await pool.query(
          `SELECT status, error_message, sent_at, platform_post_id
           FROM post_deliveries WHERE id = $1`,
          [deliveryId],
        );

        if (statusRows.length === 0) {
          warn("Delivery row disappeared — unexpected");
          break;
        }

        const current = statusRows[0];

        if (current.status !== lastStatus) {
          lastStatus = current.status;
          info(`  [${elapsed}s] Status: ${lastStatus}${current.error_message ? ` — ${current.error_message}` : ""}`);
        } else {
          process.stdout.write(`  [${elapsed}s] Still ${lastStatus}...\r`);
        }

        // Terminal states
        if (["posted", "failed", "cancelled"].includes(current.status)) {
          console.log(""); // clear \r line
          if (current.status === "posted") {
            ok("Delivery POSTED successfully!");
            if (current.platform_post_id) info(`  Platform post ID: ${current.platform_post_id}`);
            if (current.sent_at) info(`  Sent at: ${current.sent_at}`);
          } else if (current.status === "failed") {
            warn(`Delivery FAILED: ${current.error_message || "unknown error"}`);
            info("  This is expected if Telegram bot token is not configured or platform unhealthy");
          }
          break;
        }
      }

      // Handle timeout
      if (lastStatus === "scheduled") {
        console.log("");
        warn("Timeout (90s): worker did not pick up the delivery");
        info("  Ensure worker is running and maintenance repeatable job is active");
        // Clean up orphaned delivery
        try {
          await api("DELETE", `/articles/${liveArticle.id}/schedule?platform=telegram`);
          info("  Cleaned up: cancelled orphaned delivery");
        } catch { /* ignore */ }
      } else if (lastStatus === "posting") {
        console.log("");
        warn("Timeout (90s): worker claimed delivery but hasn't finished — post may still be in progress");
      }

      // Check article stage after dispatch attempt
      const { rows: articleAfter } = await pool.query(
        "SELECT pipeline_stage FROM articles WHERE id = $1",
        [liveArticle.id],
      );
      if (articleAfter.length > 0) {
        info(`  Article stage after dispatch: ${articleAfter[0].pipeline_stage}`);
      }
    } catch (e) {
      warn(`Live dispatch test failed: ${e.message}`);
      if (e.message.includes("409")) {
        info("  Article already has a pending delivery — this is fine from the earlier D test");
      }
    }
  }
}

// ─── Phase 5C: Score 5 Auto-Post Test (Telegram + Facebook) ─────────────────

async function phase5c(pool, translationEnabled) {
  divider("PHASE 5C — SCORE 5 AUTO-POST TEST (Telegram + Facebook)");

  // Helper: watch post_deliveries for an article until terminal state or timeout
  async function watchDeliveries(pool, articleId, timeoutMs = 90_000) {
    const start = Date.now();
    const results = {};
    while (Date.now() - start < timeoutMs) {
      const { rows } = await pool.query(
        `SELECT id, platform, status, error_message, sent_at, platform_post_id
         FROM post_deliveries WHERE article_id = $1 ORDER BY platform`,
        [articleId],
      );
      if (rows.length === 0) {
        await sleep(3000);
        continue;
      }
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      let allTerminal = true;
      for (const r of rows) {
        results[r.platform] = r;
        if (!["posted", "failed", "cancelled"].includes(r.status)) {
          allTerminal = false;
        }
      }
      // Print progress
      const line = rows
        .map((r) => `${r.platform}:${r.status}`)
        .join("  ");
      process.stdout.write(`  [${elapsed}s] ${line}    \r`);

      if (allTerminal && rows.length > 0) {
        console.log(`  [${elapsed}s] ${line}    `);
        return results;
      }
      await sleep(3000);
    }
    console.log("");
    return results;
  }

  // Helper: insert synthetic article directly into DB
  async function insertSyntheticArticle(pool, suffix, opts = {}) {
    const id = crypto.randomUUID();
    const now = new Date();
    await pool.query(
      `INSERT INTO articles (
        id, url, title, content_snippet, llm_summary, importance_score,
        pipeline_stage, scored_at, approved_at, created_at,
        title_ka, llm_summary_ka, translation_status, translation_model, translated_at
      ) VALUES (
        $1, $2, $3, $4, $5, 5,
        'approved', $6, $6, $6,
        $7, $8, $9, $10, $11
      )`,
      [
        id,
        `https://synthetic-test.example.com/${suffix}-${Date.now()}`,
        opts.title || `[TEST] Synthetic Score-5 Article (${suffix})`,
        `This is a synthetic article created by flow-test for auto-post testing.`,
        opts.summary || `Important breaking news: synthetic test article for verifying auto-post pipeline on ${suffix} mode.`,
        now,
        opts.titleKa || null,
        opts.summaryKa || null,
        opts.translationStatus || null,
        opts.translationModel || null,
        opts.translatedAt || null,
      ],
    );
    return id;
  }

  // ── A. Georgian Auto-Post (Translation → Distribution) ──────────────────
  sub("A. Georgian Mode — Score 5 Auto-Post via Translation Worker");

  if (!translationEnabled) {
    info("English-only mode — skipping Georgian auto-post test");
  } else {
    try {
      // 1. Enable auto-posting on both platforms
      await api("PATCH", "/config/auto-post-telegram", { enabled: true });
      await api("PATCH", "/config/auto-post-facebook", { enabled: true });
      ok("Enabled auto_post_telegram + auto_post_facebook");

      // 2. Ensure Georgian mode
      const cfg = await api("GET", "/config/translation");
      ok(`Posting language: ${cfg.posting_language} (should be "ka")`);

      // 3. Insert synthetic article (no translation yet — worker will translate)
      const kaArticleId = await insertSyntheticArticle(pool, "georgian", {
        title: "[TEST] Score 5 Georgian Auto-Post — Flow Test",
        summary: "This synthetic article tests the full Georgian auto-post pipeline: translation worker translates, then queues for distribution to Telegram and Facebook.",
      });
      ok(`Inserted synthetic article: ${kaArticleId.substring(0, 8)}...`);
      info("Waiting for translation worker (15s poll) → translate → queue distribution...\n");

      // 4. Watch for translation first (up to 60s)
      const transStart = Date.now();
      let translated = false;
      while (Date.now() - transStart < 60_000) {
        const { rows } = await pool.query(
          "SELECT translation_status, title_ka FROM articles WHERE id = $1",
          [kaArticleId],
        );
        const elapsed = ((Date.now() - transStart) / 1000).toFixed(0);
        if (rows[0]?.translation_status === "translated") {
          ok(`Translated in ${elapsed}s`);
          if (rows[0].title_ka) info(`  KA title: ${rows[0].title_ka.substring(0, 60)}...`);
          translated = true;
          break;
        } else if (rows[0]?.translation_status === "failed") {
          warn(`Translation failed after ${elapsed}s`);
          break;
        }
        process.stdout.write(`  [${elapsed}s] translation_status: ${rows[0]?.translation_status || "NULL"}...\r`);
        await sleep(3000);
      }
      console.log("");

      if (translated) {
        // 5. Watch for distribution (translation worker should have queued it)
        //    The immediate distribution path posts to each platform sequentially,
        //    so we first wait for ANY delivery, then wait for the article to leave
        //    'posting' stage (meaning the worker finished all platforms).
        info("Watching for distribution worker to post...\n");
        await watchDeliveries(pool, kaArticleId, 90_000);

        // Wait for the distribution worker to finish ALL platforms
        // (article leaves 'posting' once worker completes)
        const settleStart = Date.now();
        let finalStage = "posting";
        while (Date.now() - settleStart < 15_000) {
          const { rows } = await pool.query(
            "SELECT pipeline_stage FROM articles WHERE id = $1",
            [kaArticleId],
          );
          finalStage = rows[0]?.pipeline_stage || "unknown";
          if (finalStage !== "posting") break;
          await sleep(1000);
        }

        // Re-fetch deliveries after worker finished
        const { rows: allDeliveryRows } = await pool.query(
          `SELECT id, platform, status, error_message, sent_at, platform_post_id
           FROM post_deliveries WHERE article_id = $1 ORDER BY platform`,
          [kaArticleId],
        );
        const deliveries = {};
        for (const r of allDeliveryRows) deliveries[r.platform] = r;

        const telegramResult = deliveries["telegram"];
        const facebookResult = deliveries["facebook"];

        sub("Georgian Auto-Post Results");
        if (telegramResult) {
          if (telegramResult.status === "posted") {
            ok(`Telegram: POSTED (post ID: ${telegramResult.platform_post_id || "—"})`);
          } else {
            warn(`Telegram: ${telegramResult.status} — ${telegramResult.error_message || "no error"}`);
          }
        } else {
          warn("Telegram: no delivery created");
        }

        if (facebookResult) {
          if (facebookResult.status === "posted") {
            ok(`Facebook: POSTED (post ID: ${facebookResult.platform_post_id || "—"})`);
          } else {
            warn(`Facebook: ${facebookResult.status} — ${facebookResult.error_message || "no error"}`);
          }
        } else {
          warn("Facebook: no delivery created (rate limited or platform disabled)");
        }

        info(`Article stage after distribution: ${finalStage}`);
      } else {
        warn("Translation did not complete — skipping distribution check");
      }
    } catch (e) {
      warn(`Georgian auto-post test failed: ${e.message}`);
    }
  }

  // ── B. English Auto-Post (Schedule NOW → Distribution) ────────────────────
  sub("B. English Mode — Score 5 Scheduled Post (Telegram + Facebook)");

  try {
    // 1. Switch to English mode
    await api("PATCH", "/config/translation", { posting_language: "en" });
    ok("Switched to English mode");

    // 2. Enable auto-posting
    await api("PATCH", "/config/auto-post-telegram", { enabled: true });
    await api("PATCH", "/config/auto-post-facebook", { enabled: true });
    ok("Enabled auto_post_telegram + auto_post_facebook");

    // 3. Insert synthetic article (English — no translation needed)
    const enArticleId = await insertSyntheticArticle(pool, "english", {
      title: "[TEST] Score 5 English Auto-Post — Flow Test",
      summary: "This synthetic article tests the English auto-post pipeline: scheduled for immediate dispatch to Telegram and Facebook.",
    });
    ok(`Inserted synthetic article: ${enArticleId.substring(0, 8)}...`);

    // 4. Schedule NOW via API (bypass LLM brain, go directly to maintenance dispatch)
    const schedResult = await api("POST", `/articles/${enArticleId}/schedule`, {
      platforms: ["telegram", "facebook"],
      scheduled_at: new Date().toISOString(),
    });
    ok(`Scheduled: ${schedResult.deliveries.length} delivery(ies)`);
    for (const d of schedResult.deliveries) {
      info(`  ${d.platform}: ${d.status} (ID: ${d.delivery_id})`);
    }

    // 5. Watch for delivery
    info("\nWatching for maintenance worker dispatch (polls every ~30s)...\n");
    const deliveries = await watchDeliveries(pool, enArticleId, 90_000);

    sub("English Auto-Post Results");
    for (const platform of ["telegram", "facebook"]) {
      const result = deliveries[platform];
      if (result) {
        if (result.status === "posted") {
          ok(`${platform}: POSTED (post ID: ${result.platform_post_id || "—"})`);
        } else {
          warn(`${platform}: ${result.status} — ${result.error_message || "no error"}`);
        }
      } else {
        warn(`${platform}: no delivery found`);
      }
    }

    // Check article stage
    const { rows: stageRows } = await pool.query(
      "SELECT pipeline_stage FROM articles WHERE id = $1",
      [enArticleId],
    );
    info(`Article stage after distribution: ${stageRows[0]?.pipeline_stage}`);
  } catch (e) {
    warn(`English auto-post test failed: ${e.message}`);
  }

  // ── C. Restore Config ──────────────────────────────────────────────────────
  sub("C. Restore Config");
  try {
    // Restore Georgian mode if it was enabled
    if (translationEnabled) {
      await api("PATCH", "/config/translation", { posting_language: "ka" });
      ok("Restored posting_language: ka");
    }
    // Disable auto-posting (safe mode)
    await api("PATCH", "/config/auto-post-telegram", { enabled: false });
    await api("PATCH", "/config/auto-post-facebook", { enabled: false });
    ok("Disabled auto_post_telegram + auto_post_facebook (safe mode)");
  } catch (e) {
    warn(`Config restore failed: ${e.message}`);
  }
}

// ─── Phase 6: Final Report ──────────────────────────────────────────────────

async function phase6(pool) {
  divider("PHASE 6 — FINAL REPORT");

  // Pipeline stage counts
  const stages = await qStageCounts(pool);
  sub("Pipeline Stage Counts");
  for (const [stage, count] of Object.entries(stages)) {
    console.log(`  ${pad(stage)}${count}`);
  }
  const total = Object.values(stages).reduce((a, b) => a + b, 0);
  console.log(`  ${"─".repeat(28)}`);
  console.log(`  ${pad("TOTAL")}${total}`);

  // Translation status counts
  const trans = await qTransCounts(pool);
  if (Object.keys(trans).length > 0) {
    sub("Translation Status (scored articles)");
    for (const [status, count] of Object.entries(trans)) {
      console.log(`  ${pad(status)}${count}`);
    }
  }

  // Recent articles table
  const samples = await qRecentArticles(pool, 12);
  if (samples.length > 0) {
    sub("Recent Articles");
    console.log(
      `  ${pad("ID", 10)}${pad("Score", 7)}${pad("Stage", 12)}${pad("Trans", 14)}${pad("KA?", 5)}Title`,
    );
    console.log(`  ${"─".repeat(75)}`);
    for (const a of samples) {
      const id = a.id.substring(0, 8);
      const score = a.score !== null ? String(a.score) : "—";
      const trans = a.trans || "—";
      const ka = a.has_ka ? "YES" : "—";
      console.log(
        `  ${pad(id, 10)}${pad(score, 7)}${pad(a.stage, 12)}${pad(trans, 14)}${pad(ka, 5)}${a.title}`,
      );
    }
  }

  // LLM Telemetry
  const telemetry = await qTelemetry(pool);
  if (telemetry.length > 0) {
    sub("LLM Telemetry");
    console.log(
      `  ${pad("Operation", 14)}${pad("Calls", 8)}${pad("Tokens", 10)}${pad("Cost", 10)}${pad("Avg ms", 8)}`,
    );
    console.log(`  ${"─".repeat(50)}`);
    for (const t of telemetry) {
      const cost = `$${(t.cost_micro / 1_000_000).toFixed(4)}`;
      console.log(
        `  ${pad(t.operation, 14)}${pad(t.calls, 8)}${pad(t.tokens, 10)}${pad(cost, 10)}${pad(t.avg_ms, 8)}`,
      );
    }
  }

  // Anomaly detection
  sub("Health Checks");
  const { rows: zombiesTrans } = await pool.query(`
    SELECT COUNT(*)::int AS n FROM articles
    WHERE translation_status = 'translating'
      AND created_at < NOW() - INTERVAL '10 minutes'
  `);
  if (zombiesTrans[0].n > 0) {
    warn(`${zombiesTrans[0].n} zombie translation(s) stuck in 'translating'`);
  } else {
    ok("No zombie translations");
  }

  const { rows: zombiesEmbed } = await pool.query(`
    SELECT COUNT(*)::int AS n FROM articles
    WHERE pipeline_stage = 'ingested'
      AND created_at < NOW() - INTERVAL '5 minutes'
  `);
  if (zombiesEmbed[0].n > 0) {
    warn(`${zombiesEmbed[0].n} article(s) stuck in 'ingested' (embedding may be stalled)`);
  } else {
    ok("No stalled ingested articles");
  }

  const { rows: zombiesScore } = await pool.query(`
    SELECT COUNT(*)::int AS n FROM articles
    WHERE pipeline_stage = 'embedded'
      AND created_at < NOW() - INTERVAL '5 minutes'
  `);
  if (zombiesScore[0].n > 0) {
    warn(`${zombiesScore[0].n} article(s) stuck in 'embedded' (scoring may be stalled)`);
  } else {
    ok("No stalled embedded articles");
  }

  // Manual UI check hints
  sub("Manual UI Verification");
  console.log("  1. Articles page     — verify stage badges + score colors match above");
  console.log("  2. Translated rows   — green 'KA:' text below English summary");
  console.log("  3. 'Translating...'  — amber badge for in-progress translations");
  console.log("  4. Restrictions tab  — Translation config matches what we set");
  console.log("  5. Drizzle Studio    — npm run db:studio → inspect articles table");
  console.log("  6. Telemetry page    — 'translate' operation appears in LLM costs");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log("  FlowTest — End-to-End Pipeline Test with Translation");
  console.log(`  ${"═".repeat(52)}`);
  console.log(`  Time  : ${new Date().toISOString()}`);
  console.log(`  Mode  : ${TEST_LANG === "ka" ? "Georgian (translation)" : "English (no translation)"}`);
  console.log(`  Reset : ${SKIP_RESET ? "SKIP" : "YES"}`);
  console.log(`  API   : ${API_URL}`);

  if (!DB_URL) {
    fail("DATABASE_URL not set in .env");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: DB_URL });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n\n  [!!] Interrupted — cleaning up...");
    pool.end().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await phase0(pool);
    await sleep(1500);

    await phase1(pool);
    await sleep(1500);

    const translationEnabled = await phase2();
    // Pause to ensure translation_enabled_since is set BEFORE articles are created
    await sleep(2000);

    await phase3();
    // Give the worker a moment to pick up the ingest job
    await sleep(3000);

    await phase4(pool, translationEnabled);

    await phase5(pool, translationEnabled);

    await phase5b(pool, translationEnabled);

    await phase5c(pool, translationEnabled);

    await phase6(pool);

    divider("FLOW TEST COMPLETE");
    console.log("");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`\n  [XX] Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
