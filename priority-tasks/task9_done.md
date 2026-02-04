# Task 9: Facebook & LinkedIn Integration

## Overview

Add Facebook and LinkedIn posting support using the same env-based credential pattern as Telegram. One account per platform, credentials in `.env`, templates customizable via UI.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  .env file                                                                  │
│  ──────────                                                                 │
│  TELEGRAM_BOT_TOKEN=...        ← Existing                                   │
│  TELEGRAM_CHAT_ID=...          ← Existing                                   │
│                                                                             │
│  FB_PAGE_ID=...                ← New                                        │
│  FB_ACCESS_TOKEN=...           ← New                                        │
│                                                                             │
│  LINKEDIN_ORG_ID=...           ← New                                        │
│  LINKEDIN_ACCESS_TOKEN=...     ← New                                        │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Worker Startup (index.ts)                                                  │
│  ─────────────────────────                                                  │
│  - Read env vars                                                            │
│  - Create providers for each configured platform                            │
│  - Pass to distribution worker                                              │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Distribution Worker                                                        │
│  ───────────────────                                                        │
│  Per article:                                                               │
│  - Check which platforms are enabled (app_config)                           │
│  - Fetch template from social_accounts table                                │
│  - Post to each enabled platform                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Environment Variables

### 1.1 Update Env Schema

**File:** `packages/shared/src/schemas/env.ts`

```typescript
// Add to baseEnvSchema
FB_PAGE_ID: z.string().optional(),
FB_ACCESS_TOKEN: z.string().optional(),
LINKEDIN_ORG_ID: z.string().optional(),
LINKEDIN_ACCESS_TOKEN: z.string().optional(),
```

### 1.2 Update .env.example

**File:** `.env.example`

```env
# ─── Social Platforms ─────────────────────────────────────────────────────────

# Telegram (existing)
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=-1001234567890

# Facebook Page
# Get from: https://developers.facebook.com/tools/explorer/
FB_PAGE_ID=your-page-id
FB_ACCESS_TOKEN=your-page-access-token

# LinkedIn Organization
# Get from: https://www.linkedin.com/developers/
LINKEDIN_ORG_ID=your-org-id
LINKEDIN_ACCESS_TOKEN=your-access-token
```

### 1.3 Implementation Checklist

- [ ] Add FB_* vars to env schema
- [ ] Add LINKEDIN_* vars to env schema
- [ ] Update .env.example with documentation
- [ ] Run `npm run build` in shared package

---

## Phase 2: Facebook Provider Implementation

### 2.1 Implement Facebook Graph API

**File:** `packages/social/src/providers/facebook.ts`

```typescript
import { getDefaultTemplate, type PostTemplateConfig } from "@watch-tower/shared";
import type { SocialProvider, PostRequest, PostResult, ArticleForPost } from "../types.js";

export type FacebookConfig = {
  pageId: string;
  accessToken: string;
};

const GRAPH_API_VERSION = "v18.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export const createFacebookProvider = (config: FacebookConfig): SocialProvider => {
  const { pageId, accessToken } = config;

  return {
    name: "facebook",

    async post(request: PostRequest): Promise<PostResult> {
      try {
        const url = `${GRAPH_API_BASE}/${pageId}/feed`;

        const body: Record<string, string> = {
          message: request.text,
          access_token: accessToken,
        };

        // Extract URL from text for link preview
        const urlMatch = request.text.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
          body.link = urlMatch[0];
        }

        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(body),
        });

        const result = await response.json();

        if (!response.ok || result.error) {
          return {
            platform: "facebook",
            postId: "",
            success: false,
            error: result.error?.message || `HTTP ${response.status}`,
          };
        }

        return {
          platform: "facebook",
          postId: result.id,
          success: true,
        };
      } catch (err) {
        return {
          platform: "facebook",
          postId: "",
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        };
      }
    },

    formatPost(article: ArticleForPost, template: PostTemplateConfig): string {
      const parts: string[] = [];

      if (template.showBreakingLabel) {
        parts.push(`${template.breakingEmoji} ${template.breakingText}`);
      }

      if (template.showTitle) {
        parts.push(article.title);
      }

      if (template.showSummary && article.summary) {
        // Facebook: shorter text, link preview does heavy lifting
        const truncated = article.summary.length > 200
          ? article.summary.slice(0, 197) + "..."
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
      const items = articles.map((a, i) => `${i + 1}. ${a.title}`).join("\n");
      return `📰 ${sector.toUpperCase()} DIGEST\n\n${items}`;
    },
  };
};
```

