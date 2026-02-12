# Task 15: Wire Up SSE for Real-Time UI Updates

The SSE (Server-Sent Events) infrastructure is ~80% built but completely unwired. Workers publish events to Redis, the API streams them via `GET /api/events`, and a React hook exists — but nothing connects them. Multiple pages rely on manual refresh or 30s polling, causing stale UI (e.g., scheduled posts that have been posted still appear in the list until the user refreshes).

**Scope:** 4 tabs across 3 pages — the only ones that show live operational data:

| Phase | Page / Tab | Current | After SSE |
|-------|-----------|---------|-----------|
| **Phase 1** | Article Scheduler → Articles tab | Manual refresh only | Event-driven refetch |
| **Phase 1** | Article Scheduler → Scheduled tab | Manual refresh only | Event-driven refetch |
| **Phase 2** | Monitoring | 30s `setInterval` polling | Replace polling with SSE |
| **Phase 2** | Media Channels → Platforms tab | 30s `setInterval` polling (usage) | Replace polling with SSE |

All other pages/tabs are config or historical — manual refresh is fine for them.

---

## Table of Contents

1. [Current State Audit](#1-current-state-audit)
2. [Gaps Analysis](#2-gaps-analysis)
3. [Architecture: SSE Context + Event-Driven Refetch](#3-architecture-sse-context--event-driven-refetch)
4. [Implementation: Backend Fixes (B1-B2)](#4-implementation-backend-fixes-b1-b2)
5. [Implementation: Phase 1 — Articles & Scheduled (F1-F6)](#5-implementation-phase-1--articles--scheduled-f1-f6)
6. [Implementation: Phase 2 — Monitoring & Platforms (F7-F8)](#6-implementation-phase-2--monitoring--platforms-f7-f8)
7. [Change Map](#7-change-map)
8. [Testing Checklist](#8-testing-checklist)

---

## 1. Current State Audit

### What Already Works (Backend)

| Layer | File | Status |
|-------|------|--------|
| Event type definitions (8 types) | `packages/shared/src/events.ts` | Complete |
| Redis pub/sub channel constant | `packages/shared/src/queues.ts:20` | Complete |
| Worker event publisher | `packages/worker/src/events.ts` | Complete |
| Publisher injected into all 4 workers | `packages/worker/src/index.ts:50-69` | Complete |
| Ingest publishes `source:fetched` | `packages/worker/src/processors/feed.ts:218` | Complete |
| Dedup publishes `article:embedded` | `packages/worker/src/processors/semantic-dedup.ts:207,229` | Complete |
| LLM brain publishes `article:scored/approved/rejected` | `packages/worker/src/processors/llm-brain.ts:382,391,432` | Complete |
| Distribution publishes `article:posted` | `packages/worker/src/processors/distribution.ts:294` | Complete |
| SSE endpoint with shared Redis subscriber | `packages/api/src/routes/events.ts` | Complete |
| SSE route mounted in server | `packages/api/src/server.ts:151` | Complete |
| API key via query param for EventSource | `packages/api/src/utils/auth.ts:10` | Complete |
| 30s heartbeat keep-alive | `packages/api/src/routes/events.ts:146` | Complete |
| Lazy init + cleanup on last disconnect | `packages/api/src/routes/events.ts:29-104` | Complete |

**Data flow (fully functional):**
```
Worker → redis.publish(REDIS_CHANNEL_EVENTS, JSON) → API sharedSubscriber → EventEmitter → reply.raw.write(SSE) → Browser
```

### What Already Works (Frontend)

| Layer | File | Status |
|-------|------|--------|
| `useServerEvents` hook (185 lines) | `packages/frontend/src/hooks/useServerEvents.ts` | Complete but UNUSED |
| Auto-reconnect with configurable delay | `useServerEvents.ts:119-123` | Complete |
| `onEvent` callback per event | `useServerEvents.ts:143` | Complete |
| `onConnect` callback (connect + reconnect) | `useServerEvents.ts:112` | Complete |
| `ConnectionStatus` type + UI pill | `packages/frontend/src/components/Layout.tsx:21-50` | Complete but UNUSED |

### What Currently Drives UI Updates (Polling)

| Page | Mechanism | Interval |
|------|-----------|----------|
| Monitoring (App.tsx:198-239) | `setInterval` + visibility-aware | 30s |
| PlatformSettings (line 150) | `setInterval` for usage only | 30s |
| **Articles** | Manual refresh button only | None |
| **Scheduled** | Manual refresh button only | None |
| All other pages | Manual only | None |

---

## 2. Gaps Analysis

### Gap 1: `article:posted` Missing from Hook Listener List (CRITICAL)

**File:** `packages/frontend/src/hooks/useServerEvents.ts:127-136`

The `eventTypes` array registers listeners for 8 event types but **omits `article:posted`**:

```typescript
// Current (line 127-136):
const eventTypes = [
  "connected",
  "article:ingested",
  "article:embedded",
  "article:scored",
  "article:approved",
  "article:rejected",
  "source:fetched",
  "stats:updated",
];
// MISSING: "article:posted"
```

The `article:posted` event IS published by the distribution worker (`distribution.ts:294`) and IS defined in the `ServerEvent` union type (`events.ts:63-70`), but the frontend hook silently drops it because there's no `addEventListener` for it.

**This is the exact event needed to update the Scheduled tab when a delivery gets posted.**

### Gap 2: No Delivery-Specific Events

The `ServerEvent` union in `packages/shared/src/events.ts` has no delivery-level events. The existing `article:posted` event includes `{ id, platform, postId }` — the article ID and platform, but NOT the delivery ID.

For the Scheduled tab, we need to know which specific `post_deliveries` row changed status. Options:

- **Option A:** Add a new `delivery:status-changed` event type with `{ deliveryId, articleId, platform, status }` — most precise
- **Option B:** Use existing `article:posted` event + refetch the deliveries list — simpler, good enough

**Decision: Option B (refetch on `article:posted`)** — the Scheduled tab already filters by status, so a refetch after any `article:posted` event will naturally remove posted deliveries from the "scheduled" filter view. This avoids adding new event types and new publish calls on the backend.

### Gap 3: Hook Never Called

No component in the entire frontend calls `useServerEvents()`. The hook exists in isolation.

**File:** `packages/frontend/src/App.tsx:826` — renders `<Layout>` without `connectionStatus`:
```tsx
<Layout>
```

### Gap 4: No Event Distribution Layer

The hook is designed as a per-component hook with `onEvent` callbacks. There's no context, store, or event bus to share a single SSE connection across multiple pages.

If both Articles and Scheduled pages independently called `useServerEvents()`, that would create 2 separate `EventSource` connections — wasteful and redundant.

**Solution:** Create a shared `ServerEventsContext` that calls the hook once at the app level and exposes a `subscribe(eventTypes, callback)` pattern for pages.

### Gap 5: `article:ingested` and `stats:updated` Never Published

| Event Type | Defined In | Published By | Status |
|------------|-----------|-------------|--------|
| `article:ingested` | `shared/events.ts:19-28` | Nobody | Dead type |
| `stats:updated` | `shared/events.ts:83-86` | Nobody | Dead type |

These are defined in types and listened for by the hook, but no backend code ever publishes them. Not critical for this task — we can ignore them for now and address later.

### Gap 6: Missing `loadStats()` After Reschedule

**File:** `packages/frontend/src/pages/Scheduled.tsx:145-157`

After rescheduling, `loadDeliveries()` is called but `loadStats()` is NOT:
```typescript
const handleReschedule = async () => {
  // ...
  setRescheduleItem(null);
  loadDeliveries();        // YES
  // loadStats() MISSING   // BUG
};
```

Compare with `handleCancel` (line 125-136) which correctly calls both.

---

## 3. Architecture: SSE Context + Event-Driven Refetch

### Design: Single Connection, Targeted Refetch

```
App.tsx
  └── ServerEventsProvider (calls useServerEvents once)
        ├── Layout (receives connectionStatus → shows Live/Offline pill)
        │
        │  Phase 1:
        ├── Articles tab       (subscribes to article:scored, approved, rejected, posted, source:fetched)
        ├── Scheduled tab      (subscribes to article:posted)
        │
        │  Phase 2:
        ├── Monitoring page    (subscribes to source:fetched, article:scored, approved, rejected, posted)
        └── Platforms tab      (subscribes to article:posted)
```

### ServerEventsContext API

```typescript
type ServerEventsContextValue = {
  /** Current SSE connection status */
  status: ConnectionStatus;
  /** Subscribe to specific event types. Returns unsubscribe function. */
  subscribe: (
    eventTypes: ServerEvent["type"][],
    callback: (event: ServerEvent) => void,
  ) => () => void;
};
```

**How pages use it:**

```typescript
// In Scheduled.tsx:
const { subscribe } = useServerEventsContext();

useEffect(() => {
  const unsubscribe = subscribe(["article:posted"], () => {
    // A delivery was posted — refetch to remove it from "scheduled" list
    loadDeliveries();
    loadStats();
  });
  return unsubscribe;
}, [subscribe, loadDeliveries, loadStats]);
```

### Why This Design

1. **Single SSE connection** — only one `EventSource` for the entire app, created once in App.tsx
2. **Targeted refetch** — pages only refetch when events they care about arrive (not on every event)
3. **No wasted re-renders** — the context value is stable (subscribe is a ref-based function), pages don't re-render on events they don't subscribe to
4. **`onConnect` triggers full refresh** — when SSE reconnects after a disconnect, all subscribed pages get a data refresh to catch events missed during downtime
5. **Graceful fallback** — if SSE fails to connect, pages still work exactly as they do now (manual refresh)

### Event → Page/Tab Mapping

| Event | Articles Tab | Scheduled Tab | Monitoring | Platforms Tab | Rationale |
|-------|:---:|:---:|:---:|:---:|-----------|
| `article:scored` | Refetch | — | Refetch stats | — | New scored article, counters change |
| `article:approved` | Refetch | — | Refetch stats | — | Article auto-approved, counters change |
| `article:rejected` | Refetch | — | Refetch stats | — | Article auto-rejected, counters change |
| `article:posted` | Refetch | Refetch + Stats | Refetch stats | Refetch usage | Article posted; delivery gone from scheduled; usage counter up |
| `source:fetched` | Refetch | — | Refetch stats | — | New batch ingested, source health updated |
| `article:embedded` | — | — | — | — | Not visible in any page (intermediate stage) |

---

## 4. Implementation: Backend Fixes (B1-B2)

### B1: Add `article:posted` to Maintenance Worker (Scheduled Posts)

**File:** `packages/worker/src/processors/maintenance.ts`

The distribution worker publishes `article:posted` for immediate posts (`distribution.ts:294`), but the **maintenance worker's scheduled post processor** does NOT publish this event when it posts scheduled deliveries.

This means: scheduled posts that get posted via the maintenance worker's `processScheduledPosts()` function will NOT trigger an SSE event — the Scheduled tab will never know.

**Find the scheduled post success path** in the `processScheduledPosts` function and add:

```typescript
// After successful scheduled post (after updating delivery status to "posted"):
await eventPublisher.publish({
  type: "article:posted",
  data: {
    id: article.id,
    platform: delivery.platform,
    postId: postResult.postId,
  },
});
```

**Dependency:** The `eventPublisher` must be passed to the maintenance worker. Check if it's already available in the maintenance worker's deps — if not, add it.

**Impact:** This is the key fix. Without this, the Scheduled tab's SSE-driven refetch will only work for immediate posts (via distribution worker), not for scheduled posts (via maintenance worker).

### B2: Verify eventPublisher Reaches Maintenance Worker

**File:** `packages/worker/src/index.ts`

Check the maintenance worker creation call. The `eventPublisher` is created at line 50-69 and passed to ingest, dedup, llm-brain, and distribution workers. Verify it's also passed to the maintenance worker factory. If not, add it:

```typescript
// In worker bootstrap, where maintenance worker/processor is created:
createMaintenanceProcessor({
  // ...existing deps...
  eventPublisher,  // ADD if missing
});
```

Also update the maintenance processor's deps type to accept `EventPublisher`.

---

## 5. Implementation: Phase 1 — Articles & Scheduled (F1-F6)

### F1: Fix `article:posted` in useServerEvents Hook

**File:** `packages/frontend/src/hooks/useServerEvents.ts`

**Change:** Add `"article:posted"` to the `eventTypes` array (line 127-136):

```typescript
const eventTypes = [
  "connected",
  "article:ingested",
  "article:embedded",
  "article:scored",
  "article:approved",
  "article:rejected",
  "article:posted",     // ADD — was missing
  "source:fetched",
  "stats:updated",
];
```

### F2: Create ServerEventsContext

**File:** `packages/frontend/src/contexts/ServerEventsContext.tsx` (NEW)

```typescript
import { createContext, useContext, useRef, useCallback, type ReactNode } from "react";
import { useServerEvents, type ConnectionStatus } from "../hooks/useServerEvents";
import type { ServerEvent } from "@watch-tower/shared";

type Subscriber = {
  eventTypes: ServerEvent["type"][];
  callback: (event: ServerEvent) => void;
};

type ServerEventsContextValue = {
  status: ConnectionStatus;
  subscribe: (
    eventTypes: ServerEvent["type"][],
    callback: (event: ServerEvent) => void,
  ) => () => void;
};

const ServerEventsContext = createContext<ServerEventsContextValue | null>(null);

export function ServerEventsProvider({ children }: { children: ReactNode }) {
  const subscribersRef = useRef<Set<Subscriber>>(new Set());

  const subscribe = useCallback(
    (eventTypes: ServerEvent["type"][], callback: (event: ServerEvent) => void) => {
      const subscriber: Subscriber = { eventTypes, callback };
      subscribersRef.current.add(subscriber);
      return () => {
        subscribersRef.current.delete(subscriber);
      };
    },
    [],
  );

  // Single SSE connection for the entire app
  const { status } = useServerEvents({
    onEvent: (event) => {
      // Fan out to subscribers that care about this event type
      subscribersRef.current.forEach((sub) => {
        if (sub.eventTypes.includes(event.type)) {
          sub.callback(event);
        }
      });
    },
    onConnect: () => {
      // On reconnect, notify ALL subscribers to refresh (catch missed events)
      // Use a synthetic event that matches all subscriptions
      subscribersRef.current.forEach((sub) => {
        // Call with a special "reconnect" signal — subscribers should refetch
        // We trigger the callback with any of their subscribed event types
        // so they refresh their data
        if (sub.eventTypes.length > 0) {
          sub.callback({ type: sub.eventTypes[0], data: {} } as ServerEvent);
        }
      });
    },
  });

  return (
    <ServerEventsContext.Provider value={{ status, subscribe }}>
      {children}
    </ServerEventsContext.Provider>
  );
}

export function useServerEventsContext(): ServerEventsContextValue {
  const ctx = useContext(ServerEventsContext);
  if (!ctx) {
    throw new Error("useServerEventsContext must be used within ServerEventsProvider");
  }
  return ctx;
}
```

**Key design points:**
- `subscribe` returns an unsubscribe function (cleanup-friendly for useEffect)
- `subscribersRef` is a Set (ref, not state) — adding/removing subscribers does NOT cause re-renders
- `onConnect` fires on reconnect, triggering all subscribers to refetch (catches events missed during disconnect)
- `subscribe` is wrapped in `useCallback` with empty deps — stable reference, safe for useEffect dependencies

### F3: Wire Provider in App.tsx + Pass Status to Layout

**File:** `packages/frontend/src/App.tsx`

**Change 1:** Import the provider and context hook:
```typescript
import { ServerEventsProvider, useServerEventsContext } from "./contexts/ServerEventsContext";
```

**Change 2:** Wrap the app with the provider (around line 826):

```tsx
// Before:
<Layout>
  <Toaster richColors position="top-right" />
  <Routes>...</Routes>
</Layout>

// After:
<ServerEventsProvider>
  <AppContent />
</ServerEventsProvider>
```

**Change 3:** Extract `Layout` + `Routes` into an inner `AppContent` component so it can use `useServerEventsContext()`:

```tsx
function AppContent() {
  const { status } = useServerEventsContext();

  return (
    <Layout connectionStatus={status}>
      <Toaster richColors position="top-right" />
      <Routes>
        {/* ...all existing routes unchanged... */}
      </Routes>
    </Layout>
  );
}
```

**Note:** The `ServerEventsProvider` must be OUTSIDE `AppContent` so the context is available. The `useServerEventsContext()` call must be INSIDE a child of the provider.

**Result:** The Layout header will now show the "Live" / "Connecting..." / "Offline" / "Error" status pill — this already exists in Layout.tsx:45-50 but was never activated.

### F4: Wire SSE Events into Scheduled Page

**File:** `packages/frontend/src/pages/Scheduled.tsx`

**Change 1:** Import the context hook:
```typescript
import { useServerEventsContext } from "../contexts/ServerEventsContext";
```

**Change 2:** Subscribe to relevant events (after the existing `useEffect` blocks, around line 115):

```typescript
// SSE: auto-refresh when a delivery gets posted
const { subscribe } = useServerEventsContext();

useEffect(() => {
  const unsubscribe = subscribe(["article:posted"], () => {
    loadDeliveries();
    loadStats();
  });
  return unsubscribe;
}, [subscribe, loadDeliveries, loadStats]);
```

**Why `article:posted` is sufficient:** When the maintenance worker posts a scheduled delivery, it:
1. Changes the delivery status from `"scheduled"` to `"posted"`
2. Publishes `article:posted` event (after B1 fix)
3. The Scheduled tab, filtering by `status: "scheduled"`, refetches and the posted delivery disappears

**Change 3:** Fix missing `loadStats()` after reschedule (line 152):

```typescript
// Before:
const handleReschedule = async () => {
  // ...
  setRescheduleItem(null);
  loadDeliveries();
  // loadStats() was missing
};

// After:
const handleReschedule = async () => {
  // ...
  setRescheduleItem(null);
  loadDeliveries();
  loadStats();  // ADD — was missing, stats become stale after reschedule
};
```

### F5: Wire SSE Events into Articles Page

**File:** `packages/frontend/src/pages/Articles.tsx`

**Change 1:** Import the context hook:
```typescript
import { useServerEventsContext } from "../contexts/ServerEventsContext";
```

**Change 2:** Find the `loadArticles` function (should be a `useCallback` that fetches articles).

**Change 3:** Subscribe to relevant events:

```typescript
// SSE: auto-refresh when articles change pipeline stage
const { subscribe } = useServerEventsContext();

useEffect(() => {
  const unsubscribe = subscribe(
    ["article:scored", "article:approved", "article:rejected", "article:posted", "source:fetched"],
    () => {
      loadArticles();
    },
  );
  return unsubscribe;
}, [subscribe, loadArticles]);
```

**Why these events:**
- `article:scored` — new article appears in scored list (manual review candidates)
- `article:approved` — article auto-approved, stage changes
- `article:rejected` — article auto-rejected, stage changes
- `article:posted` — article posted, stage changes to "posted"
- `source:fetched` — new batch of articles ingested, new items in list

### F6: Debounce Rapid Events (Optional but Recommended)

When a batch of 10 articles gets scored, the LLM brain worker publishes 10 `article:scored` events in rapid succession. Without debouncing, the Articles page would refetch 10 times in a few seconds.

**Add a simple debounce to the subscribe callback in both pages:**

```typescript
// Helper (can be added inline or as a shared utility):
const useDebouncedCallback = (fn: () => void, delayMs: number) => {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(fn, delayMs);
  }, [fn, delayMs]);
};
```

**Usage in Scheduled.tsx:**
```typescript
const debouncedRefresh = useDebouncedCallback(() => {
  loadDeliveries();
  loadStats();
}, 2000);

useEffect(() => {
  const unsubscribe = subscribe(["article:posted"], debouncedRefresh);
  return unsubscribe;
}, [subscribe, debouncedRefresh]);
```

**Usage in Articles.tsx:**
```typescript
const debouncedRefresh = useDebouncedCallback(() => {
  loadArticles();
}, 2000);

useEffect(() => {
  const unsubscribe = subscribe(
    ["article:scored", "article:approved", "article:rejected", "article:posted", "source:fetched"],
    debouncedRefresh,
  );
  return unsubscribe;
}, [subscribe, debouncedRefresh]);
```

**2000ms debounce** means: after the first event, wait 2 seconds for more events to arrive, then refetch once. This batches 10 rapid events into 1 API call.

---

## 6. Implementation: Phase 2 — Monitoring & Platforms (F7-F8)

Phase 2 **replaces existing 30s polling** with SSE-driven refetch on these two pages. This is a net improvement: fewer API calls during idle periods, instant updates during active periods.

### F7: Replace Monitoring Polling with SSE

The Monitoring page's data is managed in `App.tsx` because `refreshStats()` (line 750-764) is called by a 30s `setInterval` (line 198-239) and passed down as props. The monitoring stats include source overview and per-source health.

**Current polling code in App.tsx (lines 198-239):**
```typescript
useEffect(() => {
  if (!statsAutoRefresh) return;
  let intervalId = null;
  const startPolling = () => {
    intervalId = setInterval(() => { refreshStats(); }, 30_000);
  };
  // ...visibility change handling...
  return () => { stopPolling(); removeListener(); };
}, [statsAutoRefresh]);
```

**Change: Replace `setInterval` with SSE subscription.**

Since `refreshStats` lives in App.tsx (which is inside `ServerEventsProvider` via `AppContent`), we can subscribe directly in the `AppContent` component:

```typescript
function AppContent() {
  const { status, subscribe } = useServerEventsContext();

  // Replace 30s polling with SSE-driven refresh for Monitoring stats
  const debouncedRefreshStats = useDebouncedCallback(() => {
    refreshStats();
  }, 2000);

  useEffect(() => {
    const unsubscribe = subscribe(
      ["source:fetched", "article:scored", "article:approved", "article:rejected", "article:posted"],
      debouncedRefreshStats,
    );
    return unsubscribe;
  }, [subscribe, debouncedRefreshStats]);

  // ...rest of AppContent
}
```

**What to remove from App.tsx:**
- Delete the entire `setInterval` + visibility-change `useEffect` block (lines 198-239)
- Delete `statsAutoRefresh` state and `setStatsAutoRefresh` setter
- Delete `statsUpdatedAt` state and `setStatsUpdatedAt` setter (the "Updated X:XX PM" timestamp)
- Remove `autoRefreshEnabled` and `onToggleAutoRefresh` props from `<Monitoring>` (line 888-889)
- Remove `lastUpdated` prop from `<Monitoring>` (line 886)
- Keep the manual "Refresh" button and `onRefresh={refreshStats}` prop as-is

**What to remove from Monitoring page (`Monitoring.tsx`):**
- Remove the "Auto-refresh on/off" toggle button and its state
- Remove the "Updated X:XX PM" timestamp display
- Remove `autoRefreshEnabled`, `onToggleAutoRefresh`, `lastUpdated` from props type
- The Layout header's "Live" pill (activated in F3) replaces both — it tells the user data is being updated in real-time

**Why this works:**
- `source:fetched` — triggers when any RSS source completes a fetch (updates source health cards, stale indicators, items-24h counts)
- `article:scored/approved/rejected/posted` — triggers when pipeline processes articles (updates the overview counters: scored, approved, rejected totals)
- During active pipeline: instant updates (vs 30s delay)
- During idle: zero API calls (vs polling every 30s for nothing)
- No toggle needed — SSE is always on (connection is app-level), and refetch only fires on actual events (negligible cost)

### F8: Replace Platforms Tab Usage Polling with SSE

**File:** `packages/frontend/src/pages/PlatformSettings.tsx`

**Current polling code (lines 139-152):**
```typescript
useEffect(() => {
  const loadUsage = async () => {
    const { usage } = await getSocialAccountsUsage();
    const byPlatform = Object.fromEntries(usage.map((u) => [u.platform, u]));
    setPlatformUsage(byPlatform);
  };
  const interval = setInterval(loadUsage, 30000);
  return () => clearInterval(interval);
}, []);
```

**Change: Replace `setInterval` with SSE subscription.**

```typescript
import { useServerEventsContext } from "../contexts/ServerEventsContext";

// Inside PlatformSettings component:
const { subscribe } = useServerEventsContext();

const loadUsage = useCallback(async () => {
  try {
    const { usage } = await getSocialAccountsUsage();
    const byPlatform = Object.fromEntries(usage.map((u) => [u.platform, u]));
    setPlatformUsage(byPlatform);
  } catch {
    // Silent fail
  }
}, []);

// SSE: refresh usage when a post goes out (usage counters change)
useEffect(() => {
  const unsubscribe = subscribe(["article:posted"], loadUsage);
  return unsubscribe;
}, [subscribe, loadUsage]);
```

**What to remove:**
- Delete the entire `setInterval(loadUsage, 30000)` `useEffect` block (lines 139-152)
- Keep the initial `loadUsage()` call on mount

**Why `article:posted` is the right event:**
- Usage counters track posts-per-hour per platform
- The only thing that changes usage is a post going out
- `article:posted` fires for both immediate and scheduled posts (after B1 fix)
- No need to poll every 30s — usage only changes when a post succeeds

**Bonus:** The `loadUsage` function needs to be extracted into a `useCallback` (it's currently inline in the `useEffect`). This is required so it can be used as a stable dependency for the SSE subscription.

---

## 7. Change Map

### Phase 1: Core Wiring + Articles & Scheduled

| # | File | Change | Scope |
|---|------|--------|-------|
| B1 | `packages/worker/src/processors/maintenance.ts` | Add `article:posted` event publish after scheduled post success | ~5 lines |
| B2 | `packages/worker/src/index.ts` | Ensure `eventPublisher` is passed to maintenance worker | ~2 lines |
| F1 | `packages/frontend/src/hooks/useServerEvents.ts` | Add `"article:posted"` to eventTypes array | 1 line |
| F2 | `packages/frontend/src/contexts/ServerEventsContext.tsx` (NEW) | SSE context provider with subscribe pattern | ~70 lines |
| F3 | `packages/frontend/src/App.tsx` | Wrap with `ServerEventsProvider`, extract `AppContent`, pass `connectionStatus` to Layout | ~15 lines |
| F4 | `packages/frontend/src/pages/Scheduled.tsx` | Subscribe to `article:posted`, fix missing `loadStats()` after reschedule | ~15 lines |
| F5 | `packages/frontend/src/pages/Articles.tsx` | Subscribe to article stage change events | ~12 lines |
| F6 | Both pages + optional shared utility | Debounce rapid events (2s) | ~15 lines |

### Phase 2: Monitoring & Platforms (Replace Polling)

| # | File | Change | Scope |
|---|------|--------|-------|
| F7 | `packages/frontend/src/App.tsx` | Replace 30s polling with SSE subscription, remove `statsAutoRefresh` + `statsUpdatedAt` state, remove toggle/timestamp props from Monitoring | ~15 lines (add) / ~45 lines (remove) |
| F7 | `packages/frontend/src/pages/Monitoring.tsx` | Remove auto-refresh toggle button, "Updated" timestamp, and related props | ~0 lines (add) / ~15 lines (remove) |
| F8 | `packages/frontend/src/pages/PlatformSettings.tsx` | Replace 30s `setInterval` usage polling with SSE subscription on `article:posted` | ~10 lines (add) / ~10 lines (remove) |

### Totals

**Total new files:** 1 (`ServerEventsContext.tsx`)
**Total modified files:** 8
**Estimated lines added:** ~160
**Estimated lines removed:** ~70 (polling code + auto-refresh toggle + timestamp UI)
**Net new code:** ~90 lines
**Backend changes:** Minimal (~7 lines) — the backend is already done

---

## 8. Testing Checklist

### Phase 1: SSE Connection (F1-F3)

- [ ] **Live indicator shows in header** — When frontend loads, the Layout header shows a green "Live" pill next to "Media Watch Tower"
- [ ] **Connecting state visible** — Brief amber "Connecting..." state appears on page load before SSE connects
- [ ] **Error recovery** — If API is stopped, status shows red "Error", then auto-reconnects when API restarts (3s delay)
- [ ] **Single connection** — Browser DevTools Network tab shows only ONE EventSource connection regardless of which page is active
- [ ] **Heartbeat** — `:ping` comments arrive every 30s in the SSE stream (visible in DevTools)
- [ ] **API key passed** — SSE URL includes `?api_key=...` query parameter

### Phase 1: Scheduled Tab Real-Time Updates (F4)

- [ ] **Posted deliveries disappear** — With Scheduled tab open (filter: "scheduled"), when a scheduled delivery gets posted by the maintenance worker, the delivery row disappears from the list within ~2 seconds WITHOUT manual refresh
- [ ] **Stats update** — The status count cards (Scheduled: N, Posted: N) update after a delivery is posted
- [ ] **"Due in next hour" updates** — The "due in next hour" counter decreases as deliveries are posted
- [ ] **Multiple deliveries** — If 3 deliveries are posted in rapid succession (e.g., same minute), the list updates once (debounced) not 3 times
- [ ] **Filter preservation** — After SSE-triggered refetch, current filter settings (status, platform, date range) are preserved
- [ ] **Pagination preservation** — After SSE-triggered refetch, current page number is preserved
- [ ] **Manual refresh still works** — The "Refresh" button continues to work alongside SSE updates
- [ ] **Reschedule refreshes stats** — After rescheduling a delivery, both deliveries AND stats are refreshed (bug fix)

### Phase 1: Articles Tab Real-Time Updates (F5)

- [ ] **New scored articles appear** — When LLM brain scores articles, new items appear in the Articles list within ~2 seconds
- [ ] **Stage changes reflect** — When an article is auto-approved (score 5) or auto-rejected (score 1-2), its stage badge updates
- [ ] **Batch scoring debounced** — When 10 articles are scored simultaneously, only 1 refetch occurs (not 10)
- [ ] **New ingested articles appear** — After RSS fetch completes (`source:fetched`), new articles appear in the list
- [ ] **Posted articles update** — When a distribution succeeds, the article's stage changes to "posted"
- [ ] **Filter/sort preserved** — SSE-triggered refetches preserve current filter and sort settings

### Phase 2: Monitoring Page (F7)

- [ ] **30s `setInterval` removed** — No more polling in App.tsx; the `setInterval` + visibility-change `useEffect` block is deleted
- [ ] **Auto-refresh toggle removed** — The "Auto-refresh on/off" button no longer appears on the Monitoring page
- [ ] **"Updated" timestamp removed** — The "Updated X:XX PM" text no longer appears (the Layout "Live" pill replaces it)
- [ ] **SSE replaces polling** — When a source finishes fetching (`source:fetched`), monitoring stats refresh instantly (vs 30s delay)
- [ ] **Pipeline activity updates counters** — When articles are scored/approved/rejected/posted, the overview cards (total articles, scored, approved, etc.) update within ~2 seconds
- [ ] **Manual refresh still works** — The "Refresh" button continues to call `refreshStats()` directly
- [ ] **Idle = zero calls** — When no pipeline activity, zero API calls for monitoring data (previously polled every 30s even when nothing changed)
- [ ] **Source health cards update** — After a source fetch, the per-source health indicators (ok/stale/error, last success, duration) update without manual refresh
- [ ] **Queue backlog updates** — When workers process jobs, the waiting/active/delayed/failed queue metrics reflect changes

### Phase 2: Platforms Tab Usage (F8)

- [ ] **30s `setInterval` removed** — No more polling in PlatformSettings.tsx; the usage polling `useEffect` is deleted
- [ ] **Usage updates on post** — When an article is posted to a platform, the posts-per-hour usage counter for that platform updates within ~2 seconds
- [ ] **Status transitions** — Usage indicators transition correctly: ok → warning → blocked as posts accumulate
- [ ] **Idle = zero calls** — When no posts go out, zero API calls for usage data (previously polled every 30s)
- [ ] **Initial load preserved** — Usage data still loads on component mount (not only via SSE)
- [ ] **Health data unaffected** — Platform health (token status, expiry) still loads on mount and via manual refresh (not affected by this change)

### Reconnection Behavior

- [ ] **Reconnect triggers refresh** — After SSE disconnects and reconnects, both Articles and Scheduled pages auto-refresh their data (catches events missed during disconnect)
- [ ] **No duplicate connections** — After reconnect, still only ONE EventSource in DevTools
- [ ] **Tab visibility** — SSE stays connected regardless of tab visibility (EventSource handles this natively)

### Backend: Scheduled Posts Emit Events (B1-B2)

- [ ] **Maintenance worker publishes `article:posted`** — When the maintenance worker's scheduled post processor posts a delivery, an `article:posted` event appears in the SSE stream
- [ ] **Both paths emit events** — Both immediate posts (distribution worker) AND scheduled posts (maintenance worker) publish `article:posted` events
- [ ] **Event data correct** — Published event includes `{ id: articleId, platform: "telegram"|"facebook"|"linkedin", postId: "..." }`

### Edge Cases

- [ ] **No SSE available** — If SSE connection fails permanently (wrong API URL, network issue), pages work normally with manual refresh — no errors, no broken UI
- [ ] **Empty subscriber list** — If no page is mounted that subscribes to events, events are silently ignored (no errors)
- [ ] **Rapid mount/unmount** — Navigating quickly between Articles and Scheduled pages doesn't leak subscribers or cause stale callbacks
- [ ] **Multiple tabs** — Two browser tabs each get their own SSE connection and both receive events correctly
- [ ] **Large event bursts** — During a full pipeline run (ingest → embed → score → distribute), the debounce prevents excessive refetching

### Performance

- [ ] **No unnecessary renders** — The ServerEventsContext uses refs for subscribers, so adding/removing subscribers doesn't cause re-renders
- [ ] **API call frequency** — With 2s debounce, worst case is 1 API call per 2 seconds per page during active pipeline processing
- [ ] **Idle state** — When no pipeline activity, zero API calls (unlike polling which would call every 30s)
- [ ] **Memory** — EventSource is properly closed on unmount, no leaked connections

---

## Summary

This task wires up the existing SSE infrastructure to provide real-time UI updates on 4 tabs across 3 pages — the only operational pages in the app that show live data:

### Phase 1: New Real-Time Capabilities
1. **Article Scheduler → Scheduled tab** — posted deliveries disappear from the list in real-time (the original reported issue)
2. **Article Scheduler → Articles tab** — new/scored/approved/rejected/posted articles update in real-time

### Phase 2: Replace Existing Polling (Net Improvement)
3. **Monitoring** — replace 30s `setInterval` polling with SSE-driven refetch (instant updates during activity, zero calls during idle)
4. **Media Channels → Platforms tab** — replace 30s `setInterval` usage polling with SSE-driven refetch on `article:posted`

### Pages NOT included (config/historical — manual refresh is fine)
- Home (source management), Sectors (CRUD), LLM Brain (scoring rules config), Media Channels → Formats tab (post template config), Restrictions/Site Rules (all tabs — domain whitelist, feed limits, emergency stop, translation settings), DB/Telemetry (historical data, cleanup settings)

**Architecture:** Single SSE connection via React Context (Option C), pages subscribe to specific event types, 2s debounce prevents API flooding during batch operations.

**Backend changes are minimal** — just adding `article:posted` event emission from the maintenance worker's scheduled post processor. The rest of the backend (Redis pub/sub, SSE endpoint, worker publishers) is already production-ready.

**Key principle:** Event-driven refetch, not event-driven state mutation. When an SSE event arrives, the page simply calls its existing `loadArticles()` / `loadDeliveries()` / `refreshStats()` / `loadUsage()` function. This avoids complex state synchronization — the API remains the source of truth.
