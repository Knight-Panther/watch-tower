# Frontend UI/UX Optimization — Terms of Reference

**Project:** Watch Tower Media Monitoring Dashboard
**Stack:** React 19 + Vite + Tailwind CSS (dark theme)
**Scope:** Full frontend audit and redesign pass across 12 pages
**Date:** 2026-02-26

---

## 0. Critical Rule — Dependency Analysis Before Any Change

**This rule applies to every phase, step, and individual task in this document. No exceptions.**

Before suggesting, planning, or implementing ANY code change — whether it is a component extraction, a visual tweak, a prop rename, or a new shared component — the implementer MUST first:

### 0.1 Scan & Analyze the Focus Area
1. **Read every file** that will be touched or could be affected by the change.
2. **Trace all imports and exports** — who consumes the component/function/type being modified? Follow the chain to the last level (component → page → route → App.tsx).
3. **Trace all props and state** — if a prop is renamed, added, or removed, identify every parent that passes it and every child that reads it.
4. **Trace all API calls** — if a page's data-fetching or mutation logic moves (e.g., from a page into a shared component), verify the API function signatures, error handling, and loading state ownership still work.
5. **Trace all CSS/Tailwind classes** — if a shared component replaces inline styles, verify that every consuming page gets the same visual result (padding, colors, hover states, disabled states).

### 0.2 Build a Code Dependency Tree
For each change, produce a written dependency tree BEFORE writing any code:

```
[Change] Replace inline button styles with shared <Button> component
  ├── Button.tsx (NEW) — primary, secondary, danger, outline, ghost variants
  ├── Home.tsx — 8 inline buttons → <Button>
  │   ├── "Add Source" button (line 245) — uses bg-slate-100 → maps to variant="primary"
  │   ├── "Save" button (line 502) — uses bg-emerald-500 → maps to variant="primary"
  │   └── ... (list every instance)
  ├── SiteRules.tsx — 4 inline buttons → <Button>
  ├── Articles.tsx — 6 inline buttons → <Button>
  │   └── ScheduleModal.tsx — 3 buttons (passed as children? or internal?)
  └── [VERIFY] No other files import removed class patterns
```

### 0.3 Check for These Specific Risks

| Risk | How to check | What to do |
|------|-------------|------------|
| **Functionality break** | Run the app and test the exact user flow affected by the change | Do not merge until flow works end-to-end |
| **Dead code** | After extracting/moving code, grep the codebase for the old function/component/variable name — if zero references remain, delete it | Never leave orphaned imports, unused state variables, or unreachable code |
| **Redundancy / duplication** | Before creating a new component, search for existing ones that do the same thing (e.g., `ConfirmModal.tsx` already exists but is unused) | Reuse or extend existing code, do not create parallel implementations |
| **Overkill / over-engineering** | Ask: "Does this abstraction serve 2+ concrete use cases RIGHT NOW?" If not, inline it | Do not create generic utilities for single-use scenarios. Three similar lines of code are better than a premature abstraction |
| **Style regression** | Compare before/after screenshots of every page that consumes the changed component | Pixel-level differences must be intentional, not accidental |
| **Type errors** | Run `tsc --noEmit` (or the build) after every change | Zero TypeScript errors at all times |
| **Build breakage** | Run `npm run build` (Turborepo) after every logical unit of work | Green build is a hard gate — never proceed to the next task on a broken build |

### 0.4 Order of Operations (Per Change)

```
1. READ all affected files
2. DOCUMENT the dependency tree (written, not mental)
3. IMPLEMENT the change
4. GREP for dead code / orphaned references
5. BUILD to verify zero errors
6. TEST the affected user flow in browser
7. COMPARE before/after visuals for regressions
```

**If any step in this process reveals an unexpected dependency, STOP and re-analyze before continuing.** Do not push through hoping it works.

This rule exists because the codebase has 12 interconnected pages, shared state via URL params and localStorage, cross-page API calls, and inline styles that look identical but have subtle differences. A "simple" change in one file can silently break behavior in three others. The dependency tree is the safety net.

---

## 1. Objective

Perform a cohesive UI/UX optimization pass on the Watch Tower operator dashboard. The application was built feature-first — every feature works, but the interface accumulated visual and interaction inconsistencies across 12 pages developed at different times. The goal is to make it feel like one product: unified patterns, predictable interactions, proper safety guards, and a modern, compact appearance.

---

## 2. Current State Summary

