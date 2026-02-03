# Task 8: Modular Post Templates (Per-Platform)

## Overview

Make social media post content modular and customizable per platform. Each platform (Telegram, Facebook, LinkedIn) gets its own template configuration with toggleable components.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Config scope | Per-platform | Each platform has different limits, audiences, conventions |
| LLM usage | None (template assembly) | Cost-efficient, same facts just different presentation |
| Storage | `social_accounts.post_template` JSONB | Natural fit, one row per platform |
| Default | All components enabled | Can be customized down from full format |
| Images | Toggle placeholder now, implement later | Future-proof without blocking |

## Post Components

| # | Component | Field Name | Description |
|---|-----------|------------|-------------|
| 1 | Breaking Label | `showBreakingLabel` | "BREAKING:" prefix |
| 2 | Breaking Emoji | `breakingEmoji` | Emoji before label (default: "🔴") |
| 3 | Sector Tag | `showSectorTag` | "BIOTECH", "CRYPTO", etc. |
| 4 | Title | `showTitle` | Article title |
| 5 | Summary | `showSummary` | LLM-generated summary |
| 6 | URL | `showUrl` | Link to article |
| 7 | URL Text | `urlLinkText` | Link text (default: "Read more →") |
| 8 | Image | `showImage` | AI-generated image (future) |

## Platform Defaults

| Component | Telegram | LinkedIn | Facebook |
|-----------|:--------:|:--------:|:--------:|
| Breaking Label | ✅ | ❌ | ❌ |
| Breaking Emoji | 🔴 | - | - |
| Sector Tag | ✅ | ❌ | ❌ |
| Title | ✅ | ✅ | ✅ |
| Summary | ✅ | ✅ | ❌ |
| URL | ✅ | ✅ | ✅ |
| URL Text | "Read more →" | "🔗 Full article" | "Read more ↓" |
| Image | ✅ | ✅ | ✅ |

**Rationale:**
- **Telegram**: News channel subscribers want full detail
- **LinkedIn**: Professional tone, no "BREAKING" emoji
- **Facebook**: Visual-first, shorter text, image dominant

---

## Phase 1: Database Schema

### 1.1 Add post_template Column to social_accounts

**File:** `packages/db/src/schema.ts`

Add JSONB column to `socialAccounts` table:

```typescript
// In socialAccounts table definition
postTemplate: jsonb("post_template").$type<PostTemplateConfig>(),
```

### 1.2 Create PostTemplateConfig Type

**File:** `packages/shared/src/schemas/post-template.ts`

```typescript
import { z } from "zod";

export const postTemplateSchema = z.object({
  // Content toggles
  showBreakingLabel: z.boolean().default(true),
  showSectorTag: z.boolean().default(true),
  showTitle: z.boolean().default(true),
  showSummary: z.boolean().default(true),
  showUrl: z.boolean().default(true),
  showImage: z.boolean().default(false), // Future: AI-generated images

  // Customization
  breakingEmoji: z.string().max(10).default("🔴"),
  breakingText: z.string().max(20).default("BREAKING"),
  urlLinkText: z.string().max(30).default("Read more →"),
});

export type PostTemplateConfig = z.infer<typeof postTemplateSchema>;

// Platform-specific defaults
export const defaultTemplates: Record<string, PostTemplateConfig> = {
  telegram: {
    showBreakingLabel: true,
    showSectorTag: true,
    showTitle: true,
    showSummary: true,
    showUrl: true,
    showImage: true,
    breakingEmoji: "🔴",
    breakingText: "BREAKING",
    urlLinkText: "Read more →",
  },
  linkedin: {
    showBreakingLabel: false,
    showSectorTag: false,
    showTitle: true,
    showSummary: true,
    showUrl: true,
    showImage: true,
    breakingEmoji: "",
    breakingText: "",
    urlLinkText: "🔗 Full article",
  },
  facebook: {
    showBreakingLabel: false,
    showSectorTag: false,
    showTitle: true,
    showSummary: false,
    showUrl: true,
    showImage: true,
    breakingEmoji: "",
    breakingText: "",
    urlLinkText: "Read more ↓",
  },
};

export const getDefaultTemplate = (platform: string): PostTemplateConfig => {
  return defaultTemplates[platform.toLowerCase()] ?? defaultTemplates.telegram;
};
```

### 1.3 Export from Shared Package

**File:** `packages/shared/src/index.ts`

