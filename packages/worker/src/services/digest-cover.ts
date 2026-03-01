/**
 * Dynamic digest cover image generator.
 * Produces a branded 1080x1080 (1:1 square) cover for Facebook/LinkedIn/Telegram.
 * Two variants: English ("Daily Intelligence Briefing") and Georgian ("რა მოხდა დღეს").
 */
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, "../../assets");

// ─── Font Registration ──────────────────────────────────────────────────────

let fontsRegistered = false;

function ensureFonts(): void {
  if (fontsRegistered) return;
  try {
    GlobalFonts.registerFromPath(
      path.join(ASSETS_DIR, "fonts", "NotoSansGeorgian-Bold.ttf"),
      "Noto Sans Georgian",
    );
    fontsRegistered = true;
  } catch {
    // Font may not exist — canvas will use system fallback
  }
}

// ─── Watermark Cache ────────────────────────────────────────────────────────

let logoCache: Buffer | null = null;

async function getLogoBuffer(): Promise<Buffer | null> {
  if (logoCache) return logoCache;
  try {
    logoCache = await sharp(path.join(ASSETS_DIR, "watermark", "xtelo-logo.png"))
      .png()
      .toBuffer();
    return logoCache;
  } catch {
    return null;
  }
}

// ─── Canvas Config ──────────────────────────────────────────────────────────

const SIZE = 1080; // 1:1 square — universal format for photo posts

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a branded digest cover image.
 *
 * @param language - "en" or "ka"
 * @param dateStr - formatted date string (e.g. "23.02.2026")
 * @returns WebP buffer
 */
export async function generateDigestCover(language: "en" | "ka", dateStr: string): Promise<Buffer> {
  ensureFonts();

  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");

  // 1. Dark gradient background
  const gradient = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  gradient.addColorStop(0, "#020617");
  gradient.addColorStop(0.5, "#0f172a");
  gradient.addColorStop(1, "#1e293b");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // 2. Subtle dot grid for texture
  ctx.fillStyle = "rgba(100, 116, 139, 0.05)";
  for (let x = 0; x < SIZE; x += 36) {
    for (let y = 0; y < SIZE; y += 36) {
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const centerX = SIZE / 2;

  // 3. XTelo logo (centered, top area)
  let logoBottomY = 200;
  const logoBuf = await getLogoBuffer();
  if (logoBuf) {
    try {
      const logoImage = await loadImage(logoBuf);
      const logoWidth = 200;
      const logoHeight = logoWidth * (logoImage.height / logoImage.width);
      const logoY = 120;
      logoBottomY = logoY + logoHeight + 30;

      ctx.globalAlpha = 0.95;
      ctx.drawImage(logoImage, centerX - logoWidth / 2, logoY, logoWidth, logoHeight);
      ctx.globalAlpha = 1.0;
    } catch {
      // skip logo on error
    }
  }

  // 4. Emerald divider (centered)
  const dividerY = logoBottomY + 10;
  ctx.fillStyle = "#34d399";
  roundRect(ctx, centerX - 40, dividerY, 80, 3, 2);
  ctx.fill();

  // 5. Main title (language-dependent, centered)
  const titleY = dividerY + 40;
  ctx.fillStyle = "#f1f5f9";
  ctx.textBaseline = "top";
  ctx.textAlign = "center";

  if (language === "ka") {
    ctx.font = 'bold 52px "Noto Sans Georgian", sans-serif';
    ctx.fillText("რა მოხდა დღეს", centerX, titleY);
  } else {
    ctx.font = 'bold 52px "Noto Sans Georgian", sans-serif';
    ctx.fillText("Daily Intelligence", centerX, titleY);
    ctx.fillText("Briefing", centerX, titleY + 65);
  }

  // 6. Subtitle (centered)
  const subtitleY = language === "ka" ? titleY + 80 : titleY + 155;
  ctx.fillStyle = "#94a3b8";
  ctx.font = '26px "Noto Sans Georgian", sans-serif';
  ctx.fillText("Media Watch Tower", centerX, subtitleY);

  // 7. Bar chart (centered, below subtitle)
  const barHeights = [60, 95, 40, 80, 55, 100, 70];
  const barWidth = 24;
  const barGap = 14;
  const totalChartWidth = barHeights.length * (barWidth + barGap) - barGap;
  const chartStartX = centerX - totalChartWidth / 2;
  const maxBarH = 100;
  const chartBaseY = subtitleY + 80 + maxBarH;

  for (let i = 0; i < barHeights.length; i++) {
    const h = barHeights[i];
    const x = chartStartX + i * (barWidth + barGap);
    const y = chartBaseY - h;
    const intensity = h / maxBarH;
    ctx.globalAlpha = 0.3 + intensity * 0.5;
    ctx.fillStyle = "#34d399";
    roundRect(ctx, x, y, barWidth, h, 4);
    ctx.fill();
  }
  ctx.globalAlpha = 1.0;

  // 8. Date (centered, below chart)
  ctx.fillStyle = "#64748b";
  ctx.font = '24px "Noto Sans Georgian", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(dateStr, centerX, chartBaseY + 40);

  // 9. Bottom tagline (centered)
  ctx.fillStyle = "#475569";
  ctx.font = '18px "Noto Sans Georgian", sans-serif';
  ctx.fillText("Verified by XTelo", centerX, SIZE - 40);

  // 10. Border
  ctx.strokeStyle = "rgba(100, 116, 139, 0.15)";
  ctx.lineWidth = 2;
  roundRect(ctx, 1, 1, SIZE - 2, SIZE - 2, 12);
  ctx.stroke();

  // 11. Export
  const pngBuffer = canvas.toBuffer("image/png");
  return sharp(pngBuffer).webp({ quality: 90 }).toBuffer() as Promise<Buffer>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function roundRect(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
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