### 2.2 Facebook Setup Guide

**How to get Facebook credentials:**

1. Go to [Facebook Developers](https://developers.facebook.com/)
2. Create an app (Business type)
3. Add "Facebook Login" product
4. Go to Tools → Graph API Explorer
5. Select your app and page
6. Generate Page Access Token with `pages_manage_posts` permission
7. Copy Page ID from your Facebook Page → About → Page ID

**Token expiration:** Page Access Tokens can be long-lived (~60 days) or permanent if using System User.

### 2.3 Implementation Checklist

- [ ] Implement `post()` method with Graph API
- [ ] Test with real Page Access Token
- [ ] Handle error responses
- [ ] Verify link preview works

---

## Phase 3: LinkedIn Provider Implementation

### 3.1 Implement LinkedIn API

**File:** `packages/social/src/providers/linkedin.ts`

```typescript
import { getDefaultTemplate, type PostTemplateConfig } from "@watch-tower/shared";
import type { SocialProvider, PostRequest, PostResult, ArticleForPost } from "../types.js";

export type LinkedInConfig = {
  organizationId: string;
  accessToken: string;
};

const LINKEDIN_API_BASE = "https://api.linkedin.com/v2";

export const createLinkedInProvider = (config: LinkedInConfig): SocialProvider => {
  const { organizationId, accessToken } = config;

  return {
    name: "linkedin",

    async post(request: PostRequest): Promise<PostResult> {
      try {
        const authorUrn = `urn:li:organization:${organizationId}`;

        // Extract URL if present
        const urlMatch = request.text.match(/https?:\/\/[^\s]+/);
        const textWithoutUrl = request.text.replace(/https?:\/\/[^\s]+/g, "").trim();

        const postBody = {
          author: authorUrn,
          lifecycleState: "PUBLISHED",
          specificContent: {
            "com.linkedin.ugc.ShareContent": {
              shareCommentary: {
                text: textWithoutUrl,
              },
              shareMediaCategory: urlMatch ? "ARTICLE" : "NONE",
              ...(urlMatch && {
                media: [{
                  status: "READY",
                  originalUrl: urlMatch[0],
                }],
              }),
            },
          },
          visibility: {
            "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
          },
        };

        const response = await fetch(`${LINKEDIN_API_BASE}/ugcPosts`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "X-Restli-Protocol-Version": "2.0.0",
          },
          body: JSON.stringify(postBody),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          return {
            platform: "linkedin",
            postId: "",
            success: false,
            error: error.message || `HTTP ${response.status}`,
          };
        }

        const postId = response.headers.get("x-restli-id") || "";
        return {
          platform: "linkedin",
          postId,
          success: true,
        };
      } catch (err) {
        return {
          platform: "linkedin",
          postId: "",
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        };
      }
    },

    formatPost(article: ArticleForPost, template: PostTemplateConfig): string {
      const parts: string[] = [];

      // LinkedIn: Professional tone, typically no breaking labels
      if (template.showTitle) {
        parts.push(article.title);
      }

      if (template.showSummary && article.summary) {
        parts.push(article.summary);
      }

      if (template.showSectorTag) {
        parts.push(`#${article.sector.replace(/\s+/g, "")}`);
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
      return `${sector} Industry Update\n\n${items}`;
    },
  };
};
```

### 3.2 LinkedIn Setup Guide

**How to get LinkedIn credentials:**

1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/)
2. Create an app
3. Request `w_organization_social` permission (requires company page admin)
4. Complete OAuth 2.0 flow to get access token
5. Organization ID: from company page URL (`linkedin.com/company/12345678`)

**Token expiration:** LinkedIn tokens expire after 60 days. Need to refresh or re-authorize.

### 3.3 Implementation Checklist

- [ ] Implement `post()` method with LinkedIn API
- [ ] Test with real Organization Access Token
- [ ] Handle error responses
- [ ] Verify article link card works

---

## Phase 4: Worker Integration

### 4.1 Update Worker Startup

**File:** `packages/worker/src/index.ts`

```typescript
// Add Facebook provider (if configured)
const facebookConfig = env.FB_PAGE_ID && env.FB_ACCESS_TOKEN
  ? { pageId: env.FB_PAGE_ID, accessToken: env.FB_ACCESS_TOKEN }
  : undefined;