```typescript
export {
  postTemplateSchema,
  defaultTemplates,
  getDefaultTemplate,
  type PostTemplateConfig,
} from "./schemas/post-template.js";
```

### 1.4 Generate Migration

```bash
npm run db:generate
npm run db:migrate
```

### 1.5 Implementation Checklist

- [ ] Create `packages/shared/src/schemas/post-template.ts`
- [ ] Export from `packages/shared/src/index.ts`
- [ ] Add `postTemplate` column to `socialAccounts` in schema
- [ ] Generate and run migration
- [ ] Run `npm run build` to verify

---

## Phase 2: Social Provider Refactor

### 2.1 Update SocialProvider Interface

**File:** `packages/social/src/types.ts`

```typescript
import type { PostTemplateConfig } from "@watch-tower/shared";

export type PostRequest = {
  text: string;
  imageUrl?: string;
};

export type PostResult = {
  platform: string;
  postId: string;
  success: boolean;
  error?: string;
};

export type ArticleForPost = {
  title: string;
  summary: string;
  url: string;
  sector: string;
};

export interface SocialProvider {
  readonly name: string;
  post(request: PostRequest): Promise<PostResult>;

  // Updated: template-aware formatting
  formatPost(article: ArticleForPost, template: PostTemplateConfig): string;

  // Legacy methods (keep for backward compat, delegate to formatPost internally)
  formatSinglePost(article: ArticleForPost): string;
  formatDigestPost(articles: ArticleForPost[], sector: string): string;
}
```

### 2.2 Update Telegram Provider

**File:** `packages/social/src/providers/telegram.ts`

Replace `formatSinglePost` with template-aware version:

```typescript
import { getDefaultTemplate, type PostTemplateConfig } from "@watch-tower/shared";

// Inside createTelegramProvider:

formatPost(article: ArticleForPost, template: PostTemplateConfig): string {
  const parts: string[] = [];

  // 1. Breaking label + Sector tag (first line)
  if (template.showBreakingLabel || template.showSectorTag) {
    let header = "";
    if (template.showBreakingLabel) {
      header += `${template.breakingEmoji} ${template.breakingText}`;
      if (template.showSectorTag) {
        header += `: ${escapeHtml(article.sector.toUpperCase())}`;
      }
    } else if (template.showSectorTag) {
      header += `📰 ${escapeHtml(article.sector.toUpperCase())}`;
    }
    parts.push(`<b>${header}</b>`);
  }

  // 2. Title
  if (template.showTitle) {
    parts.push(`<b>${escapeHtml(article.title)}</b>`);
  }

  // 3. Summary
  if (template.showSummary && article.summary) {
    parts.push(escapeHtml(article.summary));
  }

  // 4. URL
  if (template.showUrl) {
    parts.push(`<a href="${escapeUrl(article.url)}">${escapeHtml(template.urlLinkText)}</a>`);
  }

  return parts.join("\n\n");
},

// Legacy method delegates to new one with default template
formatSinglePost(article: ArticleForPost): string {
  return this.formatPost(article, getDefaultTemplate("telegram"));
},
```

### 2.3 Create LinkedIn Provider Stub

**File:** `packages/social/src/providers/linkedin.ts`

```typescript
import { getDefaultTemplate, type PostTemplateConfig } from "@watch-tower/shared";
import type { SocialProvider, PostRequest, PostResult, ArticleForPost } from "../types.js";

export type LinkedInConfig = {
  accessToken: string;
  organizationId: string;
};

export const createLinkedInProvider = (config: LinkedInConfig): SocialProvider => {
  return {
    name: "linkedin",

    async post(request: PostRequest): Promise<PostResult> {
      // TODO: Implement LinkedIn API posting
      return {
        platform: "linkedin",
        postId: "",
        success: false,
        error: "LinkedIn posting not implemented yet",
      };
    },

    formatPost(article: ArticleForPost, template: PostTemplateConfig): string {
      const parts: string[] = [];

      // LinkedIn: No HTML, plain text only
      if (template.showTitle) {
        parts.push(article.title);
      }

      if (template.showSummary && article.summary) {
        parts.push(article.summary);
      }

      if (template.showUrl) {
        parts.push(`${template.urlLinkText}: ${article.url}`);
      }

      return parts.join("\n\n");
    },

    formatSinglePost(article: ArticleForPost): string {
      return this.formatPost(article, getDefaultTemplate("linkedin"));
    },

    formatDigestPost(articles: ArticleForPost[], sector: string): string {
      const items = articles
        .map((a, i) => `${i + 1}. ${a.title}\n   ${a.url}`)
        .join("\n\n");
      return `${sector.toUpperCase()} DIGEST\n\n${items}`;
    },
  };
};
```

