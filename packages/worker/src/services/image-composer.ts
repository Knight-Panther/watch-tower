import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";
import type { ImageTemplateConfig } from "@watch-tower/shared";

// ─── Font Registration ──────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, "../../assets");

let fontsRegistered = false;

function ensureFontsRegistered(): void {
  if (fontsRegistered) return;

  const fontPath = path.join(ASSETS_DIR, "fonts", "NotoSansGeorgian-Bold.ttf");
  try {
    GlobalFonts.registerFromPath(fontPath, "Noto Sans Georgian");
    fontsRegistered = true;
  } catch {
    // Font file may not exist yet — will fail gracefully at render time
  }
}

// ─── Watermark Cache ────────────────────────────────────────────────────────

let watermarkCache: Buffer | null = null;

async function getWatermarkBuffer(): Promise<Buffer | null> {
  if (watermarkCache) return watermarkCache;

  const wmPath = path.join(ASSETS_DIR, "watermark", "xtelo-logo.png");
  try {
    watermarkCache = await sharp(wmPath).png().toBuffer();
    return watermarkCache;
  } catch {
    return null; // Watermark not available — skip it
  }
}

// ─── Main Composer ──────────────────────────────────────────────────────────

/**
 * Compose a news card image by overlaying Georgian title + watermark
 * onto an AI-generated background.
 *
 * @param backgroundBase64 - Base64-encoded background image from GPT
 * @param georgianTitle - Georgian title text to overlay
 * @param template - Image template configuration (positions, fonts, colors)
 * @returns WebP buffer of the final composite image
 */
export async function composeNewsCard(
  backgroundBase64: string,
  georgianTitle: string,
  template: ImageTemplateConfig,
): Promise<Buffer> {
  ensureFontsRegistered();

  // 1. Decode AI background and get dimensions
  const bgBuffer = Buffer.from(backgroundBase64, "base64");
  const bgMeta = await sharp(bgBuffer).metadata();
  const width = bgMeta.width!;
  const height = bgMeta.height!;

  // 2. Create transparent canvas overlay (same dimensions as background)
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // 3. Calculate title position and dimensions
  // titlePosition.x/y define the TOP-LEFT corner of the text area (percentage-based)
  const titleAreaLeft = (template.titlePosition.x / 100) * width;
  const titleY = (template.titlePosition.y / 100) * height;
  const maxWidth = (template.titleMaxWidth / 100) * width;

  // Auto font sizing: shrink font until title fits in available vertical space
  const BOTTOM_MARGIN = 20; // px margin from image bottom edge
  const MIN_FONT_SIZE = 24;
  const availableHeight = height - titleY - BOTTOM_MARGIN - (template.backdropEnabled ? template.backdropPadding * 2 : 0);

  let fontSize = template.titleFontSize;
  let lines: string[] = [];
  let lineHeight = fontSize * 1.35;

  while (fontSize >= MIN_FONT_SIZE) {
    ctx.font = `bold ${fontSize}px "${template.titleFontFamily}", sans-serif`;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    lines = wrapText(ctx, georgianTitle, maxWidth);
    lineHeight = fontSize * 1.35;
    const totalTextHeight = lines.length * lineHeight;
    if (totalTextHeight <= availableHeight) break;
    fontSize -= 2;
  }

  // Safety: if even at minimum font size the text overflows, truncate lines
  if (fontSize < MIN_FONT_SIZE) fontSize = MIN_FONT_SIZE;
  const maxLines = Math.max(1, Math.floor(availableHeight / lineHeight));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    // Add ellipsis to last visible line
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*$/, "…");
  }

  // Compute the actual canvas fillText x coordinate based on alignment.
  // Canvas textAlign "center" centers AT the x coordinate, "right" ends AT x.
  // Since titlePosition.x is the LEFT edge of the text area, offset accordingly.
  let textDrawX = titleAreaLeft; // "left" — draw from left edge
  if (template.titleAlignment === "center") {
    textDrawX = titleAreaLeft + maxWidth / 2; // center of the text area
  } else if (template.titleAlignment === "right") {
    textDrawX = titleAreaLeft + maxWidth; // right edge of the text area
  }

  // 4. Draw semi-transparent backdrop behind title
  if (template.backdropEnabled && lines.length > 0) {
    const pad = template.backdropPadding;
    const totalTextHeight = lines.length * lineHeight;

    // Backdrop always covers the full text area regardless of alignment
    const backdropX = titleAreaLeft - pad;
    const backdropY = titleY - pad;
    const backdropW = maxWidth + pad * 2;
    const backdropH = totalTextHeight + pad * 2;

    ctx.fillStyle = template.backdropColor;
    roundRect(ctx, backdropX, backdropY, backdropW, backdropH, template.backdropBorderRadius);
    ctx.fill();
  }

  // 5. Draw text lines
  ctx.fillStyle = template.titleColor;
  ctx.font = `bold ${fontSize}px "${template.titleFontFamily}", sans-serif`;
  ctx.textAlign = template.titleAlignment;
  ctx.textBaseline = "top";

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], textDrawX, titleY + i * lineHeight);
  }

  // 6. Draw XTelo watermark
  const wmBuffer = await getWatermarkBuffer();
  if (wmBuffer) {
    try {
      const wmImage = await loadImage(wmBuffer);
      // watermarkScale is relative to the image width (e.g. 0.15 = 15% of image width)
      const wmWidth = width * template.watermarkScale;
      const wmHeight = wmWidth * (wmImage.height / wmImage.width); // maintain aspect ratio
      const wmX = (template.watermarkPosition.x / 100) * width - wmWidth / 2;
      const wmY = (template.watermarkPosition.y / 100) * height;

      ctx.globalAlpha = 0.85;
      ctx.drawImage(wmImage, wmX, wmY, wmWidth, wmHeight);
      ctx.globalAlpha = 1.0;
    } catch {
      // Watermark render failed — continue without it
    }
  }

  // 7. Export canvas overlay as PNG buffer
  const overlayBuffer = canvas.toBuffer("image/png");

  // 8. Composite: background + overlay → optimized WebP
  const result = await sharp(bgBuffer)
    .composite([{ input: overlayBuffer, top: 0, left: 0 }])
    .webp({ quality: 85 })
    .toBuffer();

  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Word-wrap text using canvas measureText for accurate Georgian text width */
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
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

/** Draw a rounded rectangle path on the canvas context */
function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
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
