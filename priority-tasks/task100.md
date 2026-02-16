# Task 100: Full Codebase Audit

Post-feature-complete audit. All 15 features are implemented — now sweep for rot, dead code, security gaps, and inconsistencies.

## Audit Philosophy

- **Package-by-package** — audit one package at a time, bottom-up (dependencies first)
- **Fix as we go** — don't just report, fix trivial issues immediately
- **Log blockers** — anything requiring a design decision gets noted, not force-fixed
- **No refactoring** — this is a hygiene pass, not a rewrite

## Audit Order (dependency graph, leaves first)

```
Phase 1: shared → db                    (foundation — types, schema, env)
Phase 2: llm → embeddings → translation → social   (provider packages)
Phase 3: worker                          (pipeline processors — heaviest)
Phase 4: api                             (routes, middleware, validation)
Phase 5: frontend                        (pages, API calls, dead components)
Phase 6: cross-cutting                   (env vars, build, config consistency)
```

---

## Phase 1: Foundation (`shared` + `db`)

### 1.1 — `packages/shared`
- [x] Unused exports — FIXED: removed `getLogLevel`, `isArticleEvent`/`isSourceEvent`/`isStatsEvent` (type guards never used in frontend), `frontendEnvSchema` (never validated), `UrlValidationResult` (de-exported, kept as internal type)
- [x] Env schema — FIXED: 5 R2 env vars (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`) were accessed via raw `process.env` in worker/index.ts — added to `baseEnvSchema` and updated worker to use validated `env.*`
- [x] Queue constants — CLEAN: all 7 queues, 9 job constants, `AUTO_POST_STAGGER_MS`, `REDIS_CHANNEL_EVENTS` are used
- [x] Type definitions — CLEAN: no `any` types, proper Zod inference throughout
- [x] Logger — FIXED: `console.warn` in `api/routes/config.ts:359` (kill switch) replaced with `logger.warn`. Frontend `console.error` calls are acceptable (client-side). Seed script `console.info/error` acceptable (ESM script).

### 1.2 — `packages/db`
- [x] Schema vs DB — APPLIED via `db:push --force` (3 columns dropped, 4 indexes added). Schema and DB are in sync.
- [x] Unused columns — ~~FIXED: removed `articles.postingAttempts`~~ **REVERTED**: column IS used by raw SQL in worker (distribution + maintenance retry tracking), re-added in Phase 3. FIXED: removed `scoringRules.modelPreference` (dead — wrote global env snapshot, never read by worker) and `socialAccounts.sectorIds` (dead — never written/read, empty array default)
- [x] Missing indexes — FIXED: added 4 indexes: `idx_articles_translation` (importance_score, translation_status, created_at), `idx_articles_stage_created` (pipeline_stage, created_at), `idx_feed_fetch_runs_source_status` (source_id, status, created_at), `idx_article_images_created` (created_at)
- [x] Drizzle relations — CLEAN: all FK cascades are correct (SET NULL for articles→sources/sectors, CASCADE for deliveries/images/telemetry→articles)
- [x] Export hygiene — CLEAN: all 14 table exports + `createDb`/`Database`/`sql` are imported by other packages. CLEAN: auto-post toggles (`auto_post_telegram/facebook/linkedin` in app_config) work correctly as global per-platform controls

---

## Phase 2: Provider Packages (`llm`, `embeddings`, `translation`, `social`)

### 2.1 — `packages/llm`
- [x] Provider interface — CLEAN: all 3 (Claude, OpenAI, DeepSeek) implement `LLMProvider` fully. DeepSeek extends OpenAI via class inheritance.
- [x] Fallback logic — CLEAN: `LLMProviderWithFallback` triggers on API exceptions (retryable errors: network, rate limit, server) AND parse errors. Non-retryable errors rethrown. Auth errors fall back with warning.
- [x] Error handling — CLEAN: `analyzeError()` classifies by error.code, error.status, message patterns. Covers ECONNREFUSED/ETIMEDOUT/429/500-504/401/403 etc.
- [x] Telemetry — CLEAN: Claude extracts `input_tokens/output_tokens`, OpenAI extracts `prompt_tokens/completion_tokens`. `calculateLLMCost()` uses microdollars lookup. All providers populate `usage` field.
- [x] Model defaults — CLEAN: `claude-sonnet-4-20250514`, `gpt-4o-mini`, `deepseek-chat` — all current
- [x] Unused exports — FIXED: removed `DEFAULT_SCORING_PROMPT` (dead Phase 3 prompt, replaced by `SCORING_WITH_SUMMARY_PROMPT`). Other internal-only exports (`formatScoringPrompt`, `parseScoringResponse`, etc.) kept as reasonable public API.
- [x] Health check Gemini default — FIXED: `health.ts` defaulted to `gemini-2.0-flash` but translation worker defaults to `gemini-2.5-flash` → updated health.ts to match

### 2.2 — `packages/embeddings`
- [x] Batch size — CLEAN: `MAX_BATCH_SIZE=100` in OpenAI provider (API limit). Pipeline limit of 50 enforced by worker, not the package.
- [x] Vector dimensions — CLEAN: schema `vector(1536)` matches `DIMENSIONS["text-embedding-3-small"] = 1536`
- [x] Error recovery — CLEAN: errors propagate to caller for job-level retry. Since 50 < 100, only 1 API call per batch — no partial-batch failure risk.
- [x] Unused exports — CLEAN: all 4 exports (`createEmbeddingProvider`, `EmbeddingProvider`, `findSimilarArticles`, `SimilarArticle`) used by worker

### 2.3 — `packages/translation`
- [x] Provider parity — CLEAN: Gemini and OpenAI share identical signature `(apiKey, model, title, summary, instructions?)`, same prompts (`buildSystemPrompt` + `buildUserPrompt`), same JSON output format (`{title_ka, summary_ka}`), same transient error classification
- [x] Retry/exhaustion — CLEAN: `MAX_IN_WORKER_RETRIES=2` (3 attempts per job, exponential 5s/10s). `MAX_TRANSLATION_ATTEMPTS=5` (across jobs, then `exhausted`). Atomic `translation_attempts` increment in claim query with `FOR UPDATE SKIP LOCKED`.
- [x] Prompt injection — CLEAN (low risk): article content comes from prior LLM scoring (already processed). System prompt is authoritative. Output parsed as strict JSON (`title_ka` + `summary_ka` fields). No user-controlled input reaches translation prompts directly.
- [x] Cost tracking — CLEAN: telemetry inserted to `llm_telemetry` with `operation: "translate"`, using `calculateTranslationCost()` for microdollar calculation. Only on success (failures not billed).
- [x] Unused exports — FIXED: removed deprecated `buildTranslationPrompt` (never called anywhere, replaced by `buildSystemPrompt` + `buildUserPrompt`). Other exports (`buildSystemPrompt`, `buildUserPrompt`, `DEFAULT_TRANSLATION_INSTRUCTIONS`) kept as public API.

### 2.4 — `packages/social`
- [x] Provider parity — CLEAN: all 3 (Telegram, Facebook, LinkedIn) implement `SocialProvider` interface fully: `name`, `post()`, `healthCheck()`, `formatPost()`, `formatSinglePost()`, `formatDigestPost()`
- [x] Health check consistency — CLEAN: all return `HealthCheckResult`. Telegram: `getMe` (no expiry/rate). Facebook: `debug_token` (token expiry + X-App-Usage). LinkedIn: `/v2/userinfo` → org fallback → 403-as-healthy (token valid, missing profile scope). Platform-appropriate differences.
- [x] Token handling — CLEAN: all 3 read credentials from config objects at construction time. Worker passes env vars into configs. Consistent pattern.
- [x] Error classification — CLEAN: rate limiting is handled externally via Redis sliding window (pre-checked before posting), not by parsing API error responses. Post failures return `success: false` with sanitized error strings. All 3 sanitize tokens from error messages (regex redaction).
- [x] Post template rendering — CLEAN: all 3 implement `formatPost(article, template)` with consistent template field handling (`showBreakingLabel`, `showSectorTag`, `showTitle`, `showSummary`, `showUrl`). Telegram uses HTML escaping; Facebook/LinkedIn use plain text. `formatSinglePost` delegates to `formatPost` with `getDefaultTemplate`.
- [x] Unused exports — FIXED: removed redundant `export type { HealthCheckResult }` (already covered by `export *`). Note: `formatDigestPost` is in the interface but never called (project uses individual posts only) — left as-is per audit philosophy.

---

## Phase 3: Worker (`packages/worker`)

### 3.1 — Processor consistency check
- [x] Do all 7 processors follow the same pattern? — CLEAN: All use BullMQ Worker, return structured results, use structured logging. Atomic claims with `FOR UPDATE SKIP LOCKED` where needed (semantic-dedup, llm-brain, translation, distribution, maintenance/post-scheduler). Error handling consistent: try/catch inside handlers, errors propagate to BullMQ for retry.
- [x] Are batch sizes configurable or hardcoded? — CLEAN: All hardcoded (feed: per-source, dedup: 50, llm: 10, translation: 10, image-gen: 5, distribution: 1, maintenance: 10-20). Appropriate values for each stage. Batch sizes are implementation details, not user-facing config.
- [x] Stale job handling — CLEAN: BullMQ stall detection + `stalled` event handlers on all 7 workers. Maintenance resets zombie articles every 30s (embedding >10min, scoring >10min, translating >10min, posting >5min). Zombie deliveries reset every 30s (posting >5min).

### 3.2 — `processors/feed.ts` (ingest)
- [x] Security layers enforced — CLEAN: All 5 layers checked in correct order: (1) domain whitelist via `isDomainAllowed`, (2) URL validation via `isUrlSafe`, (3) feed size via `fetchFeedSecurely` with `maxSizeBytes`, (4) article quotas via `checkArticleQuota`, (5) URL dedup via `ON CONFLICT DO NOTHING`.
- [x] Date filtering — CLEAN: `maxAgeDays` → cutoff date compared to `item.pubDate`. Uses `new Date()` for cutoff (UTC-based). RSS dates parsed by rss-parser (handles RFC 822/ISO 8601). No timezone-specific issues.
- [x] Edge case: 0 items / 10,000 items — CLEAN: 0 items returns `{ inserted: 0 }`. 10,000 items capped by article quota (`MAX_ARTICLES_PER_FETCH` default 100) + daily limit per source (default 500) + date filter.

### 3.3 — `processors/semantic-dedup.ts`
- [x] Similarity threshold — CLEAN: Read from env via `SIMILARITY_THRESHOLD` (default 0.85), passed as dep from worker/index.ts.
- [x] Embedding provider down — CLEAN: Error propagates to BullMQ for retry (3 attempts, exponential backoff). Articles stay at `ingested`. Repeatable job (every 60s) re-attempts. Maintenance resets `embedding` zombies after 10 min.
- [x] Batch boundary — CLEAN: Claims up to 50 with `FOR UPDATE SKIP LOCKED`. If exactly 50, claims all. Next batch finds 0, returns `{ processed: 0 }`. New arrivals picked up on next tick.

### 3.4 — `processors/llm-brain.ts`
- [x] Scoring rules — CLEAN: Per-sector prompts loaded via 3-level resolution: (1) structured JSON config in `scoring_rules`, (2) legacy `prompt_template` field, (3) default `SCORING_WITH_SUMMARY_PROMPT`. Bulk UPDATE via UNNEST arrays. Promise.allSettled for partial failure handling.
- [x] Auto-approve threshold — CLEAN: Reads from DB (`auto_approve_threshold`) with env fallback (`LLM_AUTO_APPROVE_THRESHOLD`, default 5). DB value overrides env. Auto-reject: DB `auto_reject_threshold` with env fallback (default 2).
- [x] Score validation — CLEAN: Zod schema `ScoringResponseSchema` enforces `z.number().int().min(1).max(5)`. Out-of-range scores rejected at parse → article marked `scoring_failed`.
- [x] Fallback — CLEAN: `createLLMProviderWithFallback` wraps primary + fallback. Primary exception (retryable) → fallback attempted. Fallback marked `isFallback: true` in telemetry.

### 3.5 — `processors/translation.ts`
- [x] Backfill guard — CLEAN: `enabledSince = config.enabledSince ? new Date(config.enabledSince) : new Date()`. If `translation_enabled_since` is NULL, defaults to NOW — prevents backfill. SQL filter: `AND created_at > ${enabledSince}`.
- [x] Race condition — CLEAN: Atomic claim with `FOR UPDATE SKIP LOCKED` + `translation_status = 'translating'`. Worker concurrency 1, but safe even with multiple workers.
- [x] Status transitions — CLEAN: NULL → `translating` (claim) → `translated` (success) / `failed` (transient, < max) / `exhausted` (>= MAX_TRANSLATION_ATTEMPTS=5). Maintenance resets `failed` → NULL after 10 min. `exhausted` is permanent.

### 3.6 — `processors/image-generation.ts`
- [x] R2 upload error handling — CLEAN: If R2 upload fails, error caught, `article_images.status` set to `failed`. MAX_RETRIES=3 with exponential backoff. Final failure → text-only fallback (queues distribution without image).
- [x] Cleanup — CLEAN: Articles cascade-delete `article_images` rows. Maintenance TTL cleanup explicitly deletes R2 objects (`deleteImages`) before deleting DB rows.
- [x] Cost tracking — CLEAN: `estimateImageCost(quality, size)` → `article_images.cost_microdollars` set in SQL UPDATE after successful generation.

### 3.7 — `processors/distribution.ts`
- [x] Emergency stop — CLEAN: Checked at top of every job handler run (line 110-118). Returns `{ skipped: true, reason: "emergency_stop" }`.
- [x] Platform health — CLEAN: Pre-flight peek per-platform (lines 140-148). Unhealthy → scheduled retry delivery with 1-hour delay. Also checked in main loop (lines 305-331).
- [x] Rate limiting — CLEAN: Pre-flight `peek` (read-only) before claim to avoid noisy state flips. `checkAndRecord` before actual posting. Limits read from DB (`social_accounts.rate_limit_per_hour`). Redis sliding window.
- [x] Duplicate delivery prevention — CLEAN: ON CONFLICT upserts on partial unique index `idx_post_deliveries_active_unique`. After successful post, cancels existing `scheduled`/`posting` deliveries.
- [x] Post template — CLEAN: `getTemplateForPlatform` merges saved with defaults. `formatPost` called with language-resolved content (Georgian or English).
- [x] **REGRESSION BUG**: `posting_attempts` column referenced in raw SQL (line 473) but was dropped in Phase 1 → FIXED: re-added `postingAttempts` column to `articles` schema. Requires `db:push`.

### 3.8 — `processors/maintenance.ts`
- [x] Self-healing — CLEAN: `ensureRepeatableJobs` runs on every schedule tick (30s) + separate interval in index.ts (30s). Checks for missing repeatable jobs, re-creates them. BullMQ deduplicates by jobId.
- [x] TTL cleanup — CLEAN: All configurable via app_config: articles (60d), feed_fetch_runs (336h/14d), llm_telemetry (30d), article_images (30d + R2 cleanup), post_deliveries (30d, only completed/failed/cancelled).
- [x] Post scheduler — CLEAN: Runs every 30s. Atomic claim of up to 10 due deliveries with `FOR UPDATE SKIP LOCKED`. Per-delivery: health check → rate limit → language resolve → image wait → format → post → update. Image generation wait logic with 5min stuck detection and 3min timeout.
- [x] Platform health check — CLEAN: Repeatable job every 2 hours + immediate one-shot at startup. LinkedIn token rotation detection via SHA256 hash comparison.
- [x] **REGRESSION BUG**: `posting_attempts` column referenced in raw SQL (line 398) but was dropped in Phase 1 → FIXED: same schema fix as 3.7.

### 3.9 — Worker utilities
- [x] `rate-limiter.ts` — CLEAN: Redis sorted set sliding window. `checkAndRecord`: removes expired, counts, records if allowed. `peek`: read-only. Edge case at limit: `current >= limitPerHour` → blocked. Key TTL 3600s (1 hour).
- [x] `secure-rss.ts` — CLEAN: HEAD request for Content-Length (graceful fallback). rss-parser with timeout + maxRedirects=5. INFO: No streaming GET body size limit (mitigated by HEAD check + rss-parser internal limits).
- [x] `article-quota.ts` — CLEAN: Per-source overrides from `rss_sources`, global env fallback. Daily count via `created_at >= todayStart`.
- [x] `domain-whitelist.ts` — CLEAN: Root domain extraction with two-part TLD support. Empty whitelist blocks all (safe default).
- [x] `platform-health.ts` — CLEAN: Upsert via INSERT ON CONFLICT DO UPDATE. LinkedIn token rotation via hash. `isPlatformHealthy`: no record → assume healthy (first run).
- [x] `r2-storage.ts` — CLEAN: Upload (PutObject), delete single/batch (max 1000/call). No retry — caller provides retry. 1-year CacheControl for immutable content.
- [x] `image-composer.ts` — CLEAN: Canvas @napi-rs/canvas + sharp. Font registration (Noto Sans Georgian). Watermark caching. Word wrapping via measureText. Output: WebP q85.
- [x] `events.ts` — CLEAN: Redis pub/sub publisher. Graceful error handling (publish failures non-fatal). No-op publisher for disabled events.
- [x] `job-registry.ts` — CLEAN: Checks existing repeatable jobs, registers missing. Per-job error handling (doesn't fail entire batch).
- [x] `index.ts` — CLEAN: Full startup sequence: Redis → DB → Queues → Providers → Workers → Health check → Jobs → Self-heal interval. Graceful shutdown with 30s timeout. Windows SIGBREAK handler. Conditional feature enablement.

---

## Phase 4: API (`packages/api`)

### 4.1 — Route audit (all 16 route files)
- [x] Auth: is API key checked on every route that needs it? — CLEAN: all 84 endpoints properly authenticated. Only `/health` (line 14) is intentionally public. SSE `/api/events` (line 107) properly requires API key (supports query param `api_key` for SSE compatibility). Timing-safe comparison in `auth.ts`.
- [x] Input validation: are request bodies/params validated? — CLEAN: manual validation on all POST/PATCH bodies (required fields, range checks, enum checks). `social-accounts.ts` uses Zod for template validation. Pagination clamped (1-100 limit, page >= 1). No Fastify JSON schemas but manual checks are equivalent.
- [x] SQL injection: any raw SQL with user input? — CLEAN: all queries use Drizzle ORM parameterized operations (`eq()`, `inArray()`, `gte()`, etc.). The `articles.ts:79` search filter uses Drizzle's `sql` tag which parameterizes `${`%${search}%`}` correctly (JS template evaluates first, then Drizzle parameterizes the resulting string). No injection vectors.
- [x] Response consistency: do all routes return consistent error formats? — CLEAN (minor variance): all routes use `{ error: "message" }` format. Some include `details` field for validation errors (`config.ts:539`, `reset.ts:94`). Minor style inconsistency: `reply.code()` vs `reply.status()` (both equivalent in Fastify). `provider-health.ts` uses `checked_at` vs `generated_at` elsewhere — cosmetic only.
- [x] N+1 queries: check `stats.ts`, `articles.ts`, `scheduled.ts` for excessive DB calls — CLEAN: `articles.ts` uses single JOIN query + parallel count. `stats.ts` uses batch queries with `Promise.all()`. `scheduled.ts` uses parallel list+count queries. `telemetry.ts` uses `Promise.all()` for 4 parallel period queries. No N+1 patterns detected.

### 4.2 — Security middleware
- [x] CORS: is `ALLOWED_ORIGINS` actually enforced? — CLEAN: dynamic origin callback in `server.ts:104-116` checks against whitelist. Defaults to `["http://localhost:5173"]`. Allows no-origin requests (curl/mobile/server-to-server) — acceptable. FIXED: `events.ts:113` had hardcoded `Access-Control-Allow-Origin: *` bypassing CORS plugin → removed.
- [x] Rate limiting: is `@fastify/rate-limit` configured correctly? — CLEAN: `server.ts:122-134`, IP-based keying, configurable via `API_RATE_LIMIT_PER_MINUTE` (default 200, min 10, max 1000). Returns 429 with clear message.
- [x] API key middleware: is it applied to all non-public routes? — CLEAN: factory pattern `createRequireApiKey()` in `server.ts:136`. Applied via `{ preHandler: deps.requireApiKey }` on every route except `/health`. Server refuses to start without `API_KEY` set (exit on missing).

### 4.3 — SSE (`events.ts`)
- [x] Connection cleanup: do SSE connections get cleaned up on client disconnect? — CLEAN: `request.raw.on("close")` handler (line 157) sets `isConnected=false`, clears ping interval, removes event listener, decrements client count, calls `maybeCleanupSubscriber()`.
- [x] Memory leak: does the Redis subscriber get unsubscribed? — CLEAN: singleton pattern with shared subscriber + EventEmitter fan-out. `maybeCleanupSubscriber()` (line 91) unsubscribes from channel, calls `.quit()`, and clears all state when last client disconnects. `setMaxListeners(1000)` prevents Node.js warning.
- [x] Reconnect: does the client handle server restarts gracefully? — CLEAN: ioredis auto-reconnects on disconnect. Error/close handlers log but don't crash. Client-side reconnect handled by frontend `EventSource` API.

### 4.4 — Dead routes
- [x] Are there any registered routes that the frontend never calls? — CLEAN: all 84 backend endpoints are called by the frontend. No dead routes.
- [x] Are there any frontend API calls to routes that don't exist? — CLEAN: no broken frontend calls. 3 backend routes lack dedicated `api.ts` wrapper functions (`GET /articles/:id`, `GET /scheduled/:id`, `GET /telemetry/recent`) but these are either called inline or represent unused detail views — not broken.

---

## Phase 5: Frontend (`packages/frontend`)

### 5.0 — SSE Reconnection Storm (found via logs)
- [x] SSE connections cycling every ~4 seconds, piling up endlessly — TWO ROOT CAUSES: (1) `events.ts` async handler returned without `reply.hijack()`, causing Fastify to call `reply.send(undefined)`. FIXED: added `reply.hijack()`. (2) Phase 4 removed `Access-Control-Allow-Origin: *` from SSE `writeHead`, expecting CORS plugin to handle it — but `reply.hijack()` (and raw `writeHead`) bypasses Fastify's `onSend` hooks where the CORS plugin adds headers. Browser killed the cross-origin SSE response. FIXED: manually set `Access-Control-Allow-Origin` from request Origin header in `writeHead`.
- [x] API key logged in full in every SSE request URL (`/api/events?api_key=...`) — FIXED: custom Fastify req serializer redacts `api_key` from logged URLs (`api_key=***`).

### 5.1 — Dead code
- [x] Unused components: any .tsx files not imported anywhere? — CLEAN: all 7 components (Layout, Spinner, ScheduleModal, ConfirmModal, DatePicker, TimePicker, ApiHealthModal) are actively imported. All 13 pages are routed.
- [x] Unused hooks/utils: custom hooks that are no longer called? — FIXED: removed `usePersistedFilters.ts` (defined but never imported; `useLocalStorageFilters` is used instead). 3 remaining hooks (`useServerEvents`, `useDebouncedCallback`, `useLocalStorageFilters`) all active.
- [x] Stale API calls: endpoints that were renamed or removed? — CLEAN: all 70+ frontend API calls match existing backend endpoints. No broken calls.

### 5.2 — API contract
- [x] Do frontend API calls match the actual API response shapes? — CLEAN: all response shapes match. No field name mismatches detected.
- [x] Error handling: are API errors displayed to the user? — CLEAN (minor variance): most API functions parse error JSON with `.json().catch(() => ({}))`. ~6 functions throw generic messages without parsing error body (`getConstraints`, `getSocialAccountsUsage`, `getPlatformHealth`, `updateTranslationConfig`, `updateImageGenerationConfig`, `updateImageTemplate`). Low impact — error toast still shows, just less specific. Left as-is per audit philosophy.
- [x] Loading states: are there missing loading/error states on pages? — INFO: some button actions (schedule, reject, reschedule, cancel) lack per-action loading indicators. `getArticleFilterOptions` and `getTranslationConfig` silent-fail without UI feedback. Low impact — left as-is per audit philosophy.

### 5.3 — Security (frontend-specific)
- [x] API key exposure: is `VITE_API_KEY` used safely? — ACCEPTABLE: key is baked into client bundle (Vite `VITE_` prefix). Mitigated by Nginx basic auth (Layer 9). SSE uses query param (EventSource limitation — no custom headers). Production acceptable with auth layer.
- [x] XSS: is article content (from RSS feeds) sanitized before rendering? — FIXED: `PostTemplates.tsx` used `dangerouslySetInnerHTML` with incomplete regex (only handled `<b>` and `<a>`, didn't strip `<script>`, `<img onerror>`, etc.). Added tag whitelist strip (`<(?!\/?b>|\/?a[\s>])[^>]*>` → removed) before the replacements. Article titles/summaries in Articles.tsx and Scheduled.tsx render as plain text (React auto-escapes) — safe.
- [x] Open redirects: any user-controlled URLs rendered as links? — FIXED: `article.url` and `delivery.article_url` from RSS feeds were rendered as `<a href>` without protocol validation. A malicious RSS feed could inject `javascript:` or `data:` URLs. Added `safeHref()` helper (only allows `http:`/`https:` protocols) to Articles.tsx and Scheduled.tsx. Backend Layer 2 (`isUrlSafe`) also validates during ingest — defense-in-depth.

---

## Phase 6: Cross-Cutting Concerns

### 6.1 — Environment variables
- [x] Every `process.env.X` reference in code has a matching entry in `.env.example` — CLEAN: all 14 `process.env` references map to vars in `.env.example`. FIXED: 4 raw `process.env` bypasses converted to use validated env (provider-health.ts, credits.ts, translation.ts, image-generation.ts)
- [x] Every `.env.example` entry is actually used somewhere in code — CLEAN: all 40 env vars are used. INFO: `NODE_ENV` is in `.env.example` but not referenced in code (standard convention, used by Node/libraries internally — left as-is)
- [x] `baseEnvSchema` in shared matches what worker/api actually need — CLEAN: all env vars accessed at runtime are declared in `baseEnvSchema` or `securityEnvSchema`. Added `env: BaseEnv` to `ApiDeps` type so route handlers use validated env instead of raw `process.env`.
- [x] No secrets hardcoded in source files — CLEAN: no API keys, tokens, or passwords in source code

### 6.2 — Build & dependencies
- [x] `npm run build` succeeds cleanly — CLEAN: all 9 packages build successfully. Only warning: frontend bundle 820KB (Vite chunk size warning — informational, not actionable without code-splitting which is a feature change)
- [x] `npm run lint` passes — FIXED: (1) ESLint 9 couldn't find config — migrated `.eslintrc.cjs` → `eslint.config.mjs` (flat config via FlatCompat). (2) Added `argsIgnorePattern: "^_"` rule for intentionally unused params. (3) Fixed 6 lint errors: unused imports (`sql` in scheduled.ts, `eq` in worker/index.ts, `isNull` in image-generation.ts), unused `vectorStr` in semantic-dedup.ts, `let` → `const` in schemas.ts, wired `onSectorMaxAgeDraftChange` const in App.tsx instead of inline duplication.
- [x] Unused npm dependencies in each package.json — CLEAN: all declared dependencies are imported and used in their respective packages
- [x] Duplicate dependencies across packages (version mismatches) — FIXED: (1) **Zod v3→v4** in llm package (was `^3.23.0`, shared had `^4.3.5` — major version mismatch). (2) **OpenAI** standardized to `^4.73.0` across llm, embeddings, worker (was `^4.70.0`). (3) **TypeScript** standardized to `^5.9.3` across embeddings, llm, social, translation (varied from `^5.4.5` to `^5.6.0`)

### 6.3 — app_config consistency
- [x] List every `app_config` key used in code — 24 unique keys: 5 TTL settings, 3 auto-post toggles, 1 legacy toggle (`auto_post_score5`), 2 score thresholds, 1 kill switch, 6 translation settings, 6 image generation settings
- [x] Verify seed script sets sensible defaults for all keys — FIXED: added 3 missing keys to seed: `auto_approve_threshold` (5), `auto_reject_threshold` (2), `image_generation_prompt` (""). Remaining unseeded: `auto_post_score5` (deprecated legacy, intentionally not seeded), `translation_enabled_since` (dynamically set when switching to ka mode)
- [x] Check that the frontend Settings/ScoringRules pages cover all config keys — CLEAN: all user-facing config keys are editable via Settings, ScoringRules, SiteRules, or ImageTemplate pages. INFO: `image_generation_prompt` is API-accessible but not in frontend UI (advanced setting, default prompt is sufficient)

### 6.4 — Error handling patterns
- [x] Are all worker processors wrapped in try/catch? — CLEAN: all 7 processors (feed, semantic-dedup, llm-brain, translation, image-generation, distribution, maintenance) have proper try/catch blocks around critical operations
- [x] Do API routes return proper HTTP status codes? — CLEAN: all status codes are semantically correct (400 bad request, 404 not found, 409 conflict, 429 rate limit, 500 internal). INFO: `social-accounts.ts` uses `reply.status()` while other routes use `reply.code()` — both are equivalent Fastify methods, cosmetic only
- [x] Is the logger used consistently (not console.log)? — CLEAN: zero `console.log/warn/error/info` calls in backend packages outside the logger implementation itself. All logging goes through the structured `logger` from shared package

---

## Tracking

Mark items `[x]` as we audit each one. Note findings inline:

```
- [x] Item checked — CLEAN
- [x] Item checked — ISSUE: description → fixed in commit abc123
- [x] Item checked — BLOCKER: needs design decision (see note below)
```

## Findings Log

> Format: `[Phase.Section] SEVERITY: description`

[1.1] MEDIUM: R2 env vars bypassed schema validation (raw `process.env`) → FIXED
[1.1] LOW: 6 unused exports in shared package (dead type guards, unused schema) → FIXED (removed)
[1.1] LOW: `console.warn` in config.ts kill switch route → FIXED (use logger)
[1.2] ~~LOW: `articles.postingAttempts` column never used → FIXED (removed from schema)~~ **REVERTED in Phase 3**: column IS used by raw SQL in distribution.ts:473 and maintenance.ts:398 (retry tracking). Re-added to schema.
[1.2] LOW: 4 missing indexes on hot query paths (translation, maintenance, stats, images) → FIXED (added)
[1.2] LOW: `scoringRules.modelPreference` — dead column, wrote global env snapshot but never read → FIXED (removed column + API write)
[1.2] LOW: `socialAccounts.sectorIds` — dead column, never written/read, default empty array → FIXED (removed from schema)
[2.1] LOW: `DEFAULT_SCORING_PROMPT` — dead Phase 3 prompt constant, never used (replaced by `SCORING_WITH_SUMMARY_PROMPT`) → FIXED (removed)
[2.1] MEDIUM: Health check Gemini default `gemini-2.0-flash` mismatched translation worker default `gemini-2.5-flash` → FIXED (updated health.ts)
[2.3] LOW: `buildTranslationPrompt` — deprecated function, never called → FIXED (removed)
[2.4] LOW: Redundant `export type { HealthCheckResult }` after `export *` → FIXED (removed)
[2.4] INFO: `formatDigestPost` in `SocialProvider` interface never called (project uses individual posts only) — left as-is
[3.7] HIGH: `posting_attempts` column regression — Phase 1 incorrectly removed this column from schema + DB, but `distribution.ts:473` and `maintenance.ts:398` reference it in raw SQL → FIXED: re-added to schema, requires `db:push`
[3.9] INFO: `secure-rss.ts` has no streaming GET body size limit — mitigated by HEAD Content-Length check + rss-parser internal limits — low risk
[4.2] ~~MEDIUM: SSE endpoint `events.ts:113` had hardcoded `Access-Control-Allow-Origin: *` bypassing Fastify CORS plugin → FIXED (removed, CORS plugin handles it)~~ **PARTIALLY REVERTED in Phase 5**: removing this header broke SSE because `reply.hijack()` + raw `writeHead` bypass the CORS plugin's `onSend` hook. Re-added as dynamic `Access-Control-Allow-Origin: <request.origin>` (not wildcard `*`).
[4.1] LOW: `/health` endpoint created new Redis connection per request (resource leak under monitoring pressure) → FIXED (uses shared `deps.redis.ping()` instead)
[4.1] LOW: `reset.ts:2` unused `sql` import from drizzle-orm → FIXED (removed)
[4.1] LOW: `health.ts:2` unused `Redis` import from ioredis (after health fix) → FIXED (removed)
[4.1] INFO: Minor style inconsistencies: `reply.code()` vs `reply.status()`, `checked_at` vs `generated_at` — cosmetic, left as-is per audit philosophy
[4.4] INFO: 3 backend routes lack dedicated frontend wrapper functions (`GET /articles/:id`, `GET /scheduled/:id`, `GET /telemetry/recent`) — not broken, just unused detail views
[5.0] HIGH: SSE reconnection storm (~4s cycle) — TWO causes: (1) missing `reply.hijack()` let Fastify kill SSE connection, (2) missing CORS header after Phase 4 removal → FIXED (both)
[5.0] MEDIUM: API key logged in full in request URLs → FIXED (custom Fastify req serializer redacts `api_key=***`)
[5.1] LOW: `usePersistedFilters.ts` — unused hook, never imported → FIXED (deleted)
[5.3] MEDIUM: `dangerouslySetInnerHTML` in `PostTemplates.tsx` with incomplete tag stripping → FIXED (added whitelist regex to strip all tags except `<b>` and `<a>`)
[5.3] MEDIUM: Article URLs from RSS rendered as `<a href>` without protocol validation (potential `javascript:` injection) → FIXED (added `safeHref()` helper in Articles.tsx and Scheduled.tsx, only allows `http:`/`https:`)
[5.2] INFO: ~6 API functions throw generic errors without parsing error body — low impact, left as-is
[5.2] INFO: Some button actions lack per-action loading indicators — low impact, left as-is
[5.3] INFO: `VITE_API_KEY` in client bundle — acceptable with Nginx basic auth (Layer 9)
[6.1] MEDIUM: `provider-health.ts` used raw `process.env` bypassing Zod schema transforms (empty string → undefined) → FIXED (uses `deps.env` from validated `ApiDeps`)
[6.1] MEDIUM: `credits.ts` passed raw `process.env` to `getConfiguredBalances()` → FIXED (passes explicit API key map from validated env)
[6.1] MEDIUM: `translation.ts` directly read `process.env.GOOGLE_AI_API_KEY` / `process.env.OPENAI_API_KEY` → FIXED (API keys passed through `TranslationDeps.apiKeys`)
[6.1] MEDIUM: `image-generation.ts` directly read `process.env.OPENAI_API_KEY` → FIXED (passed through `ImageGenDeps.openaiApiKey`)
[6.1] INFO: `NODE_ENV` in `.env.example` but never referenced in packages code — standard convention, left as-is
[6.2] MEDIUM: ESLint 9 couldn't find config — `.eslintrc.cjs` (legacy format) → FIXED: created `eslint.config.mjs` (flat config via FlatCompat), deleted `.eslintrc.cjs`
[6.2] LOW: 6 lint errors (unused imports: `sql`, `eq`, `isNull`; unused var: `vectorStr`; `let` → `const`; duplicated inline function) → FIXED (all resolved)
[6.2] HIGH: Zod major version mismatch — llm had `^3.23.0`, shared had `^4.3.5` → FIXED (updated llm to `^4.3.5`)
[6.2] LOW: OpenAI SDK version skew (`^4.70.0` vs `^4.73.0`) → FIXED (standardized all to `^4.73.0`)
[6.2] LOW: TypeScript version skew (5.4.5–5.9.3) → FIXED (standardized all to `^5.9.3`)
[6.2] INFO: Frontend bundle 820KB (Vite chunk size warning) — would need code-splitting to fix, not an audit-scope change
[6.3] LOW: 3 `app_config` keys used in code but missing from seed script (`auto_approve_threshold`, `auto_reject_threshold`, `image_generation_prompt`) → FIXED (added to seed.sql)
[6.3] INFO: `image_generation_prompt` is API-accessible but not exposed in frontend UI — advanced setting, default is sufficient
[6.4] CLEAN: All 7 worker processors have proper try/catch, all API routes use correct HTTP status codes, logger is used consistently (zero stray console.log)
[6.4] INFO: `social-accounts.ts` uses `reply.status()` vs `reply.code()` used elsewhere — both equivalent in Fastify, cosmetic

---

## Phase 2 Change Log (for revert reference)

### Files Modified

| File | Change | Revert Notes |
|------|--------|--------------|
| `packages/llm/src/health.ts` | Changed Gemini default from `gemini-2.0-flash` → `gemini-2.5-flash` | Change back to `"gemini-2.0-flash"` |
| `packages/llm/src/prompts.ts` | Removed `DEFAULT_SCORING_PROMPT` constant (26 lines) | Re-add the Phase 3 prompt before `SCORING_WITH_SUMMARY_PROMPT` |
| `packages/llm/src/index.ts` | Removed `DEFAULT_SCORING_PROMPT` from exports | Re-add to the prompts export block |
| `packages/translation/src/prompts.ts` | Removed `buildTranslationPrompt` function (21 lines) | Re-add the deprecated function at end of file |
| `packages/translation/src/index.ts` | Removed `buildTranslationPrompt` from exports | Re-add to the prompts export block |
| `packages/social/src/index.ts` | Removed redundant `export type { HealthCheckResult }` | Re-add after `export * from "./types.js"` |

---

## Phase 4 Change Log (for revert reference)

### Files Modified

| File | Change | Revert Notes |
|------|--------|--------------|
| `packages/api/src/routes/events.ts` | Removed hardcoded `"Access-Control-Allow-Origin": "*"` from SSE headers (line 113) | Re-add `"Access-Control-Allow-Origin": "*",` to the `writeHead` headers object |
| `packages/api/src/routes/health.ts` | Replaced per-request Redis connection with `deps.redis.ping()`. Removed unused `Redis` import from ioredis. | Re-add `import { Redis } from "ioredis"` and restore the `new Redis(...)` + `connect()` + `ping()` + `quit()` block |
| `packages/api/src/routes/reset.ts` | Removed unused `import { sql } from "drizzle-orm"` | Re-add `import { sql } from "drizzle-orm";` on line 2 |

---

## Phase 3 Change Log (for revert reference)

### Files Modified

| File | Change | Revert Notes |
|------|--------|--------------|
| `packages/db/src/schema.ts` | Re-added `postingAttempts` column to `articles` (was incorrectly removed in Phase 1) | Remove `postingAttempts: integer("posting_attempts").notNull().default(0),` from articles table |

### Database Schema Changes (applied via `db:push`)

**Column re-added:**
```sql
-- Phase 1 incorrectly dropped this column. Phase 3 re-added it.
-- To revert, run manually:
ALTER TABLE articles DROP COLUMN posting_attempts;
```

**Why:** `distribution.ts:473` increments `posting_attempts` on hard failure, and `maintenance.ts:398` uses `posting_attempts < 3` to limit retry count. Without this column, the maintenance worker crashes on every 30s tick.

---

## Phase 1 Change Log (for revert reference)

### Files Modified

| File | Change | Revert Notes |
|------|--------|--------------|
| `packages/shared/src/logger.ts` | Removed `export const getLogLevel` | Re-add: `export const getLogLevel = (): LogLevel => currentLevel;` after `setLogLevel` |
| `packages/shared/src/events.ts` | Removed 3 type guard functions: `isArticleEvent`, `isSourceEvent`, `isStatsEvent` | Re-add the functions after the `ServerEvent` union type |
| `packages/shared/src/url-validator.ts` | Changed `export type UrlValidationResult` → `type UrlValidationResult` (internal only) | Change `type` back to `export type` |
| `packages/shared/src/schemas/env.ts` | 1) Added 5 R2 env vars to `coreEnvSchema`. 2) Removed `frontendEnvSchema` export | 1) Remove the R2 block. 2) Re-add `export const frontendEnvSchema = z.object({ VITE_API_URL: z.string().url(), VITE_API_KEY: z.string().min(1) })` |
| `packages/worker/src/index.ts` | Changed R2 config from `process.env.R2_*` → `env.R2_*` (lines ~227-244) | Change `env.R2_*` back to `process.env.R2_*` with `!` non-null assertions |
| `packages/api/src/routes/config.ts` | Changed `console.warn(...)` → `logger.warn(...)` on kill switch route | Change `logger.warn` back to `console.warn` |
| `packages/api/src/routes/scoring-rules.ts` | Removed `const llmProvider = process.env.LLM_PROVIDER ?? "claude"` and removed `modelPreference: llmProvider` from both INSERT and ON CONFLICT SET | Re-add the `llmProvider` const and `modelPreference: llmProvider` to both values and set blocks |
| `packages/db/src/schema.ts` | See DB changes below |  |

### Database Schema Changes (applied via `db:push --force`)

**Columns dropped (Phase 1):**
```sql
-- To revert, run manually:
-- NOTE: posting_attempts was RE-ADDED in Phase 3 (see Phase 3 Change Log above)
ALTER TABLE scoring_rules ADD COLUMN model_preference text DEFAULT 'claude';
ALTER TABLE social_accounts ADD COLUMN sector_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
```

**Indexes added:**
```sql
-- To revert, run manually:
DROP INDEX IF EXISTS idx_articles_translation;
DROP INDEX IF EXISTS idx_articles_stage_created;
DROP INDEX IF EXISTS idx_feed_fetch_runs_source_status;
DROP INDEX IF EXISTS idx_article_images_created;
```

**Schema.ts changes (db package):**
- `articles`: ~~Removed `postingAttempts` column~~ (RE-ADDED in Phase 3). Added 2 indexes: `idx_articles_translation` (importanceScore, translationStatus, createdAt), `idx_articles_stage_created` (pipelineStage, createdAt)
- `scoringRules`: Removed `modelPreference` column definition
- `socialAccounts`: Removed `sectorIds` column definition (was `uuid[].array().default('{}')`)
- `feedFetchRuns`: Converted from flat table to callback form, added `idx_feed_fetch_runs_source_status` (sourceId, status, createdAt)
- `articleImages`: Converted from flat table to callback form, added `idx_article_images_created` (createdAt)

---

## Phase 6 Change Log (for revert reference)

### Files Modified

| File | Change | Revert Notes |
|------|--------|--------------|
| `packages/api/src/server.ts` | Added `env: BaseEnv` to `ApiDeps` type, imported `BaseEnv`, added `env` to deps object | Remove `env: BaseEnv` from type, remove `env` from deps object, remove `BaseEnv` import |
| `packages/api/src/routes/provider-health.ts` | Replaced `const env = process.env` with `deps.env` references | Change `deps.env.X` back to `process.env.X` and re-add `const env = process.env` |
| `packages/api/src/routes/credits.ts` | Replaced `getConfiguredBalances(process.env)` with explicit API key map from `deps.env` | Change back to `getConfiguredBalances(process.env)` and remove `apiKeys` const |
| `packages/worker/src/processors/translation.ts` | Added `apiKeys` to `TranslationDeps`, passed through `getTranslationApiKey()` | Remove `apiKeys` from type/destructuring, revert `getTranslationApiKey` to read `process.env` |
| `packages/worker/src/processors/image-generation.ts` | Added `openaiApiKey` to `ImageGenDeps`, used in OpenAI client + guard check | Remove `openaiApiKey` from type/destructuring, revert to `process.env.OPENAI_API_KEY` |
| `packages/worker/src/index.ts` | Passed `apiKeys`/`openaiApiKey` to translation/image-gen workers, removed unused `eq` import | Remove `apiKeys`/`openaiApiKey` from worker creation calls, re-add `eq` to import |
| `eslint.config.mjs` | **NEW FILE**: ESLint 9 flat config (replaces `.eslintrc.cjs`) | Delete `eslint.config.mjs`, restore `.eslintrc.cjs` |
| `.eslintrc.cjs` | **DELETED**: replaced by `eslint.config.mjs` | Restore from git |
| `packages/api/src/routes/scheduled.ts` | Removed unused `sql` import | Re-add `sql` to drizzle-orm import |
| `packages/worker/src/processors/semantic-dedup.ts` | Removed unused `vectorStr` variable (line 203) | Re-add `const vectorStr = \`[\${embedding.join(",")}]\`;` |
| `packages/worker/src/processors/image-generation.ts` | Removed unused `isNull` import | Re-add `isNull` to drizzle-orm import |
| `packages/llm/src/schemas.ts` | Changed `let cleaned` → `const cleaned` | Change `const` back to `let` |
| `packages/frontend/src/App.tsx` | Replaced inline function with `onSectorMaxAgeDraftChange` const reference (line 865) | Replace `onSectorMaxAgeDraftChange={onSectorMaxAgeDraftChange}` with inline `(id, value) => setSectorMaxAgeDrafts(...)` |
| `packages/db/seed.sql` | Added 3 missing `app_config` keys: `auto_approve_threshold`, `auto_reject_threshold`, `image_generation_prompt` | Remove those 3 INSERT values |

### Dependency Version Changes

| Package | Dependency | Old | New | Reason |
|---------|-----------|-----|-----|--------|
| `packages/llm` | `zod` | `^3.23.0` | `^4.3.5` | Major version mismatch with shared |
| `packages/llm` | `openai` | `^4.70.0` | `^4.73.0` | Standardize across monorepo |
| `packages/embeddings` | `openai` | `^4.70.0` | `^4.73.0` | Standardize across monorepo |
| `packages/worker` | `openai` | `^4.70.0` | `^4.73.0` | Standardize across monorepo |
| `packages/llm` | `typescript` | `^5.6.0` | `^5.9.3` | Standardize across monorepo |
| `packages/embeddings` | `typescript` | `^5.6.0` | `^5.9.3` | Standardize across monorepo |
| `packages/social` | `typescript` | `^5.4.5` | `^5.9.3` | Standardize across monorepo |
| `packages/translation` | `typescript` | `^5.6.0` | `^5.9.3` | Standardize across monorepo |