### 2.4 Create Facebook Provider Stub

**File:** `packages/social/src/providers/facebook.ts`

```typescript
import { getDefaultTemplate, type PostTemplateConfig } from "@watch-tower/shared";
import type { SocialProvider, PostRequest, PostResult, ArticleForPost } from "../types.js";

export type FacebookConfig = {
  pageId: string;
  accessToken: string;
};

export const createFacebookProvider = (config: FacebookConfig): SocialProvider => {
  return {
    name: "facebook",

    async post(request: PostRequest): Promise<PostResult> {
      // TODO: Implement Facebook Graph API posting
      return {
        platform: "facebook",
        postId: "",
        success: false,
        error: "Facebook posting not implemented yet",
      };
    },

    formatPost(article: ArticleForPost, template: PostTemplateConfig): string {
      const parts: string[] = [];

      // Facebook: Short, punchy, image-focused
      if (template.showTitle) {
        parts.push(article.title);
      }

      // Facebook typically skips long summary, relies on link preview
      if (template.showSummary && article.summary) {
        // Truncate for Facebook
        const truncated = article.summary.length > 150
          ? article.summary.slice(0, 147) + "..."
          : article.summary;
        parts.push(truncated);
      }

      if (template.showUrl) {
        parts.push(`${template.urlLinkText}\n${article.url}`);
      }

      return parts.join("\n\n");
    },

    formatSinglePost(article: ArticleForPost): string {
      return this.formatPost(article, getDefaultTemplate("facebook"));
    },

    formatDigestPost(articles: ArticleForPost[], sector: string): string {
      const items = articles
        .map((a, i) => `${i + 1}. ${a.title}`)
        .join("\n");
      return `📰 ${sector.toUpperCase()} DIGEST\n\n${items}`;
    },
  };
};
```

### 2.5 Export New Providers

**File:** `packages/social/src/index.ts`

```typescript
export * from "./types.js";
export { createTelegramProvider, type TelegramConfig } from "./providers/telegram.js";
export { createLinkedInProvider, type LinkedInConfig } from "./providers/linkedin.js";
export { createFacebookProvider, type FacebookConfig } from "./providers/facebook.js";
```

### 2.6 Implementation Checklist

- [ ] Update `SocialProvider` interface in types.ts
- [ ] Add `formatPost` method to Telegram provider
- [ ] Create LinkedIn provider stub
- [ ] Create Facebook provider stub
- [ ] Export new providers from index.ts
- [ ] Run `npm run build` in social package

---

## Phase 3: API Endpoints

### 3.1 Add Post Template Routes

**File:** `packages/api/src/routes/social-accounts.ts` (create or extend)