| Metric | Value |
|--------|-------|
| Pages | 12 routes (Home, Monitoring, Article Scheduler, Sectors, LLM Brain, Media Channels, Image Template, Restrictions, Alerts, Daily Digest, Analytics, DB/Telemetry) |
| Shared components | 2 (Layout.tsx, Spinner.tsx) |
| Button style variations | 10+ (inline Tailwind, no shared component) |
| Confirmation patterns | 3 (custom modal, browser `confirm()`, browser `alert()`) |
| Error feedback patterns | 3 (toast, `alert()`, inline red text) |
| Loading state patterns | 3 (Spinner component, "..." text, nothing) |
| Accessibility baseline | Minimal (no ARIA labels, no focus trapping, color-only indicators) |
| Mobile support | None (no hamburger nav, no responsive tables) |

---

## 3. Deliverables

### 3.1 Design System — Shared Component Kit

Create reusable components that every page will consume. This eliminates the majority of visual inconsistency in a single pass.

| Component | Purpose | Variants |
|-----------|---------|----------|
| **Button** | All clickable actions | `primary`, `secondary`, `danger`, `outline`, `ghost` + sizes `sm`, `md`, `lg` |
| **ConfirmModal** | All destructive/irreversible actions | Danger (red) and neutral (default) themes |
| **FormField** | Label + input + validation error | Text, select, textarea, with optional help text and character counter |
| **Tabs** | All tabbed interfaces | Consistent underline style, single accent color |
| **EmptyState** | All empty lists/tables | Icon, title, description, optional action button |
| **LoadingButton** | Buttons with async operations | Wraps Button with spinner + disabled state |
| **Skeleton** | Content placeholders during data fetch | Card, row, text block variants |
| **TagInput** | Keyword/priority tag entry | With "Add" button, counter "(3/20)", blur-to-commit |
| **StatusDot** | Colored status indicators | Color dot + text label (accessibility) |

**Acceptance criteria:**
- Every page uses these shared components (no inline button/tab/form styling)
- Storybook-like visual tests or a dedicated `/design` dev-only route showing all variants

---

### 3.2 Confirmation & Safety Audit

Every destructive or irreversible action must use `ConfirmModal` with clear explanation. No browser `confirm()` or `alert()` anywhere in the codebase.

| Action | Current | Required |
|--------|---------|----------|
| Kill switch toggle | Custom modal (done) | Keep as-is |
| Delete RSS source | Custom modal in App.tsx | Migrate to shared ConfirmModal |
| Delete domain from whitelist | Browser `confirm()` | Replace with ConfirmModal |
| Batch reject articles | No confirmation | Add ConfirmModal with count: "Reject 12 articles?" |
| Batch approve articles | No confirmation | Add ConfirmModal with count |
| Pipeline reset (flush Redis + truncate) | Modal but vague copy | Rewrite: itemize what's deleted vs preserved |
| Delete sector | Modal but cascading effects hidden | Add: "X sources will become Unassigned" |
| Reset scoring rules to defaults | No confirmation | Add ConfirmModal |
| Kill switch error feedback | `alert()` | Replace with `toast.error()` |

**Acceptance criteria:**
- Zero instances of `window.confirm()` or `window.alert()` in frontend code
- Every destructive action explains what will happen and what won't be affected
- All modals have Cancel + Confirm buttons with appropriate color coding (red for destructive, green/blue for safe)

---

### 3.3 Feedback & Status Patterns

Ensure every async operation has: loading indicator, success feedback, error feedback.

| Pattern | Where missing | Required fix |
|---------|--------------|-------------|
| **Loading skeleton** | Articles initial load (blank space), Monitoring source list, ScoringRules preview pane | Add Skeleton component |
| **Success toast** | Copy URL button (Home) shows checkmark icon only | Add `toast.success("URL copied")` |
| **Active filter indicator** | Articles page — filters persist in localStorage but nothing visible says "Filtered" | Add filter summary badge in header: "Showing 42 articles · Score >= 4 · Stage: approved" |
| **Tag input limits** | ScoringRules, Alerts | Show counter "(3/20)" next to tag list |
| **Inline edit cancel** | Home source rows, Sectors | Add Cancel button + Escape key handler |
| **Translation queued** | After article approval when posting_language=ka | Add toast: "Translation queued for Georgian" |
| **Batch selection count** | Articles page — selected IDs tracked in state but no visible count | Show floating toolbar: "12 selected — Approve / Reject" |

**Acceptance criteria:**
- No async button exists without a loading state
- No destructive action completes without success or error toast
- No filtered view exists without a visible filter summary
- All inline edit interactions support Enter (save) and Escape (cancel)

---