// Add LinkedIn provider (if configured)
const linkedinConfig = env.LINKEDIN_ORG_ID && env.LINKEDIN_ACCESS_TOKEN
  ? { organizationId: env.LINKEDIN_ORG_ID, accessToken: env.LINKEDIN_ACCESS_TOKEN }
  : undefined;

// Update distribution worker deps
const distributionWorker = createDistributionWorker({
  connection,
  db,
  telegramConfig: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
    ? { botToken: env.TELEGRAM_BOT_TOKEN, defaultChatId: env.TELEGRAM_CHAT_ID }
    : undefined,
  facebookConfig,
  linkedinConfig,
  eventPublisher,
});

// Log which platforms are enabled
if (facebookConfig) logger.info("[worker] facebook enabled");
if (linkedinConfig) logger.info("[worker] linkedin enabled");
```

### 4.2 Update Distribution Worker

**File:** `packages/worker/src/processors/distribution.ts`

```typescript
import {
  createTelegramProvider,
  createFacebookProvider,
  createLinkedInProvider,
  type TelegramConfig,
  type FacebookConfig,
  type LinkedInConfig,
} from "@watch-tower/social";

type DistributionDeps = {
  connection: { host: string; port: number };
  db: Database;
  telegramConfig?: TelegramConfig;
  facebookConfig?: FacebookConfig;
  linkedinConfig?: LinkedInConfig;
  eventPublisher: EventPublisher;
};

export const createDistributionWorker = ({
  connection,
  db,
  telegramConfig,
  facebookConfig,
  linkedinConfig,
  eventPublisher,
}: DistributionDeps) => {
  // Create providers at startup
  const telegram = telegramConfig ? createTelegramProvider(telegramConfig) : null;
  const facebook = facebookConfig ? createFacebookProvider(facebookConfig) : null;
  const linkedin = linkedinConfig ? createLinkedInProvider(linkedinConfig) : null;

  return new Worker(QUEUE_DISTRIBUTION, async (job) => {
    if (job.name === JOB_DISTRIBUTION_IMMEDIATE) {
      const { articleId } = job.data;

      // ... existing article fetch logic ...

      const results: { platform: string; success: boolean; postId?: string; error?: string }[] = [];

      // Post to each enabled platform
      const platforms = [
        { name: "telegram", provider: telegram, enabled: await isTelegramEnabled(db) },
        { name: "facebook", provider: facebook, enabled: await isFacebookEnabled(db) },
        { name: "linkedin", provider: linkedin, enabled: await isLinkedInEnabled(db) },
      ];

      for (const { name, provider, enabled } of platforms) {
        if (!provider || !enabled) continue;

        // Fetch template for this platform
        const template = await getTemplateForPlatform(db, name);

        // Format post
        const text = provider.formatPost({
          title: article.title,
          summary: article.llmSummary || article.title,
          url: article.url,
          sector: article.sectorName || "News",
        }, template);

        // Post
        const result = await provider.post({ text });
        results.push({ platform: name, ...result });

        if (result.success) {
          await eventPublisher.publish({
            type: "article:posted",
            data: { id: articleId, platform: name, postId: result.postId },
          });
          logger.info({ articleId, platform: name, postId: result.postId }, "[distribution] posted");
        } else {
          logger.error({ articleId, platform: name, error: result.error }, "[distribution] failed");
        }
      }

      // Mark article as posted if at least one succeeded
      if (results.some(r => r.success)) {
        await db.execute(sql`
          UPDATE articles
          SET pipeline_stage = 'posted', approved_at = COALESCE(approved_at, NOW())
          WHERE id = ${articleId}::uuid
        `);
      }

      return { results };
    }
  });
};

// Helper: Check if platform is enabled in app_config
async function isTelegramEnabled(db: Database): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT value FROM app_config WHERE key = 'telegram_auto_post_enabled'
  `);
  return result.rows[0]?.value === true;
}

async function isFacebookEnabled(db: Database): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT value FROM app_config WHERE key = 'facebook_auto_post_enabled'
  `);
  return result.rows[0]?.value === true;
}