```typescript
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { Database } from "@watch-tower/db";
import { socialAccounts } from "@watch-tower/db";
import {
  postTemplateSchema,
  getDefaultTemplate,
  type PostTemplateConfig,
} from "@watch-tower/shared";

type Deps = { db: Database };

export function registerSocialAccountRoutes(app: FastifyInstance, { db }: Deps) {
  // ─────────────────────────────────────────────────────────────────────────────
  // GET /social-accounts - List all configured accounts with templates
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/social-accounts", async () => {
    const accounts = await db.select().from(socialAccounts);

    return accounts.map((a) => ({
      id: a.id,
      platform: a.platform,
      name: a.name,
      is_active: a.isActive,
      post_template: a.postTemplate ?? getDefaultTemplate(a.platform),
      created_at: a.createdAt,
      updated_at: a.updatedAt,
    }));
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /social-accounts/:id/template - Get template for specific account
  // ─────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/social-accounts/:id/template",
    async (req, reply) => {
      const { id } = req.params;

      const [account] = await db
        .select()
        .from(socialAccounts)
        .where(eq(socialAccounts.id, id));

      if (!account) {
        return reply.status(404).send({ error: "Social account not found" });
      }

      const template = account.postTemplate ?? getDefaultTemplate(account.platform);

      return {
        platform: account.platform,
        template,
        is_default: !account.postTemplate,
      };
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // PUT /social-accounts/:id/template - Save template for specific account
  // ─────────────────────────────────────────────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: { template: unknown };
  }>("/social-accounts/:id/template", async (req, reply) => {
    const { id } = req.params;
    const { template } = req.body;

    // Validate template
    const parsed = postTemplateSchema.safeParse(template);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid template configuration",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    // Verify account exists
    const [account] = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.id, id));

    if (!account) {
      return reply.status(404).send({ error: "Social account not found" });
    }

    // Update template
    await db
      .update(socialAccounts)
      .set({
        postTemplate: parsed.data,
        updatedAt: new Date(),
      })
      .where(eq(socialAccounts.id, id));

    return {
      success: true,
      platform: account.platform,
      template: parsed.data,
    };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // DELETE /social-accounts/:id/template - Reset to platform default
  // ─────────────────────────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    "/social-accounts/:id/template",
    async (req, reply) => {
      const { id } = req.params;

      const [account] = await db
        .select()
        .from(socialAccounts)
        .where(eq(socialAccounts.id, id));

      if (!account) {
        return reply.status(404).send({ error: "Social account not found" });
      }

      // Set to null (will use platform default)
      await db
        .update(socialAccounts)
        .set({
          postTemplate: null,
          updatedAt: new Date(),
        })
        .where(eq(socialAccounts.id, id));

      return {
        success: true,
        message: "Reset to platform default",
        template: getDefaultTemplate(account.platform),
      };
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /social-accounts/preview - Preview formatted post
  // ─────────────────────────────────────────────────────────────────────────────
  app.post<{
    Body: {
      platform: string;
      template: unknown;
      article: {
        title: string;
        summary: string;
        url: string;
        sector: string;
      };
    };
  }>("/social-accounts/preview", async (req, reply) => {
    const { platform, template, article } = req.body;

    // Validate template
    const parsedTemplate = postTemplateSchema.safeParse(template);
    if (!parsedTemplate.success) {
      return reply.status(400).send({
        error: "Invalid template",
        details: parsedTemplate.error.flatten().fieldErrors,
      });
    }

    // Validate article has required fields
    if (!article?.title || !article?.url || !article?.sector) {
      return reply.status(400).send({
        error: "Article must have title, url, and sector",
      });
    }

    // Import and use the appropriate provider's format method
    // For preview, we'll build the text inline to avoid provider instantiation
    const t = parsedTemplate.data;
    const parts: string[] = [];

    if (platform === "telegram") {
      // Telegram HTML format
      if (t.showBreakingLabel || t.showSectorTag) {
        let header = "";
        if (t.showBreakingLabel) {
          header += `${t.breakingEmoji} ${t.breakingText}`;
          if (t.showSectorTag) header += `: ${article.sector.toUpperCase()}`;
        } else if (t.showSectorTag) {
          header += `📰 ${article.sector.toUpperCase()}`;
        }
        parts.push(`<b>${header}</b>`);
      }
      if (t.showTitle) parts.push(`<b>${article.title}</b>`);
      if (t.showSummary && article.summary) parts.push(article.summary);
      if (t.showUrl) parts.push(`<a href="${article.url}">${t.urlLinkText}</a>`);
    } else {
      // Plain text for LinkedIn/Facebook
      if (t.showBreakingLabel) {
        parts.push(`${t.breakingEmoji} ${t.breakingText}: ${article.sector.toUpperCase()}`);
      }
      if (t.showTitle) parts.push(article.title);
      if (t.showSummary && article.summary) parts.push(article.summary);
      if (t.showUrl) parts.push(`${t.urlLinkText}: ${article.url}`);
    }

    return {
      platform,
      formatted_text: parts.join("\n\n"),
      char_count: parts.join("\n\n").length,
    };
  });
}
```

### 3.2 Register Routes

**File:** `packages/api/src/server.ts`

```typescript
import { registerSocialAccountRoutes } from "./routes/social-accounts.js";

// In server setup:
registerSocialAccountRoutes(app, { db });
```

### 3.3 Implementation Checklist

- [ ] Create `packages/api/src/routes/social-accounts.ts`
- [ ] Register routes in server.ts
- [ ] Run `npm run build` in api package
- [ ] Test endpoints:
  - [ ] `GET /social-accounts` returns list with templates
  - [ ] `GET /social-accounts/:id/template` returns template
  - [ ] `PUT /social-accounts/:id/template` saves template
  - [ ] `DELETE /social-accounts/:id/template` resets to default
  - [ ] `POST /social-accounts/preview` returns formatted preview

