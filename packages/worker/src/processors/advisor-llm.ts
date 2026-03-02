/**
 * SmartHub LLM Advisor — Takes stats snapshot, calls LLM for structured recommendations.
 * Pattern copied from digest.ts: direct SDK calls, multi-provider support.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { eq, inArray } from "drizzle-orm";
import { logger } from "@watch-tower/shared";
import { DEFAULT_BASE_URLS, calculateLLMCost } from "@watch-tower/llm";
import type { Database } from "@watch-tower/db";
import { advisorReports, appConfig, llmTelemetry } from "@watch-tower/db";
import type {
  AdvisorStatsSnapshot,
  AdvisorRecommendation,
} from "@watch-tower/shared";
import { collectAdvisorStats } from "./advisor-stats.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type ApiKeys = {
  anthropic?: string;
  openai?: string;
  deepseek?: string;
  googleAi?: string;
};

type LLMResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

type AdvisorConfig = {
  provider: string;
  model: string;
  windowDays: number;
};

// ─── API key resolution (same as digest.ts) ──────────────────────────────────

const resolveApiKey = (provider: string, apiKeys: ApiKeys): string | undefined => {
  switch (provider) {
    case "claude":
      return apiKeys.anthropic;
    case "openai":
      return apiKeys.openai;
    case "deepseek":
      return apiKeys.deepseek;
    case "gemini":
      return apiKeys.googleAi;
    default:
      return undefined;
  }
};

// ─── LLM call (copied from digest.ts, lower temperature for determinism) ────

const callLLM = async (
  config: { provider: string; apiKey: string; model: string },
  systemPrompt: string,
  userPrompt: string,
): Promise<LLMResult | null> => {
  const startTime = Date.now();

  try {
    if (config.provider === "claude") {
      const client = new Anthropic({ apiKey: config.apiKey });
      const response = await client.messages.create({
        model: config.model,
        max_tokens: 8192,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      return {
        text,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        latencyMs: Date.now() - startTime,
      };
    }

    if (config.provider === "gemini") {
      const client = new GoogleGenerativeAI(config.apiKey);
      const genModel = client.getGenerativeModel({
        model: config.model,
        systemInstruction: systemPrompt,
        generationConfig: { maxOutputTokens: 16384, temperature: 0.2 },
      });

      const result = await genModel.generateContent(userPrompt);
      const response = result.response;
      const text = response.text();
      const usage = response.usageMetadata;

      return {
        text,
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
        latencyMs: Date.now() - startTime,
      };
    }

    // OpenAI / DeepSeek
    const client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.provider === "deepseek" ? { baseURL: DEFAULT_BASE_URLS.deepseek } : {}),
    });
    const response = await client.chat.completions.create({
      model: config.model,
      max_tokens: 8192,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    return {
      text,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg, provider: config.provider }, "[advisor] LLM call failed");
    return null;
  }
};

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a pipeline optimization advisor for a news monitoring system.
You analyze statistical patterns from RSS ingestion, LLM scoring, and content
distribution to produce actionable recommendations.

Output valid JSON matching this schema:
{
  "summary": "2-3 sentence overview of pipeline health",
  "recommendations": [
    {
      "id": "rec_<random_8chars>",
      "category": "source|keyword|threshold|prompt|interval|dedup|cost|alert",
      "priority": "high|medium|low",
      "title": "Short headline (under 80 chars)",
      "reason": "Detailed explanation with specific numbers from the stats. Include the exact sector name, source name, keyword, or threshold value so the operator knows exactly where to make the change."
    }
  ]
}

Rules:
- Maximum 15 recommendations per report
- Always include specific numbers (percentages, counts, costs) in reasons
- Only recommend changes where the data clearly supports them
- CRITICAL: Reject keywords are per-sector. Always name the exact sector in the reason.
- Reject keywords match against title, categories, URL, and author only (NOT content body). Safe for category-derived terms.
- "high" priority = immediate action needed (quality collapse, cost waste, broken source)
- "medium" = should address within a week
- "low" = nice to have optimization
- For threshold changes, always state current value and suggested value
- For keyword additions, always state which sector and why
- Never recommend removing a source that has >40% signal ratio
- Never recommend lowering auto_approve_threshold below auto_reject_threshold
- COVERAGE: You MUST cover ALL relevant categories. If the data contains dedup patterns, include a "dedup" recommendation. If costs are notable, include a "cost" recommendation. If sources are inefficient, include "source" and "interval" recommendations. Do not skip categories that have actionable data — the operator relies on consistent category coverage across reports.
- Output ONLY the JSON object, no markdown fences or extra text`;

// ─── User prompt builder ─────────────────────────────────────────────────────

const buildUserPrompt = (stats: AdvisorStatsSnapshot): string => {
  const lines: string[] = [];

  // Pipeline summary
  lines.push(`=== PIPELINE HEALTH (last ${stats.window_days} days) ===`);
  lines.push(
    `Total articles: ${stats.total_articles} | Scored: ${stats.total_scored} | Rejected: ${stats.total_rejected} | Duplicates: ${stats.total_duplicates}`,
  );
  lines.push("");

  // Score distribution
  lines.push("=== SCORE DISTRIBUTION ===");
  const total = Object.values(stats.score_distribution).reduce((s, c) => s + c, 0);
  for (let i = 1; i <= 5; i++) {
    const cnt = stats.score_distribution[String(i)] ?? 0;
    const pct = total > 0 ? ((cnt / total) * 100).toFixed(1) : "0.0";
    lines.push(`Score ${i}: ${cnt} (${pct}%)`);
  }
  const trend = stats.score_trend;
  lines.push(
    `7-day trend: Score 4+ ${trend.high_score_change_pct > 0 ? "up" : "down"} ${Math.abs(trend.high_score_change_pct)}% vs previous week`,
  );
  lines.push("");

  // Source performance — show worst AND best to avoid biased sample
  lines.push("=== SOURCE PERFORMANCE ===");
  const scoredSources = [...stats.sources].filter((s) => s.total_scored > 0);
  const totalSources = stats.sources.length;
  const sourcesWithSignal = scoredSources.filter((s) => s.signal_ratio > 0).length;
  const avgSignal =
    scoredSources.length > 0
      ? (
          scoredSources.reduce((sum, s) => sum + s.signal_ratio, 0) / scoredSources.length
        ).toFixed(1)
      : "0.0";
  lines.push(
    `Overview: ${totalSources} total sources, ${scoredSources.length} with scored articles, ${sourcesWithSignal} with >0% signal ratio, avg signal ${avgSignal}%`,
  );

  const bySignalAsc = [...scoredSources].sort((a, b) => a.signal_ratio - b.signal_ratio);
  const worst = bySignalAsc.slice(0, 10);
  const best = bySignalAsc.slice(-10).reverse();
  // Merge without duplicates (if <20 scored sources, sets overlap)
  const shown = new Set<string>();
  const formatSource = (src: (typeof scoredSources)[0]) => {
    const trendStr =
      src.signal_ratio_previous > 0
        ? ` (was ${src.signal_ratio_previous}% 2w ago)`
        : "";
    const sectorStr = src.sector_name ? ` [${src.sector_name}]` : "";
    return `${src.source_name}${sectorStr}: signal ${src.signal_ratio}%${trendStr}, ${src.total_scored} scored, avg ${src.avg_score}, dedup ${src.dedup_rate}%, interval ${src.ingest_interval_minutes}min, active=${src.active}`;
  };

  lines.push("-- Worst performing:");
  for (const src of worst) {
    shown.add(src.source_id);
    lines.push(`  ${formatSource(src)}`);
  }
  lines.push("-- Best performing:");
  for (const src of best) {
    if (shown.has(src.source_id)) continue;
    lines.push(`  ${formatSource(src)}`);
  }
  lines.push("");

  // Pre-filter keywords
  if (stats.rejection_breakdown.keyword_hits.length > 0) {
    lines.push("=== PRE-FILTER KEYWORDS ===");
    for (const hit of stats.rejection_breakdown.keyword_hits.slice(0, 15)) {
      lines.push(`"${hit.keyword}" in ${hit.field}: ${hit.count} hits`);
    }
    lines.push("");
  }

  // Rejection breakdown
  lines.push("=== REJECTION BREAKDOWN ===");
  const rej = stats.rejection_breakdown;
  lines.push(
    `Total: ${rej.total_rejected} | Pre-filter: ${rej.pre_filter_count} | LLM: ${rej.llm_reject_count} | Manual: ${rej.manual_reject_count}`,
  );
  lines.push("");

  // Operator overrides
  if (stats.operator_overrides.total_overrides > 0) {
    lines.push("=== OPERATOR OVERRIDES ===");
    lines.push(
      `${stats.operator_overrides.total_overrides} articles manually approved below auto-approve threshold`,
    );
    for (const s of stats.operator_overrides.by_sector) {
      lines.push(`  ${s.sector_name}: ${s.count} overrides`);
    }
    lines.push("");
  }

  // Category patterns
  if (stats.category_correlations.length > 0) {
    lines.push("=== CATEGORY PATTERNS (with sector) ===");
    for (const cat of stats.category_correlations.slice(0, 15)) {
      const sectorStr = cat.sector_name ? ` [sector: ${cat.sector_name}]` : "";
      lines.push(
        `"${cat.category}"${sectorStr}: ${cat.total} articles, avg ${cat.avg_score}, ${cat.high_score_pct}% score 4+, ${cat.low_score_pct}% score 1-2`,
      );
    }
    lines.push("");
  }

  // Fetch efficiency
  const inefficient = stats.fetch_efficiency.filter((f) => f.empty_fetch_rate > 50);
  if (inefficient.length > 0) {
    lines.push("=== INEFFICIENT FETCHES ===");
    for (const f of inefficient.slice(0, 10)) {
      lines.push(
        `${f.source_name}: ${f.empty_fetch_rate}% empty fetches, ${f.total_fetches} total`,
      );
    }
    lines.push("");
  }

  // Cost summary
  lines.push("=== COST SUMMARY ===");
  const costUsd = (stats.cost_summary.total_cost_microdollars / 1_000_000).toFixed(2);
  lines.push(`Total: $${costUsd}`);
  for (const entry of stats.cost_summary.cost_by_sector) {
    const c = (entry.cost / 1_000_000).toFixed(3);
    lines.push(
      `  ${entry.sector_name}: $${c} (${entry.useful_articles} useful articles)`,
    );
  }
  lines.push("");

  // Stale keywords
  const staleKeywords = stats.keyword_effectiveness.filter((k) => k.match_count === 0);
  if (staleKeywords.length > 0) {
    lines.push("=== STALE KEYWORDS (0 matches in window) ===");
    for (const k of staleKeywords.slice(0, 15)) {
      lines.push(`  ${k.sector_name} [${k.type}]: "${k.keyword}"`);
    }
    lines.push("");
  }

  // Dedup chains
  if (stats.dedup_patterns.chains.length > 0) {
    lines.push("=== DEDUP CHAINS ===");
    lines.push(`Total duplicates: ${stats.dedup_patterns.total_duplicates}`);
    for (const chain of stats.dedup_patterns.chains.slice(0, 10)) {
      lines.push(
        `  ${chain.follower_source} duplicates ${chain.original_source}: ${chain.count}x (avg similarity ${chain.avg_similarity})`,
      );
    }
    lines.push("");
  }

  // Platform delivery
  if (stats.platform_delivery.by_platform.length > 0) {
    lines.push("=== PLATFORM DELIVERY ===");
    for (const p of stats.platform_delivery.by_platform) {
      const failRate =
        p.total > 0 ? ((p.failed / p.total) * 100).toFixed(1) : "0.0";
      lines.push(`${p.platform}: ${p.success} ok, ${p.failed} failed (${failRate}% fail rate)`);
    }
    lines.push("");
  }

  // Alert effectiveness
  if (stats.alert_effectiveness.length > 0) {
    lines.push("=== ALERT RULES ===");
    for (const a of stats.alert_effectiveness) {
      lines.push(
        `"${a.rule_name}" [${a.keywords.join(", ")}]: ${a.fires} fires, ${a.unique_keywords_matched} unique keywords matched`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
};

// ─── JSON extraction (same pattern as llm/schemas.ts) ────────────────────────

const extractJSON = (text: string): unknown | null => {
  // Strip markdown code fences
  const cleaned = text.replace(/```(?:json)?\s*\n?/g, "").replace(/```\s*$/g, "");

  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch {
    // noop
  }

  // Find JSON object in text
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // noop
    }
  }

  return null;
};

// ─── Validate recommendations ────────────────────────────────────────────────

const validateRecommendations = (
  raw: unknown,
): { summary: string; recommendations: AdvisorRecommendation[] } | null => {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const summary = typeof obj.summary === "string" ? obj.summary : "No summary provided.";
  const recs = Array.isArray(obj.recommendations) ? obj.recommendations : [];

  const validCategories = new Set([
    "source", "keyword", "threshold", "prompt",
    "interval", "dedup", "cost", "alert",
  ]);
  const validPriorities = new Set(["high", "medium", "low"]);

  const validated: AdvisorRecommendation[] = [];
  for (const rec of recs.slice(0, 15)) {
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;

    // Require minimum fields
    if (typeof r.title !== "string" || typeof r.reason !== "string") continue;

    const category = validCategories.has(r.category as string)
      ? (r.category as AdvisorRecommendation["category"])
      : "source";
    const priority = validPriorities.has(r.priority as string)
      ? (r.priority as AdvisorRecommendation["priority"])
      : "medium";

    validated.push({
      id: typeof r.id === "string" ? r.id : `rec_${Math.random().toString(36).slice(2, 10)}`,
      category,
      priority,
      title: (r.title as string).slice(0, 80),
      reason: (r.reason as string).slice(0, 1000),
      action: null,
      applied_at: null,
    });
  }

  return { summary, recommendations: validated };
};

// ─── Deterministic fallback recommendations (code-generated) ─────────────────

const recId = () => `rec_${Math.random().toString(36).slice(2, 10)}`;

const generateFallbackRecs = (stats: AdvisorStatsSnapshot): AdvisorRecommendation[] => {
  const recs: AdvisorRecommendation[] = [];

  // SOURCE: Active sources with 0% signal and enough data
  const zeroSignalSources = stats.sources.filter(
    (s) => s.active && s.signal_ratio === 0 && s.total_scored > 5,
  );
  if (zeroSignalSources.length > 0) {
    const names = zeroSignalSources.slice(0, 5).map((s) => s.source_name).join(", ");
    const more = zeroSignalSources.length > 5 ? ` (+${zeroSignalSources.length - 5} more)` : "";
    recs.push({
      id: recId(), category: "source", priority: "high",
      title: `Deactivate ${zeroSignalSources.length} sources with 0% signal ratio`,
      reason: `${names}${more} have 0% signal ratio (no articles scoring 4+) with ${zeroSignalSources.reduce((s, x) => s + x.total_scored, 0)} total scored articles. Deactivating saves LLM scoring costs.`,
      action: null, applied_at: null,
    });
  }

  // INTERVAL: Sources with >60% empty fetches
  const inefficient = stats.fetch_efficiency.filter((f) => f.empty_fetch_rate > 60);
  if (inefficient.length > 0) {
    const names = inefficient.slice(0, 5).map((f) => `${f.source_name} (${f.empty_fetch_rate}%)`).join(", ");
    recs.push({
      id: recId(), category: "interval", priority: "medium",
      title: `Increase fetch intervals for ${inefficient.length} inefficient sources`,
      reason: `${names} have >60% empty fetch rate. Most fetches return 0 new articles, wasting resources.`,
      action: null, applied_at: null,
    });
  }

  // KEYWORD: Categories with >70% low scores
  const badCategories = stats.category_correlations.filter(
    (c) => c.low_score_pct > 70 && c.total > 5,
  );
  if (badCategories.length > 0) {
    const names = badCategories.slice(0, 4).map(
      (c) => `"${c.category}"${c.sector_name ? ` [${c.sector_name}]` : ""} (${c.low_score_pct}% low-score)`,
    ).join(", ");
    recs.push({
      id: recId(), category: "keyword", priority: "high",
      title: `Add reject keywords for ${badCategories.length} low-quality categories`,
      reason: `${names} consistently produce low-scoring articles. Adding as reject keywords saves LLM costs.`,
      action: null, applied_at: null,
    });
  }

  // KEYWORD: Stale keywords with 0 matches
  const stale = stats.keyword_effectiveness.filter((k) => k.match_count === 0);
  if (stale.length > 0) {
    const names = stale.slice(0, 5).map((k) => `"${k.keyword}" [${k.sector_name}, ${k.type}]`).join(", ");
    recs.push({
      id: recId(), category: "keyword", priority: "low",
      title: `Review ${stale.length} stale keywords with 0 matches`,
      reason: `${names} had no matches in the analysis window. Consider removing or updating them.`,
      action: null, applied_at: null,
    });
  }

  // THRESHOLD: Operator overrides suggest threshold too strict
  if (stats.operator_overrides.total_overrides > 5) {
    const topSectors = stats.operator_overrides.by_sector.slice(0, 3)
      .map((s) => `${s.sector_name} (${s.count})`).join(", ");
    recs.push({
      id: recId(), category: "threshold", priority: "medium",
      title: `Review auto-approve threshold (${stats.operator_overrides.total_overrides} manual overrides)`,
      reason: `Operator manually approved ${stats.operator_overrides.total_overrides} articles below the auto-approve threshold. Top sectors: ${topSectors}. Consider lowering the threshold.`,
      action: null, applied_at: null,
    });
  }

  // DEDUP: High internal duplication chains
  const internalChains = stats.dedup_patterns.chains.filter(
    (c) => c.follower_source === c.original_source && c.count > 30,
  );
  const dedupPct = stats.total_articles > 0
    ? Math.round((stats.total_duplicates / stats.total_articles) * 1000) / 10
    : 0;
  if (internalChains.length > 0 || dedupPct > 25) {
    const chainStr = internalChains.slice(0, 3)
      .map((c) => `${c.follower_source} (${c.count}x self-dupes)`).join(", ");
    recs.push({
      id: recId(), category: "dedup", priority: dedupPct > 40 ? "high" : "medium",
      title: `Address ${dedupPct}% article duplication rate`,
      reason: `${stats.total_duplicates} of ${stats.total_articles} articles are duplicates (${dedupPct}%).${chainStr ? ` Top internal chains: ${chainStr}.` : ""} Consider raising similarity threshold or reducing overlapping feed subscriptions.`,
      action: null, applied_at: null,
    });
  }

  // COST: Sectors with high cost per useful article
  const highCostSectors = stats.cost_summary.cost_by_sector.filter(
    (s) => s.useful_articles < 5 && s.useful_articles > 0 && s.cost > 20000,
  );
  if (highCostSectors.length > 0) {
    const names = highCostSectors.slice(0, 3).map(
      (s) => `${s.sector_name} ($${(s.cost / 1_000_000).toFixed(3)} for ${s.useful_articles} useful)`,
    ).join(", ");
    recs.push({
      id: recId(), category: "cost", priority: "medium",
      title: `Reduce cost inefficiency in ${highCostSectors.length} sectors`,
      reason: `${names} have high LLM cost relative to useful output. Consider refining scoring prompts or reducing source volume.`,
      action: null, applied_at: null,
    });
  }

  // PROMPT: Sectors with <10% signal and enough data
  const lowSignalSectors = stats.sectors.filter(
    (s) => s.signal_ratio < 10 && s.total_scored > 20,
  );
  if (lowSignalSectors.length > 0) {
    const names = lowSignalSectors.slice(0, 3).map(
      (s) => `${s.sector_name} (${s.signal_ratio}% signal, ${s.total_scored} scored)`,
    ).join(", ");
    recs.push({
      id: recId(), category: "prompt", priority: "low",
      title: `Review LLM prompts for ${lowSignalSectors.length} low-signal sectors`,
      reason: `${names} have <10% signal ratio despite sufficient data. The scoring prompt may need sector-specific tuning.`,
      action: null, applied_at: null,
    });
  }

  // ALERT: Rules with 0 fires
  const silentAlerts = stats.alert_effectiveness.filter((a) => a.fires === 0);
  if (silentAlerts.length > 0) {
    const names = silentAlerts.slice(0, 3).map((a) => `"${a.rule_name}"`).join(", ");
    recs.push({
      id: recId(), category: "alert", priority: "low",
      title: `${silentAlerts.length} alert rules with 0 fires`,
      reason: `${names} produced no alerts in the analysis window. Review keywords or consider disabling.`,
      action: null, applied_at: null,
    });
  }

  return recs;
};

/** Inject missing categories into LLM recommendations */
const gapFillRecs = (
  llmRecs: AdvisorRecommendation[],
  stats: AdvisorStatsSnapshot,
): AdvisorRecommendation[] => {
  const coveredCategories = new Set(llmRecs.map((r) => r.category));
  const fallbacks = generateFallbackRecs(stats);
  const gaps = fallbacks.filter((r) => !coveredCategories.has(r.category));

  if (gaps.length === 0) return llmRecs;

  const merged = [...llmRecs, ...gaps];
  logger.info(
    { gapsFilled: gaps.map((r) => r.category) },
    "[advisor] gap-filled missing categories",
  );
  // Cap at 15
  return merged.slice(0, 15);
};