async function isLinkedInEnabled(db: Database): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT value FROM app_config WHERE key = 'linkedin_auto_post_enabled'
  `);
  return result.rows[0]?.value === true;
}

// Helper: Get template for platform
async function getTemplateForPlatform(db: Database, platform: string): Promise<PostTemplateConfig> {
  const result = await db.execute(sql`
    SELECT post_template as "postTemplate"
    FROM social_accounts
    WHERE platform = ${platform} AND is_active = true
    LIMIT 1
  `);
  return (result.rows[0] as any)?.postTemplate ?? getDefaultTemplate(platform);
}
```

### 4.3 Implementation Checklist

- [ ] Add facebookConfig and linkedinConfig to worker deps
- [ ] Create providers at startup
- [ ] Update distribution worker for multi-platform
- [ ] Add platform enable/disable checks
- [ ] Test posting to all three platforms

---

## Phase 5: Enable UI Toggles

### 5.1 Seed app_config Keys

**File:** `packages/db/seed.sql`

```sql
-- Platform auto-post toggles
INSERT INTO app_config (key, value, updated_at) VALUES
  ('telegram_auto_post_enabled', 'true', NOW()),
  ('facebook_auto_post_enabled', 'false', NOW()),
  ('linkedin_auto_post_enabled', 'false', NOW())
ON CONFLICT (key) DO NOTHING;
```

### 5.2 Seed Social Accounts for Templates

```sql
-- Facebook account (for template customization)
INSERT INTO social_accounts (platform, account_name, credentials, is_active, rate_limit_per_hour) VALUES
  ('facebook', 'Company Facebook Page', '{}', true, 4)
ON CONFLICT DO NOTHING;

-- LinkedIn account (for template customization)
INSERT INTO social_accounts (platform, account_name, credentials, is_active, rate_limit_per_hour) VALUES
  ('linkedin', 'Company LinkedIn', '{}', true, 4)
ON CONFLICT DO NOTHING;
```

### 5.3 Update ScoringRules.tsx

**File:** `packages/frontend/src/pages/ScoringRules.tsx`

Remove `disabled` and `opacity-50` from Facebook and LinkedIn toggles.

### 5.4 Implementation Checklist

- [ ] Add app_config keys to seed.sql
- [ ] Add Facebook/LinkedIn rows to social_accounts seed
- [ ] Remove disabled state from UI toggles
- [ ] Wire toggles to app_config API
- [ ] Run seed

---

## Phase 6: Update Maintenance Worker

### 6.1 Scheduled Posts Multi-Platform

**File:** `packages/worker/src/processors/maintenance.ts`

Same pattern as distribution worker - check which platforms are enabled, post to each.

### 6.2 Implementation Checklist

- [ ] Update maintenance worker to support multi-platform
- [ ] Use same template fetching logic
- [ ] Test scheduled posts to all platforms

---

## Files Summary

| Action | Package | File |
|--------|---------|------|
| Modify | shared | `src/schemas/env.ts` |
| Modify | social | `src/providers/facebook.ts` (implement post) |
| Modify | social | `src/providers/linkedin.ts` (implement post) |
| Modify | worker | `src/index.ts` (add configs) |
| Modify | worker | `src/processors/distribution.ts` (multi-platform) |
| Modify | worker | `src/processors/maintenance.ts` (multi-platform) |
| Modify | db | `seed.sql` (app_config + accounts) |
| Modify | frontend | `src/pages/ScoringRules.tsx` (enable toggles) |

## Environment Variables

```env
# Add to .env
FB_PAGE_ID=your-page-id
FB_ACCESS_TOKEN=your-page-access-token
LINKEDIN_ORG_ID=your-org-id
LINKEDIN_ACCESS_TOKEN=your-access-token
```

## Testing Checklist

- [ ] Telegram posting still works
- [ ] Facebook posting works with valid token
- [ ] LinkedIn posting works with valid token
- [ ] Platform toggles enable/disable posting
- [ ] Templates customize each platform's format
- [ ] Scheduled posts work for all platforms
- [ ] Partial failure handled (1 platform fails, others succeed)
