# Task 20: AI Image Generation Pipeline

Add AI-generated news card images to social media posts. Generates background images via GPT, overlays Georgian title + XTelo watermark using canvas, stores in Cloudflare R2, and attaches to Telegram/Facebook/LinkedIn posts.

---

## Table of Contents

1. [Requirements Summary](#1-requirements-summary)
2. [Architecture & Pipeline Flow](#2-architecture--pipeline-flow)
3. [Stack Decisions](#3-stack-decisions)
4. [Schema Changes](#4-schema-changes)
5. [Implementation: New Code (B1-B7)](#5-implementation-new-code-b1-b7)
6. [Implementation: Existing Code Changes (A1-A10)](#6-implementation-existing-code-changes-a1-a10)
7. [Frontend: Image Template Page](#7-frontend-image-template-page)
8. [Cloudflare R2 Setup Guide](#8-cloudflare-r2-setup-guide)
9. [Environment Variables](#9-environment-variables)
10. [Change Map](#10-change-map)
11. [Testing Checklist](#11-testing-checklist)

---

## 1. Requirements Summary

### Image Generation

| Setting | Value |
|---------|-------|
| Trigger | Automatic after translation, for approved articles meeting score threshold |
| Provider | `gpt-image-1-mini` via OpenAI API (existing key) |
| Image size | Portrait 1024x1536 |
| Quality | Medium |
| Prompt source | English `llm_summary` (fewer tokens than Georgian) |
| Score threshold | Configurable: default `>= 4` |
| Global toggle | `image_generation_enabled` in app_config |

### Image Composition (News Card)

| Element | Details |
|---------|---------|
| Background | AI-generated image from gpt-image-1-mini |
| Georgian title | Overlaid via @napi-rs/canvas with word wrap |
| Semi-transparent backdrop | Behind title text for readability |
| XTelo watermark | Brand logo, configurable position/scale |
| Text rendering | @napi-rs/canvas (reliable Georgian Unicode via registerFont) |
| Image processing | Sharp (resize, optimize, composite) |

### Storage & Delivery

| Setting | Value |
|---------|-------|
| Storage | Cloudflare R2 (S3-compatible, zero egress cost) |
| URL format | `{R2_PUBLIC_URL}/{uuid}.webp` |
| Cleanup | Maintenance worker deletes R2 objects + DB rows on TTL expiry |
| Default TTL | 30 days (existing `article_images_ttl_days` config) |

### Platform Image Support

| Platform | Method | Status |
|----------|--------|--------|
| Telegram | `sendPhoto` with URL | Already implemented |
| Facebook | `/photos` endpoint with `url` param | Needs implementation |
| LinkedIn | 3-step upload (register → upload binary → post with asset URN) | Needs implementation |

### UI Controls

| Control | Location |
|---------|----------|
| Enable/disable + score threshold | New "Image Template" page |
| Title position, font, color | New "Image Template" page (controls + live preview) |
| Watermark position, scale | New "Image Template" page |
| Backdrop color, opacity, padding | New "Image Template" page |
| Per-platform image on/off | Post Templates page (activate existing "Coming Soon" toggle) |

---

## 2. Architecture & Pipeline Flow

### Pipeline Chaining

```
[Article scored >= threshold]
  → [Translation worker translates to Georgian]
  → [Image generation queue picks up]
    → [Call gpt-image-1-mini with English summary → base64 background]
    → [@napi-rs/canvas: overlay Georgian title + watermark + backdrop]
    → [Sharp: optimize final composite → WebP buffer]
    → [Upload to Cloudflare R2]
    → [Insert article_images row: status='ready', imageUrl=R2 URL]
  → [Queue distribution job]
  → [Distribution worker: fetch article_images.imageUrl, attach to post]
```

### Chaining Decision Logic (in translation.ts)

```
Translation completes for approved article:
  ├─ image_generation_enabled AND score >= min_score?
  │   ├─ YES → queue image generation (image worker chains to distribution)
  │   └─ NO  → queue distribution directly (existing behavior)
```

### Error Handling

- If image generation fails → set `article_images.status = 'failed'`
- Distribution worker still posts → text-only (graceful degradation)
- Image gen does NOT block the posting pipeline

---

## 3. Stack Decisions

| Component | Choice | Rationale |
|-----------|--------|-----------|
| AI image gen | `gpt-image-1-mini` | Built-in LLM reasoning (no prompt crafting step), existing `OPENAI_API_KEY`, $0.011-0.026/image at medium quality |
| Text overlay | `@napi-rs/canvas` | Reliable Georgian Unicode via `registerFont()`, `measureText()` for word wrap, prebuilt Rust binaries (no Cairo deps) |
| Image processing | `sharp` | Fast resize/optimize, composite canvas output onto AI background, WebP export |
| Storage | Cloudflare R2 | S3-compatible API, zero egress cost, durable object storage |
| Image format | WebP | Best compression/quality ratio, supported by all social platforms |
| Font | Noto Sans Georgian (Google Fonts, OFL license) | Free, high quality, full Georgian character coverage |

### Cost Estimate (30 images/day)

| Item | Per Image | Daily | Monthly |
|------|-----------|-------|---------|
| gpt-image-1-mini (medium, 1024x1536) | ~$0.015 | $0.45 | ~$14 |
| R2 storage (~150KB WebP x 900/month) | — | — | ~$0.002 |
| R2 operations (Class A writes) | — | — | ~$0.004 |
| **Total** | | | **~$14/month** |

---

## 4. Schema Changes

### A. Modify `article_images` table

**File:** `packages/db/src/schema.ts` (line 228-250)

Add `r2Key` column for R2 object cleanup:

```typescript
export const articleImages = pgTable("article_images", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id")
    .notNull()
    .references(() => articles.id, { onDelete: "cascade" }),

  // Generation details
  provider: text("provider").notNull(),  // 'gpt-image-mini'
  model: text("model"),
  prompt: text("prompt").notNull(),

  // Result
  imageUrl: text("image_url"),
  r2Key: text("r2_key"),               // NEW: R2 object key for cleanup
  status: text("status").notNull().default("pending"),
  errorMessage: text("error_message"),

  // Cost tracking (microdollars)
  costMicrodollars: integer("cost_microdollars"),

  // Timing
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

### B. Image Template Config (stored in app_config as JSONB)

**Key:** `image_template`

```typescript
interface ImageTemplateConfig {
  // Title overlay
  titlePosition: { x: number; y: number };  // percentage-based (0-100)
  titleAlignment: "left" | "center" | "right";
  titleMaxWidth: number;           // percentage of image width (40-90)
  titleFontSize: number;           // px (24-72)
  titleFontFamily: string;         // e.g. "Noto Sans Georgian"
  titleColor: string;              // hex e.g. "#FFFFFF"

  // Backdrop behind title
  backdropEnabled: boolean;
  backdropColor: string;           // hex with alpha e.g. "#000000CC"
  backdropPadding: number;         // px
  backdropBorderRadius: number;    // px

  // XTelo watermark
  watermarkPosition: { x: number; y: number };  // percentage-based
  watermarkScale: number;          // 0.1 - 1.0
}
```

**Default template values:**

```typescript
const DEFAULT_IMAGE_TEMPLATE: ImageTemplateConfig = {
  titlePosition: { x: 10, y: 70 },       // bottom-left area
  titleAlignment: "left",
  titleMaxWidth: 80,                       // 80% of image width
  titleFontSize: 42,
  titleFontFamily: "Noto Sans Georgian",
  titleColor: "#FFFFFF",

  backdropEnabled: true,
  backdropColor: "#000000B3",              // black 70% opacity
  backdropPadding: 24,
  backdropBorderRadius: 12,

  watermarkPosition: { x: 85, y: 5 },     // top-right corner
  watermarkScale: 0.15,
};
```

### C. New app_config keys to seed

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `image_generation_enabled` | boolean | `false` | Global on/off toggle |
| `image_generation_min_score` | number | `4` | Minimum article score to generate image |
| `image_generation_quality` | string | `"medium"` | GPT API quality parameter |
| `image_generation_size` | string | `"1024x1536"` | GPT API size parameter |
| `image_template` | JSONB | See defaults above | Full template configuration |

---

## 5. Implementation: New Code (B1-B7)

### B1. Image Template Zod Schema

**New file:** `packages/shared/src/schemas/image-template.ts`

```typescript
import { z } from "zod";

export const imageTemplateSchema = z.object({
  titlePosition: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) }),
  titleAlignment: z.enum(["left", "center", "right"]).default("left"),
  titleMaxWidth: z.number().min(20).max(100).default(80),
  titleFontSize: z.number().min(16).max(96).default(42),
  titleFontFamily: z.string().default("Noto Sans Georgian"),
  titleColor: z.string().regex(/^#[0-9A-Fa-f]{6,8}$/).default("#FFFFFF"),

  backdropEnabled: z.boolean().default(true),
  backdropColor: z.string().regex(/^#[0-9A-Fa-f]{6,8}$/).default("#000000B3"),
  backdropPadding: z.number().min(0).max(100).default(24),
  backdropBorderRadius: z.number().min(0).max(50).default(12),

  watermarkPosition: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) }),
  watermarkScale: z.number().min(0.05).max(1).default(0.15),
});

export type ImageTemplateConfig = z.infer<typeof imageTemplateSchema>;

export const DEFAULT_IMAGE_TEMPLATE: ImageTemplateConfig = {
  titlePosition: { x: 10, y: 70 },
  titleAlignment: "left",
  titleMaxWidth: 80,
  titleFontSize: 42,
  titleFontFamily: "Noto Sans Georgian",
  titleColor: "#FFFFFF",
  backdropEnabled: true,
  backdropColor: "#000000B3",
  backdropPadding: 24,
  backdropBorderRadius: 12,
  watermarkPosition: { x: 85, y: 5 },
  watermarkScale: 0.15,
};
```

**Export from:** `packages/shared/src/index.ts` — add `export * from "./schemas/image-template.js";`

### B2. R2 Storage Module

**New file:** `packages/worker/src/services/r2-storage.ts`

S3-compatible wrapper using `@aws-sdk/client-s3`:

```typescript
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrl: string;  // e.g. "https://images.yourdomain.com"
}

export function createR2Storage(config: R2Config) {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async uploadImage(buffer: Buffer, key: string, contentType = "image/webp"): Promise<string> {
      await client.send(new PutObjectCommand({
        Bucket: config.bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }));
      return `${config.publicUrl}/${key}`;
    },

    async deleteImage(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({
        Bucket: config.bucketName,
        Key: key,
      }));
    },

    getPublicUrl(key: string): string {
      return `${config.publicUrl}/${key}`;
    },
  };
}

export type R2Storage = ReturnType<typeof createR2Storage>;
```

### B3. Image Composer Service

**New file:** `packages/worker/src/services/image-composer.ts`

Handles canvas text overlay + sharp composite:

```typescript
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import sharp from "sharp";
import path from "path";
import type { ImageTemplateConfig } from "@watch-tower/shared";

// Register Georgian font on module load
const FONT_DIR = path.resolve(__dirname, "../../assets/fonts");
GlobalFonts.registerFromPath(path.join(FONT_DIR, "NotoSansGeorgian-Bold.ttf"), "Noto Sans Georgian");

// Load watermark once
let watermarkBuffer: Buffer | null = null;
async function getWatermark(): Promise<Buffer> {
  if (!watermarkBuffer) {
    watermarkBuffer = await sharp(
      path.resolve(__dirname, "../../assets/watermark/xtelo-logo.png")
    ).png().toBuffer();
  }
  return watermarkBuffer;
}

export async function composeNewsCard(
  backgroundBase64: string,
  georgianTitle: string,
  template: ImageTemplateConfig,
): Promise<Buffer> {
  // 1. Decode AI background and get dimensions
  const bgBuffer = Buffer.from(backgroundBase64, "base64");
  const bgMeta = await sharp(bgBuffer).metadata();
  const width = bgMeta.width!;   // 1024
  const height = bgMeta.height!; // 1536

  // 2. Create canvas overlay (same dimensions as background)
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // 3. Draw Georgian title with word wrap
  const titleX = (template.titlePosition.x / 100) * width;
  const titleY = (template.titlePosition.y / 100) * height;
  const maxWidth = (template.titleMaxWidth / 100) * width;

  ctx.font = `bold ${template.titleFontSize}px "${template.titleFontFamily}"`;
  ctx.fillStyle = template.titleColor;
  ctx.textAlign = template.titleAlignment;

  const lines = wrapText(ctx, georgianTitle, maxWidth);

  // 4. Draw backdrop behind title
  if (template.backdropEnabled) {
    const lineHeight = template.titleFontSize * 1.3;
    const totalTextHeight = lines.length * lineHeight;
    const pad = template.backdropPadding;

    ctx.fillStyle = template.backdropColor;
    roundRect(ctx,
      titleX - pad,
      titleY - template.titleFontSize - pad,
      maxWidth + pad * 2,
      totalTextHeight + pad * 2,
      template.backdropBorderRadius,
    );
    ctx.fill();
    ctx.fillStyle = template.titleColor; // Reset for text
  }

  // 5. Draw text lines
  const lineHeight = template.titleFontSize * 1.3;
  lines.forEach((line, i) => {
    ctx.fillText(line, titleX, titleY + i * lineHeight);
  });

  // 6. Draw watermark
  const wmBuffer = await getWatermark();
  const wmImage = await loadImage(wmBuffer);
  const wmScale = template.watermarkScale;
  const wmWidth = wmImage.width * wmScale;
  const wmHeight = wmImage.height * wmScale;
  const wmX = (template.watermarkPosition.x / 100) * width - wmWidth / 2;
  const wmY = (template.watermarkPosition.y / 100) * height;
  ctx.globalAlpha = 0.8;
  ctx.drawImage(wmImage, wmX, wmY, wmWidth, wmHeight);
  ctx.globalAlpha = 1.0;

  // 7. Export canvas overlay as PNG buffer
  const overlayBuffer = canvas.toBuffer("image/png");

  // 8. Composite: background + overlay → WebP
  const result = await sharp(bgBuffer)
    .composite([{ input: overlayBuffer, top: 0, left: 0 }])
    .webp({ quality: 85 })
    .toBuffer();

  return result;
}

// ─── Helper: Word Wrap ──────────────────────────────────────────────────────

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

// ─── Helper: Rounded Rectangle ──────────────────────────────────────────────

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
```

### B4. Image Generation Processor

**New file:** `packages/worker/src/processors/image-generation.ts`

Factory pattern: `createImageGenerationWorker(deps)` — matches existing workers.

**Per-article flow:**
1. Check `image_generation_enabled` + `image_generation_min_score` from app_config
2. Query articles: `pipeline_stage = 'approved'` AND `score >= min_score` AND no existing `article_images` row with `status IN ('ready', 'generating', 'pending')`
3. For each article (batch of 5 max):
   a. Insert `article_images` row with `status = 'generating'`
   b. Call OpenAI `images.generate()`:
      - model: `gpt-image-1-mini`
      - prompt: English `llm_summary` (or title if no summary)
      - size: from `image_generation_size` config
      - quality: from `image_generation_quality` config
      - response_format: `b64_json`
   c. Call `composeNewsCard(base64, georgianTitle, template)`
   d. Upload to R2: key = `images/{articleId}.webp`
   e. Update `article_images` row: `status = 'ready'`, `imageUrl`, `r2Key`, cost, latency
   f. If auto-post enabled → queue distribution job (staggered)
4. On error: `status = 'failed'`, `error_message`, log, continue to next article

**Queue:** Recurring every 30s (same pattern as translation), or triggered directly from translation worker.

### B5. Queue Constants

**File:** `packages/shared/src/queues.ts`

Add:
```typescript
export const QUEUE_IMAGE_GENERATION = "pipeline-image-generation";
export const JOB_IMAGE_GENERATE = "image-generate";
```

### B6. API Routes for Image Config

**Extend:** `packages/api/src/routes/config.ts`

| Route | Method | Purpose |
|-------|--------|---------|
| `/config/image-generation` | GET | Returns `image_generation_enabled`, `min_score`, `quality`, `size` |
| `/config/image-generation` | PATCH | Upserts all image gen config keys |
| `/config/image-template` | GET | Returns image template JSONB |
| `/config/image-template` | PATCH | Upserts image template JSONB (validated by Zod schema) |

### B7. Frontend: Image Template Page

**New file:** `packages/frontend/src/pages/ImageTemplate.tsx`

See [Section 7](#7-frontend-image-template-page) for detailed UI spec.

---

## 6. Implementation: Existing Code Changes (A1-A10)

### A1. Distribution Worker — Attach Image URL

**File:** `packages/worker/src/processors/distribution.ts` (around line 356-370)

Before formatting the post, query for a ready image:

```typescript
// NEW: Fetch image if available and template.showImage is true
let imageUrl: string | undefined;
if (template.showImage) {
  const [articleImage] = await db
    .select({ imageUrl: articleImages.imageUrl })
    .from(articleImages)
    .where(and(
      eq(articleImages.articleId, articleId),
      eq(articleImages.status, "ready"),
    ))
    .limit(1);
  imageUrl = articleImage?.imageUrl ?? undefined;
}

// Line 370: Pass imageUrl to provider
const postResult = await provider!.post({ text, imageUrl });
```

### A2. Facebook Provider — Image Posting

**File:** `packages/social/src/providers/facebook.ts` (line 59-118)

Add image branch before existing text-only code:

```typescript
async post(request: PostRequest): Promise<PostResult> {
  try {
    if (request.imageUrl) {
      // Upload photo — Facebook downloads from URL
      const url = `${GRAPH_API_BASE}/${pageId}/photos`;
      const body: Record<string, string> = {
        url: request.imageUrl,
        caption: request.text,
        access_token: accessToken,
      };
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      }, timeoutMs);
      const result = await response.json();
      // ... handle response (same pattern as existing)
    }
    // ... existing text-only code
  }
}
```

### A3. LinkedIn Provider — 3-Step Image Upload

**File:** `packages/social/src/providers/linkedin.ts` (line 59-139)

Add image upload before post creation:

```typescript
async post(request: PostRequest): Promise<PostResult> {
  try {
    const authorUrn = `urn:li:${authorType}:${authorId}`;
    let imageAssetUrn: string | undefined;

    if (request.imageUrl) {
      // Step 1: Register upload
      const registerResponse = await fetchWithTimeout(
        `${LINKEDIN_API_BASE}/assets?action=registerUpload`,
        { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, ... },
          body: JSON.stringify({
            registerUploadRequest: {
              recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
              owner: authorUrn,
              serviceRelationships: [{ relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" }],
            },
          }),
        },
        timeoutMs,
      );
      const registerData = await registerResponse.json();
      const uploadUrl = registerData.value.uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"].uploadUrl;
      imageAssetUrn = registerData.value.asset;

      // Step 2: Download image from R2 and upload to LinkedIn
      const imageResponse = await fetch(request.imageUrl);
      const imageBuffer = await imageResponse.arrayBuffer();
      await fetchWithTimeout(uploadUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: Buffer.from(imageBuffer),
      }, timeoutMs);
    }

    // Step 3: Create post with image reference
    const postBody = {
      author: authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: textWithoutUrl },
          shareMediaCategory: imageAssetUrn ? "IMAGE" : (urlMatch ? "ARTICLE" : "NONE"),
          ...(imageAssetUrn && {
            media: [{
              status: "READY",
              media: imageAssetUrn,
            }],
          }),
          ...(!imageAssetUrn && urlMatch && {
            media: [{ status: "READY", originalUrl: urlMatch[0] }],
          }),
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    };
    // ... POST to /ugcPosts (existing)
  }
}
```

### A4. Translation → Image Gen Chaining

**File:** `packages/worker/src/processors/translation.ts` (line 269-298)

Modify auto-post section to check for image generation:

```typescript
// After translation completes for approved article (line 269):
if (article.pipelineStage === "approved" && (distributionQueue || imageQueue)) {
  const imageEnabled = await getBooleanConfig(db, "image_generation_enabled", false);
  const minScore = await getConfigNumber(db, "image_generation_min_score", 4);

  if (imageEnabled && article.score >= minScore && imageQueue) {
    // Queue image generation → it will chain to distribution
    const delay = autoPostIndex * AUTO_POST_STAGGER_MS;
    await imageQueue.add(
      JOB_IMAGE_GENERATE,
      { articleId: article.id },
      { jobId: `img-${article.id}`, delay },
    );
    autoPostIndex++;
    logger.info({ articleId: article.id }, "[translation] queued for image generation");
  } else if (distributionQueue) {
    // No image gen → queue distribution directly (existing behavior)
    // ... existing lines 285-297
  }
}
```

### A5. Worker Registration

**File:** `packages/worker/src/index.ts`

1. Import new constants: `QUEUE_IMAGE_GENERATION`, `JOB_IMAGE_GENERATE`
2. Import `createImageGenerationWorker`
3. Create image generation queue (same options pattern as translation queue)
4. Create image generation worker: `createImageGenerationWorker({ connection, db, distributionQueue, r2Storage })`
5. Pass `imageQueue` to translation worker deps
6. Add recurring job (every 30s) as fallback for missed articles
7. Add graceful shutdown for new worker

### A6. Maintenance Worker — R2 Cleanup

**File:** `packages/worker/src/processors/maintenance.ts` (line 755-764)

Replace simple delete with query-then-delete:

```typescript
// Article images cleanup — delete R2 objects first, then DB rows
try {
  const articleImagesTtlDays = await getConfigNumber(db, "article_images_ttl_days", 30);
  const imagesCutoff = new Date(Date.now() - articleImagesTtlDays * 24 * 60 * 60 * 1000);

  // Query expired images WITH r2Key
  const expiredImages = await db
    .select({ id: articleImages.id, r2Key: articleImages.r2Key })
    .from(articleImages)
    .where(lt(articleImages.createdAt, imagesCutoff));

  // Delete from R2
  if (r2Storage && expiredImages.length > 0) {
    for (const img of expiredImages) {
      if (img.r2Key) {
        await r2Storage.deleteImage(img.r2Key).catch((err) => {
          logger.warn({ r2Key: img.r2Key, error: err }, "[maintenance] R2 delete failed");
        });
      }
    }
  }

  // Delete DB rows
  if (expiredImages.length > 0) {
    await db.delete(articleImages).where(lt(articleImages.createdAt, imagesCutoff));
    logger.info(`[maintenance] cleaned ${expiredImages.length} expired article images`);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error(`[maintenance] article_images cleanup failed: ${msg}`);
  errors.push("article_images");
}
```

### A7. Post Templates — Activate Image Toggle

**File:** `packages/frontend/src/pages/PostTemplates.tsx` (line 390-401)

- Remove `opacity-50`, `disabled`, `cursor-not-allowed`, "(Coming Soon)" label
- Connect toggle to `template.showImage` state (same pattern as other toggles on the page)
- Save persists to `social_accounts.post_template` JSONB

### A8. Schema Migration

**File:** Generate via `npm run db:generate`

```sql
ALTER TABLE article_images ADD COLUMN r2_key TEXT;
```

### A9. Shared Package Export

**File:** `packages/shared/src/index.ts`

Add: `export * from "./schemas/image-template.js";`

### A10. Seed Default Config

**File:** `packages/db/src/seed.ts` (or inline in worker startup)

```typescript
const imageConfigDefaults = [
  { key: "image_generation_enabled", value: false },
  { key: "image_generation_min_score", value: 4 },
  { key: "image_generation_quality", value: "medium" },
  { key: "image_generation_size", value: "1024x1536" },
  { key: "image_template", value: DEFAULT_IMAGE_TEMPLATE },
];

for (const config of imageConfigDefaults) {
  await db.insert(appConfig)
    .values({ key: config.key, value: config.value, updatedAt: new Date() })
    .onConflictDoNothing();
}
```

---

## 7. Frontend: Image Template Page

### Layout: Simple Controls + Live Preview

```
┌──────────────────────────────────────────────────────────────┐
│  Image Template                                               │
├─────────────────────────┬────────────────────────────────────┤
│  CONTROLS (left panel)  │  LIVE PREVIEW (right panel)         │
│                         │                                     │
│  [x] Enable Generation  │  ┌─────────────────────────────┐   │
│  Min Score: [4 ▼]       │  │                             │   │
│                         │  │  [AI background preview]     │   │
│  ── Title Settings ──   │  │                             │   │
│  Position: [Bottom-Left] │  │  ┌───────────────────────┐ │   │
│  X offset: [===●===]    │  │  │ ██████████████████████ │ │   │
│  Y offset: [===●===]    │  │  │ ██ სათაური ტექსტი ██ │ │   │
│  Max width: [===●===]   │  │  │ ██ ეს არის მაგალითი██ │ │   │
│  Font size: [===●===]   │  │  │ ██████████████████████ │ │   │
│  Font: [Noto Sans ▼]    │  │  └───────────────────────┘ │   │
│  Color: [■ #FFFFFF]     │  │                     [logo]  │   │
│                         │  └─────────────────────────────┘   │
│  ── Backdrop ──         │                                     │
│  [x] Enabled            │  Portrait 1024x1536                │
│  Color: [■ #000000]     │  (scaled to fit preview)           │
│  Opacity: [===●===]     │                                     │
│  Padding: [===●===]     │                                     │
│  Radius: [===●===]      │                                     │
│                         │                                     │
│  ── Watermark ──        │                                     │
│  Position: [Top-Right]   │                                     │
│  Scale: [===●===]       │                                     │
│                         │                                     │
│  [Save Template]        │                                     │
└─────────────────────────┴────────────────────────────────────┘
```

### Controls Detail

**Generation Settings:**
- Enable/disable toggle → `image_generation_enabled` in app_config
- Minimum score dropdown (3, 4, 5) → `image_generation_min_score`

**Title Settings:**
- Position presets: dropdown with "Top-Left", "Top-Center", "Center", "Bottom-Left", "Bottom-Center"
- X/Y offset sliders (0-100%, fine-tune from preset)
- Max width slider (40-90% of image width)
- Font size slider (24-72px)
- Font family dropdown: "Noto Sans Georgian", potentially more fonts later
- Color picker (hex)

**Backdrop Settings:**
- Enable/disable toggle
- Color picker with separate opacity slider (0-100%)
- Padding slider (0-60px)
- Border radius slider (0-30px)

**Watermark Settings:**
- Position presets: dropdown with "Top-Left", "Top-Right", "Bottom-Left", "Bottom-Right"
- X/Y offset sliders (fine-tune)
- Scale slider (5-50%)

**Live Preview (right panel):**
- Uses browser-native `<canvas>` API (mirrors @napi-rs/canvas logic)
- Shows a placeholder gradient background (or user can upload a test image)
- Georgian sample text: "საქართველოში ახალი ტექნოლოგიური სტარტაპი გაიხსნა"
- Updates in real-time as controls change
- Displays at scaled size with correct aspect ratio (1024x1536 portrait)

**Save button:**
- `PATCH /config/image-template` — persists template JSONB
- `PATCH /config/image-generation` — persists enabled, min_score, quality, size

---

## 8. Cloudflare R2 Setup Guide

### Step-by-Step

1. **Create Cloudflare account** at https://dash.cloudflare.com (if not exists)

2. **Create R2 bucket:**
   - Go to R2 Object Storage → Create bucket
   - Name: `watchtower-images`
   - Location: Auto (or choose EU for lower latency from Georgia)

3. **Enable public access:**
   - Bucket settings → Public access → Enable
   - Note the public URL: `https://pub-{hash}.r2.dev`
   - OR set up custom domain: `images.yourdomain.com` → connect to bucket

4. **Create API token:**
   - R2 → Manage R2 API Tokens → Create API token
   - Permissions: Object Read & Write
   - Specify bucket: `watchtower-images`
   - Save the Access Key ID and Secret Access Key

5. **Configure CORS** (bucket settings → CORS policy):
   ```json
   [
     {
       "AllowedOrigins": ["https://yourdomain.com", "http://localhost:5173"],
       "AllowedMethods": ["GET"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

6. **Add env vars** to `.env`:
   ```env
   R2_ACCOUNT_ID=your_account_id
   R2_ACCESS_KEY_ID=your_access_key_id
   R2_SECRET_ACCESS_KEY=your_secret_access_key
   R2_BUCKET_NAME=watchtower-images
   R2_PUBLIC_URL=https://pub-xxxx.r2.dev
   ```

### Cost Estimate

| Resource | Free Tier | After Free Tier |
|----------|-----------|-----------------|
| Storage | 10 GB/month | $0.015/GB/month |
| Class A ops (writes) | 1M/month | $4.50/1M |
| Class B ops (reads) | 10M/month | $0.36/1M |
| Egress | Unlimited | $0.00 (always free!) |

At 30 images/day (~150KB each): ~135MB/month storage, ~900 writes, ~5,000 reads → **well within free tier**.

---

## 9. Environment Variables

### New Variables

```env
# Cloudflare R2 (image storage)
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=watchtower-images
R2_PUBLIC_URL=https://pub-xxxx.r2.dev
```

### Existing Variables (no changes)

- `OPENAI_API_KEY` — reused for gpt-image-1-mini
- `DATABASE_URL` — article_images table already exists

---

## 10. Change Map

### New Files

| File | Purpose |
|------|---------|
| `packages/shared/src/schemas/image-template.ts` | Zod schema + defaults for image template |
| `packages/worker/src/services/r2-storage.ts` | R2 upload/delete/URL helper |
| `packages/worker/src/services/image-composer.ts` | Canvas text overlay + Sharp composite |
| `packages/worker/src/processors/image-generation.ts` | Image gen worker processor |
| `packages/frontend/src/pages/ImageTemplate.tsx` | Image template settings page |
| `packages/worker/assets/fonts/NotoSansGeorgian-Bold.ttf` | Georgian font (bundled) |
| `packages/worker/assets/watermark/xtelo-logo.png` | XTelo watermark (user provides) |

### Modified Files

| File | Lines | Change |
|------|-------|--------|
| `packages/shared/src/queues.ts` | 7, 17 | Add `QUEUE_IMAGE_GENERATION`, `JOB_IMAGE_GENERATE` |
| `packages/shared/src/index.ts` | 3 | Add image-template export |
| `packages/db/src/schema.ts` | 240 | Add `r2Key` column to articleImages |
| `packages/worker/src/index.ts` | ~86-148, ~299-306 | Register image gen queue + worker |
| `packages/worker/src/processors/translation.ts` | 269-298 | Chain to image gen when enabled |
| `packages/worker/src/processors/distribution.ts` | 356-370 | Fetch + attach image URL |
| `packages/worker/src/processors/maintenance.ts` | 755-764 | R2 cleanup before DB delete |
| `packages/social/src/providers/facebook.ts` | 59-118 | Add image posting via /photos |
| `packages/social/src/providers/linkedin.ts` | 59-139 | Add 3-step image upload |
| `packages/frontend/src/App.tsx` | ~884 | Add /image-template route + nav item |
| `packages/frontend/src/pages/PostTemplates.tsx` | 390-401 | Activate image toggle |
| `packages/api/src/routes/config.ts` | EOF | Add image config endpoints |

---

## 11. Testing Checklist

### Unit Tests

- [ ] Image composer: generate a test card with Georgian text, verify output is WebP with correct dimensions (1024x1536)
- [ ] Image composer: verify word wrap for long Georgian titles (>50 chars)
- [ ] Image composer: verify watermark placement at different positions
- [ ] R2 storage: upload test buffer, verify public URL returns image, delete and verify gone
- [ ] Image template schema: validate against Zod, test defaults, test invalid values rejected

### Integration Tests

- [ ] Pipeline flow (full cycle):
  1. Enable image generation (`min_score=4`) in app_config
  2. Run `npm run pipeline:reset` then `npm run dev`
  3. Wait for articles to be scored >= 4 and translated
  4. Verify `article_images` row created with `status='ready'`
  5. Verify image accessible via R2 public URL
  6. Verify image has Georgian title + XTelo watermark overlaid

- [ ] Distribution with image:
  1. Verify Telegram receives image post (`sendPhoto`)
  2. Verify Facebook receives photo post
  3. Verify LinkedIn receives image share post

- [ ] Distribution without image:
  1. Disable image generation
  2. Verify posts go out text-only (existing behavior preserved)

- [ ] Per-platform control:
  1. Set `showImage=false` for Telegram template, `showImage=true` for Facebook
  2. Verify Telegram gets text-only, Facebook gets image

### Frontend Tests

- [ ] Image Template page loads, shows controls and preview
- [ ] Changing controls updates live preview in real-time
- [ ] Save persists to DB (verify via GET /config/image-template)
- [ ] Post Templates page: image toggle is active (not grayed out)

### Cleanup Tests

- [ ] Set `article_images_ttl_days=1`
- [ ] Insert test image with old `created_at`
- [ ] Run maintenance cleanup
- [ ] Verify R2 object deleted AND DB row deleted

### Error Handling Tests

- [ ] OpenAI API error → article_images.status = 'failed', distribution still posts text-only
- [ ] R2 upload error → article_images.status = 'failed', distribution still posts text-only
- [ ] Image gen disabled mid-pipeline → articles already in queue still process, new ones skip

---

## Implementation Order

Recommended sequence (dependencies flow top-down):

1. **B5** Queue constants
2. **A8** Schema migration (r2_key column)
3. **B1** Image template Zod schema + export (A9)
4. **B2** R2 storage module
5. **B3** Image composer service
6. **B4** Image generation processor
7. **A5** Worker registration
8. **A4** Translation → image gen chaining
9. **A1** Distribution worker — attach image
10. **A2** Facebook image posting
11. **A3** LinkedIn image posting
12. **B6** API routes for image config
13. **B7** Frontend: Image Template page
14. **A7** Activate Post Templates toggle
15. **A10** Seed default config
16. **A6** Maintenance R2 cleanup
17. Build & lint verification