/** Auto-generate summary when LLM is unavailable */
const generateFallbackSummary = (stats: AdvisorStatsSnapshot): string => {
  const signalPct = stats.total_scored > 0
    ? Math.round(
        (Object.entries(stats.score_distribution)
          .filter(([s]) => Number(s) >= 4)
          .reduce((sum, [, c]) => sum + c, 0) /
          stats.total_scored) * 1000,
      ) / 10
    : 0;
  const zeroSignalCount = stats.sources.filter(
    (s) => s.active && s.signal_ratio === 0 && s.total_scored > 5,
  ).length;
  const dedupPct = stats.total_articles > 0
    ? Math.round((stats.total_duplicates / stats.total_articles) * 1000) / 10
    : 0;
  return `Pipeline processed ${stats.total_articles} articles with ${signalPct}% scoring 4+ over ${stats.window_days} day(s). ${zeroSignalCount} sources have 0% signal ratio. Duplication rate: ${dedupPct}%. This report was generated from statistical rules without LLM analysis.`;
};

// ─── Read advisor config from app_config ─────────────────────────────────────

const readAdvisorConfig = async (db: Database): Promise<AdvisorConfig> => {
  const keys = [
    "advisor_provider",
    "advisor_model",
    "advisor_window_days",
  ];
  const configRows = await db
    .select({ key: appConfig.key, value: appConfig.value })
    .from(appConfig)
    .where(inArray(appConfig.key, keys));

  const configMap = new Map<string, unknown>();
  for (const row of configRows) {
    configMap.set(row.key, row.value);
  }

  return {
    provider: (configMap.get("advisor_provider") as string) ?? "openai",
    model: (configMap.get("advisor_model") as string) ?? "gpt-4o",
    windowDays: Math.min(
      60,
      Math.max(1, Number(configMap.get("advisor_window_days")) || 30),
    ),
  };
};