---

## Phase 4: Worker Integration

### 4.1 Update Distribution Worker

**File:** `packages/worker/src/processors/distribution.ts`

Modify to fetch and use template from social_accounts:

```typescript
import { getDefaultTemplate, type PostTemplateConfig } from "@watch-tower/shared";

// In the distribution worker, after fetching article:

// Fetch template for Telegram account
const [telegramAccount] = await db.execute(sql`
  SELECT post_template as "postTemplate"
  FROM social_accounts
  WHERE platform = 'telegram' AND is_active = true
  LIMIT 1
`);

const template: PostTemplateConfig =
  (telegramAccount?.postTemplate as PostTemplateConfig) ??
  getDefaultTemplate("telegram");

// Use template-aware formatting
const text = telegram.formatPost(
  {
    title: article.title,
    summary: article.llmSummary || article.title,
    url: article.url,
    sector: article.sectorName || "News",
  },
  template
);
```

### 4.2 Update Maintenance Worker (Scheduled Posts)

**File:** `packages/worker/src/processors/maintenance.ts`

Same pattern - fetch template before posting scheduled deliveries.

### 4.3 Implementation Checklist

- [ ] Update distribution.ts to fetch and use template
- [ ] Update maintenance.ts for scheduled posts
- [ ] Test posting with custom template
- [ ] Verify fallback to default template works

---

## Phase 5: Frontend UI

### 5.1 Add API Client Functions

**File:** `packages/frontend/src/api.ts`

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// Post Templates
// ─────────────────────────────────────────────────────────────────────────────

export interface PostTemplateConfig {
  showBreakingLabel: boolean;
  showSectorTag: boolean;
  showTitle: boolean;
  showSummary: boolean;
  showUrl: boolean;
  showImage: boolean;
  breakingEmoji: string;
  breakingText: string;
  urlLinkText: string;
}

export interface SocialAccount {
  id: string;
  platform: string;
  name: string;
  is_active: boolean;
  post_template: PostTemplateConfig;
  created_at: string;
  updated_at: string;
}

export async function listSocialAccounts(): Promise<SocialAccount[]> {
  const res = await fetch(`${API_URL}/social-accounts`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to fetch social accounts");
  return res.json();
}

export async function getPostTemplate(
  accountId: string
): Promise<{ platform: string; template: PostTemplateConfig; is_default: boolean }> {
  const res = await fetch(`${API_URL}/social-accounts/${accountId}/template`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to fetch template");
  return res.json();
}

export async function savePostTemplate(
  accountId: string,
  template: PostTemplateConfig
): Promise<{ success: boolean }> {
  const res = await fetch(`${API_URL}/social-accounts/${accountId}/template`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ template }),
  });
  if (!res.ok) throw new Error("Failed to save template");
  return res.json();
}