### 3.4 Visual Consistency Pass

#### 3.4.1 Color Palette

Standardize on a single accent color for interactive elements across all pages.

| Element | Current (inconsistent) | Target |
|---------|----------------------|--------|
| Active tab underline | `cyan-400` on some pages, `emerald-400` on others | Pick one — apply everywhere |
| Primary button fill | `emerald-500`, `emerald-600`, `cyan-600`, `slate-100` | Single primary color |
| Success indicator | `emerald-200`, `emerald-300`, `emerald-500/20` (mixed shades) | Single success shade |
| Danger indicator | `red-500/20`, `red-600`, `red-700` (mixed) | Single danger shade |
| Warning indicator | `amber-300`, `amber-500/10`, `amber-500/30` (mixed opacity) | Single warning shade |

#### 3.4.2 Spacing Scale

Define and enforce a consistent spacing rhythm.

| Element | Current (random) | Target |
|---------|-----------------|--------|
| Section padding | `p-5`, `p-6`, `p-8` | Pick one (recommend `p-6`) |
| Gap between sections | `gap-3`, `gap-4`, `gap-6`, `gap-10` | Standardize (`gap-6` for page sections, `gap-4` within sections) |
| Form input height | `py-1`, `py-2`, `py-2.5` | Single height (`py-2` for standard, `py-1.5` for compact) |

#### 3.4.3 Typography Hierarchy

| Level | Current (inconsistent) | Target |
|-------|----------------------|--------|
| Page title | `text-3xl` (Home) vs `text-2xl` (others) | `text-2xl font-semibold tracking-tight` |
| Section title | `text-lg` vs `text-base` | `text-lg font-semibold` |
| Subsection title | Varies | `text-base font-medium` |
| Body text | `text-sm` | `text-sm text-slate-300` |
| Help text | `text-xs text-slate-400` vs `text-sm text-slate-400` | `text-xs text-slate-500` |

#### 3.4.4 Border Radius

| Element | Current | Target |
|---------|---------|--------|
| Cards / sections | `rounded-2xl` | Keep |
| Buttons | `rounded-full` and `rounded-xl` mixed | `rounded-lg` for all action buttons |
| Inputs | `rounded-xl` | Keep |
| Modals | `rounded-2xl` | Keep |
| Tags / badges | `rounded-full` | Keep |

**Acceptance criteria:**
- Single accent color used across all pages for interactive elements
- No more than 3 spacing values used for section padding/gaps
- Typography follows defined 5-level hierarchy
- Border radius follows defined rules (no mixed styles on same element type)

---

### 3.5 Page-Specific Fixes

#### Home (RSS Sources)
- [ ] Restructure "Add Source" form into 3 visual groups: Feed URL, Schedule Config, Advanced
- [ ] Widen signal quality bar chart from 160px to 240px+ or switch to horizontal labeled bars
- [ ] Add row highlight (bg tint) during inline source editing
- [ ] Add Cancel button next to Save during inline edit
- [ ] Add `toast.success("URL copied")` to Copy URL button

#### Articles
- [ ] Add skeleton loader for initial page load (replace blank space)
- [ ] Add ConfirmModal for batch approve/reject with article count
- [ ] Show floating selection toolbar: "{N} selected" with Approve/Reject buttons
- [ ] Add filter summary badge in page header showing active filters
- [ ] Add visual row highlight during inline title/summary editing
- [ ] Add character counter for title (max ~200) and summary fields

#### Monitoring
- [ ] Rewrite pipeline reset modal copy: itemize what gets deleted (articles, deliveries, telemetry, Redis queues) and what's preserved (sectors, sources, scoring rules, social accounts, alert rules)
- [ ] Add tooltip or expandable row for truncated error messages
- [ ] Add tooltip definitions to status filter options ("Stale = no fetch in 2+ hours")

#### Scoring Rules
- [ ] Add visible "Add" button next to each tag input (priorities, ignore, reject keywords)
- [ ] Show tag counter "(3/20)" for priorities/ignore, "(5/50)" for reject keywords
- [ ] Add blur-to-commit for tag inputs (user types, clicks away, tag is added)
- [ ] Add loading indicator on preview pane while generating
- [ ] Add ConfirmModal for "Reset to Defaults" button
- [ ] Add red validation border on auto-approve/reject inputs when values conflict

#### Restrictions (Site Rules)
- [ ] Replace browser `confirm()` on domain delete with ConfirmModal
- [ ] Add virtual scrolling or pagination if domain list exceeds 50 items
- [ ] Show "(using database value)" or "(using env default)" badge next to dedup threshold