// ─── Main: Run advisor analysis ──────────────────────────────────────────────

export const runAdvisorAnalysis = async (
  db: Database,
  apiKeys: ApiKeys,
  triggeredBy: "scheduled" | "manual" = "scheduled",
): Promise<string> => {
  // 1. Create report row with status=collecting
  const [report] = await db
    .insert(advisorReports)
    .values({ status: "collecting", triggeredBy })
    .returning({ id: advisorReports.id });

  const reportId = report.id;

  try {
    // 2. Read config
    const config = await readAdvisorConfig(db);
    logger.info(
      { reportId, provider: config.provider, model: config.model, windowDays: config.windowDays },
      "[advisor] starting analysis",
    );

    // 3. Collect stats
    const stats = await collectAdvisorStats(db, config.windowDays);

    // Update status
    await db
      .update(advisorReports)
      .set({ status: "analyzing", statsSnapshot: stats })
      .where(eq(advisorReports.id, reportId));

    // 4. Resolve API key
    const apiKey = resolveApiKey(config.provider, apiKeys);
    if (!apiKey) {
      // Try fallback providers
      const fallbackOrder = ["openai", "claude", "gemini", "deepseek"];
      let fallbackKey: string | undefined;
      let fallbackProvider = config.provider;
      for (const fb of fallbackOrder) {
        if (fb === config.provider) continue;
        fallbackKey = resolveApiKey(fb, apiKeys);
        if (fallbackKey) {
          fallbackProvider = fb;
          break;
        }
      }

      if (!fallbackKey) {
        // No LLM available — generate code-only report
        const fallbackRecs = generateFallbackRecs(stats);
        const fallbackSummary = generateFallbackSummary(stats);
        await db
          .update(advisorReports)
          .set({
            status: "ready",
            recommendations: fallbackRecs,
            summary: fallbackSummary,
            recommendationCount: fallbackRecs.length,
            errorMessage: `No API key for ${config.provider} or fallback — code-generated report`,
          })
          .where(eq(advisorReports.id, reportId));
        logger.warn({ reportId, recs: fallbackRecs.length }, "[advisor] no API key — code-only report");
        return reportId;
      }

      logger.info(
        { reportId, original: config.provider, fallback: fallbackProvider },
        "[advisor] using fallback provider",
      );
      config.provider = fallbackProvider;
      // Use a reasonable default model for the fallback
      const fallbackModels: Record<string, string> = {
        openai: "gpt-4o",
        claude: "claude-sonnet-4-20250514",
        gemini: "gemini-2.5-flash",
        deepseek: "deepseek-chat",
      };
      config.model = fallbackModels[fallbackProvider] ?? config.model;
    }

    const finalApiKey = resolveApiKey(config.provider, apiKeys)!;

    // 5. Build prompts
    const userPrompt = buildUserPrompt(stats);

    // 6. Call LLM (with 90s timeout to prevent blocking maintenance worker)
    const LLM_TIMEOUT_MS = 90_000;
    const llmPromise = callLLM(
      { provider: config.provider, apiKey: finalApiKey, model: config.model },
      SYSTEM_PROMPT,
      userPrompt,
    );
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), LLM_TIMEOUT_MS),
    );
    const llmResult = await Promise.race([llmPromise, timeoutPromise]);

    if (!llmResult) {
      // LLM failed — fall back to code-generated report
      const fallbackRecs = generateFallbackRecs(stats);
      const fallbackSummary = generateFallbackSummary(stats);
      await db
        .update(advisorReports)
        .set({
          status: "ready",
          recommendations: fallbackRecs,
          summary: fallbackSummary,
          recommendationCount: fallbackRecs.length,
          llmProvider: config.provider,
          llmModel: config.model,
          errorMessage: `LLM failed (timeout or API error) — code-generated report`,
        })
        .where(eq(advisorReports.id, reportId));
      logger.warn({ reportId, recs: fallbackRecs.length }, "[advisor] LLM failed — code-only report");
      return reportId;
    }

    // 7. Parse JSON response (with one retry on failure)
    let parsed = extractJSON(llmResult.text);
    let validated = validateRecommendations(parsed);

    if (!validated) {
      logger.warn({ reportId }, "[advisor] JSON parse failed, retrying with fix prompt");
      const retryResult = await callLLM(
        { provider: config.provider, apiKey: finalApiKey, model: config.model },
        SYSTEM_PROMPT,
        `Your previous response was not valid JSON. Here is what you returned:\n\n${llmResult.text.slice(0, 1000)}\n\nPlease output ONLY a valid JSON object matching the schema. No markdown fences, no extra text.`,
      );

      if (retryResult) {
        llmResult.inputTokens += retryResult.inputTokens;
        llmResult.outputTokens += retryResult.outputTokens;
        llmResult.latencyMs += retryResult.latencyMs;
        parsed = extractJSON(retryResult.text);
        validated = validateRecommendations(parsed);
      }
    }

    if (!validated) {
      // JSON parse failed after retry — fall back to code-generated report
      const fallbackRecs = generateFallbackRecs(stats);
      const fallbackSummary = generateFallbackSummary(stats);
      await db
        .update(advisorReports)
        .set({
          status: "ready",
          recommendations: fallbackRecs,
          summary: fallbackSummary,
          recommendationCount: fallbackRecs.length,
          llmProvider: config.provider,
          llmModel: config.model,
          llmTokensIn: llmResult.inputTokens,
          llmTokensOut: llmResult.outputTokens,
          llmLatencyMs: llmResult.latencyMs,
          errorMessage: `LLM returned invalid JSON — code-generated report. Raw: ${llmResult.text.slice(0, 200)}`,
        })
        .where(eq(advisorReports.id, reportId));
      logger.warn({ reportId, recs: fallbackRecs.length }, "[advisor] invalid JSON — code-only report");
      return reportId;
    }

    // 8. Gap-fill missing categories with code-generated fallbacks
    const finalRecs = gapFillRecs(validated.recommendations, stats);

    // 9. Calculate cost and save
    const cost = calculateLLMCost(
      config.provider,
      config.model,
      llmResult.inputTokens,
      llmResult.outputTokens,
    );

    await db
      .update(advisorReports)
      .set({
        status: "ready",
        recommendations: finalRecs,
        summary: validated.summary,
        recommendationCount: finalRecs.length,
        llmProvider: config.provider,
        llmModel: config.model,
        llmTokensIn: llmResult.inputTokens,
        llmTokensOut: llmResult.outputTokens,
        llmCostMicrodollars: cost,
        llmLatencyMs: llmResult.latencyMs,
      })
      .where(eq(advisorReports.id, reportId));

    // 10. Record telemetry
    await db.insert(llmTelemetry).values({
      articleId: null,
      operation: "pipeline_advisor",
      provider: config.provider,
      model: config.model,
      isFallback: false,
      inputTokens: llmResult.inputTokens,
      outputTokens: llmResult.outputTokens,
      totalTokens: llmResult.inputTokens + llmResult.outputTokens,
      costMicrodollars: cost,
      latencyMs: llmResult.latencyMs,
      status: "success",
    });

    const gapCount = finalRecs.length - validated.recommendations.length;
    logger.info(
      {
        reportId,
        recommendations: finalRecs.length,
        llmRecs: validated.recommendations.length,
        gapFilled: gapCount,
        high: finalRecs.filter((r) => r.priority === "high").length,
        cost: `$${(cost / 1_000_000).toFixed(4)}`,
        latencyMs: llmResult.latencyMs,
      },
      "[advisor] analysis complete",
    );

    return reportId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ reportId, error: msg }, "[advisor] analysis failed");

    await db
      .update(advisorReports)
      .set({ status: "failed", errorMessage: msg.slice(0, 1000) })
      .where(eq(advisorReports.id, reportId));

    return reportId;
  }
};