export async function resetPostTemplate(accountId: string): Promise<void> {
  const res = await fetch(`${API_URL}/social-accounts/${accountId}/template`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to reset template");
}

export async function previewPost(
  platform: string,
  template: PostTemplateConfig,
  article: { title: string; summary: string; url: string; sector: string }
): Promise<{ formatted_text: string; char_count: number }> {
  const res = await fetch(`${API_URL}/social-accounts/preview`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ platform, template, article }),
  });
  if (!res.ok) throw new Error("Failed to preview post");
  return res.json();
}
```

### 5.2 Create Post Template Editor Component

**File:** `packages/frontend/src/components/PostTemplateEditor.tsx`

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Post Template: Telegram                            [Reset to Default]      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────┬───────────────────────────────────────┐│
│  │ COMPONENTS                      │ LIVE PREVIEW                          ││
│  │                                 │                                       ││
│  │ [✓] Breaking Label              │ ┌───────────────────────────────────┐ ││
│  │     Emoji: [🔴    ]             │ │ 🔴 BREAKING: BIOTECH              │ ││
│  │     Text:  [BREAKING ]          │ │                                   │ ││
│  │                                 │ │ FDA Approves New Gene Therapy     │ ││
│  │ [✓] Sector Tag                  │ │                                   │ ││
│  │                                 │ │ The FDA granted approval to       │ ││
│  │ [✓] Title                       │ │ Vertex's gene therapy targeting   │ ││
│  │                                 │ │ sickle cell disease...            │ ││
│  │ [✓] Summary                     │ │                                   │ ││
│  │                                 │ │ Read more →                       │ ││
│  │ [✓] URL Link                    │ └───────────────────────────────────┘ ││
│  │     Text:  [Read more → ]       │                                       ││
│  │                                 │ Character count: 234                  ││
│  │ [ ] Image (Coming Soon)         │                                       ││
│  │                                 │                                       ││
│  └─────────────────────────────────┴───────────────────────────────────────┘│
│                                                                             │
│                                              [Cancel] [Save Template]       │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key features:**
- Toggle switches for each component
- Text inputs for emoji, breaking text, URL text
- Live preview panel (debounced API call)
- Character counter
- Reset to default button
- Save/Cancel actions

### 5.3 Add to Settings Page or Create Dedicated Page

Option A: Add tab to existing Settings page
Option B: Create new `/post-templates` page

**Recommendation:** New page at `/post-templates` with platform selector

### 5.4 Implementation Checklist

- [ ] Add API functions to `api.ts`
- [ ] Create `PostTemplateEditor.tsx` component
- [ ] Create `PostTemplates.tsx` page
- [ ] Add navigation link in Layout
- [ ] Add route in App.tsx
- [ ] Test UI:
  - [ ] Platform switching
  - [ ] Toggle components
  - [ ] Live preview updates
  - [ ] Save works
  - [ ] Reset to default works

---

## Phase 6: Testing

### 6.1 Unit Tests

- [ ] `postTemplateSchema` validates correctly
- [ ] `getDefaultTemplate` returns correct defaults per platform
- [ ] Telegram `formatPost` respects all toggles
- [ ] LinkedIn `formatPost` produces plain text
- [ ] Facebook `formatPost` truncates summary

### 6.2 Integration Tests

- [ ] Save template via API, verify DB updated
- [ ] Distribution worker uses saved template
- [ ] Scheduled post uses saved template
- [ ] Reset template uses platform default

### 6.3 E2E Test Scenarios

| Scenario | Expected |
|----------|----------|
| Post with all toggles ON | Full format with breaking, title, summary, URL |
| Post with only title + URL | Short format, no breaking/summary |
| Post with custom emoji | Uses custom emoji instead of 🔴 |
| Post after reset | Uses platform default |
| Post to platform without saved template | Uses default template |

---

## Files Summary

| Action | Package | File |
|--------|---------|------|
| Create | shared | `src/schemas/post-template.ts` |
| Modify | shared | `src/index.ts` |
| Modify | db | `src/schema.ts` (add column) |
| Modify | social | `src/types.ts` |
| Modify | social | `src/providers/telegram.ts` |
| Create | social | `src/providers/linkedin.ts` |
| Create | social | `src/providers/facebook.ts` |
| Modify | social | `src/index.ts` |
| Create | api | `src/routes/social-accounts.ts` |
| Modify | api | `src/server.ts` |
| Modify | worker | `src/processors/distribution.ts` |
| Modify | worker | `src/processors/maintenance.ts` |
| Modify | frontend | `src/api.ts` |
| Create | frontend | `src/components/PostTemplateEditor.tsx` |
| Create | frontend | `src/pages/PostTemplates.tsx` |
| Modify | frontend | `src/components/Layout.tsx` |
| Modify | frontend | `src/App.tsx` |

## Dependencies

- No new npm packages required
- Uses existing: Zod (shared), Drizzle (db), Fastify (api), React + Tailwind (frontend)

---

## Future: Image Integration

When ready to add AI-generated images:

1. **New queue:** `pipeline:image-gen`
2. **New processor:** Calls DALL-E / Flux / Midjourney API
3. **Storage:** URL in `article_images` table (already exists)
4. **Template toggle:** `showImage: true` enables image attachment
5. **Provider update:** Pass `imageUrl` to `post()` method

The template toggle is already in place - just needs the image generation pipeline.

---

## Implementation Order

1. **Phase 1** - Schema & types (foundation)
2. **Phase 2** - Provider refactor (formatPost method)
3. **Phase 3** - API endpoints (CRUD for templates)
4. **Phase 4** - Worker integration (use templates)
5. **Phase 5** - Frontend UI (editor component)
6. **Phase 6** - Testing

Estimated phases: Can be implemented incrementally, each phase is independently testable.