#### Alerts
- [ ] Show yellow warning badge next to keywords shorter than 3 characters in real-time (not just on submit)
- [ ] Disable form submit if short-keyword warning is active

#### Digest Settings
- [ ] Collapse default system prompt and translation prompt behind "Show/Edit" expander (currently 20+ lines of text visible by default)
- [ ] Show selected days of week as visual chips/badges
- [ ] Show clear provider-to-model dependency (gray out incompatible model options)

#### Image Template
- [ ] Add "Actual Size" preview option (scrollable container showing 1024x1536 canvas)
- [ ] Add visual grid guides on canvas for text/logo positioning

#### Analytics
- [ ] Add sort direction indicator (arrow icon) next to clickable column headers in source ranking table
- [ ] Add legend for score distribution colors

#### Settings (DB/Telemetry)
- [ ] Auto-format unit conversion (round "4.166... days" to "4 days 4 hours" or round to nearest)
- [ ] Consolidate all TTL configs into a single labeled table

---

### 3.6 Accessibility Baseline

| Requirement | Current state | Fix |
|-------------|--------------|-----|
| ARIA labels on icon buttons | Missing everywhere | Add `aria-label` to every icon-only button (copy, delete, toggle, refresh) |
| ARIA labels on Spinner | Missing | Add `aria-label="Loading"` and `role="status"` |
| Color-only indicators | Green/red/amber dots with no text | Add text label alongside every color dot (e.g., green dot + "Healthy") |
| Focus trapping in modals | Not implemented | Add focus trap (loop Tab within modal, restore focus on close) |
| Keyboard shortcuts for inline edits | Not implemented | Enter = save, Escape = cancel on all inline edit fields |
| Visible focus outlines | Browser default only | Add `focus-visible:ring-2 ring-cyan-400` to all interactive elements |

**Acceptance criteria:**
- Every interactive element has an accessible name (aria-label or visible text)
- Every modal traps focus and restores focus on close
- No information conveyed by color alone — always color + text

---

### 3.7 Responsive / Mobile (Lower Priority)

| Requirement | Fix |
|-------------|-----|
| Mobile navigation | Add hamburger menu collapsing nav items on screens < 768px |
| Article list on mobile | Switch from table/grid to stacked card layout |
| Modals on mobile | Ensure content doesn't overflow viewport (max-h with scroll) |
| Kill switch on mobile | Ensure nav bar kill switch wraps gracefully |

**Note:** This is an operator dashboard primarily used on desktop. Mobile is nice-to-have, not blocking.

---

## 4. Out of Scope

- Backend API changes (all changes are frontend-only)
- New features or pages
- Database schema modifications
- Worker/pipeline logic
- Authentication/authorization flow changes
- Performance optimization (bundle splitting, lazy loading) — separate task

---

## 5. Technical Constraints

- **Framework:** React 19 (no class components, hooks only)
- **Styling:** Tailwind CSS utility classes (no CSS modules, no styled-components)
- **State:** Local component state + URL search params for tabs (no Redux/Zustand)
- **Toast library:** Sonner (already installed, keep using it)
- **Router:** React Router v6+
- **Build:** Vite (HMR in dev, production build < 1MB target)
- **No new dependencies** unless justified (prefer Tailwind-only solutions over UI libraries like Headless UI or Radix)

---

## 6. Priority & Phasing

### Phase 1 — Safety & Foundations (P0-P1)
Shared component kit (Button, ConfirmModal, Tabs, FormField, LoadingButton). Replace all `confirm()`/`alert()` calls. Add confirmation modals to unprotected destructive actions.

### Phase 2 — Feedback & Polish (P2)
Loading skeletons, inline edit improvements, tag input UX, filter indicators, batch selection UI.

### Phase 3 — Visual Consistency (P3)
Color palette unification, spacing/typography/radius audit, empty state component.

### Phase 4 — Accessibility & Responsive (P3-P4)
ARIA labels, focus management, keyboard navigation, mobile nav, responsive tables.

---

## 7. Success Criteria

- [ ] Zero instances of `window.confirm()` or `window.alert()` in codebase
- [ ] Every destructive action has a ConfirmModal with clear explanation
- [ ] Every async operation shows loading, success, and error states
- [ ] Single accent color used across all 12 pages
- [ ] All buttons, tabs, form fields use shared components
- [ ] ARIA labels on every icon button, spinner, and status indicator
- [ ] Build compiles with zero TypeScript errors
- [ ] Frontend bundle stays under 1.2MB (current: 967KB)
