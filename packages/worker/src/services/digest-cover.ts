/**
 * Dynamic digest cover image generator.
 * Produces a branded 1080x1350 (4:5 portrait) cover for Facebook/LinkedIn/Telegram.
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
    logoCache = await sharp(path.join(ASSETS_DIR, "watermark", "xtelo-logo.png")).png().toBuffer();
    return logoCache;
  } catch {
    return null;
  }
}

// ─── Canvas Config ──────────────────────────────────────────────────────────

const WIDTH = 1080;
const HEIGHT = 1350; // 4:5 portrait — optimal for Facebook/Instagram feed

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a branded digest cover image.
 *
 * @param language - "en" or "ka"
 * @param dateStr - formatted date string (e.g. "23.02.2026")
 * @returns WebP buffer
 */
export async function generateDigestCover(
  language: "en" | "ka",
  dateStr: string,
): Promise<Buffer> {
  ensureFonts();

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  // 1. Dark gradient background
  const gradient = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  gradient.addColorStop(0, "#020617");
  gradient.addColorStop(0.4, "#0f172a");
  gradient.addColorStop(1, "#1e293b");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // 2. Subtle dot grid for texture
  ctx.fillStyle = "rgba(100, 116, 139, 0.05)";
  for (let x = 0; x < WIDTH; x += 36) {
    for (let y = 0; y < HEIGHT; y += 36) {
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 3. XTelo logo (centered top)
  let logoBottomY = 200;
  const logoBuf = await getLogoBuffer();
  if (logoBuf) {
    try {
      const logoImage = await loadImage(logoBuf);
      const logoWidth = 260;
      const logoHeight = logoWidth * (logoImage.height / logoImage.width);
      const logoX = (WIDTH - logoWidth) / 2;
      const logoY = 120;
      logoBottomY = logoY + logoHeight + 60;

      ctx.globalAlpha = 0.95;
      ctx.drawImage(logoImage, logoX, logoY, logoWidth, logoHeight);
      ctx.globalAlpha = 1.0;
    } catch {
      // skip logo on error
    }
  }

  // 4. Emerald divider
  const dividerY = logoBottomY + 10;
  const dividerWidth = 120;
  ctx.fillStyle = "#34d399";
  roundRect(ctx, (WIDTH - dividerWidth) / 2, dividerY, dividerWidth, 4, 2);
  ctx.fill();

  // 5. Main title (language-dependent)
  const titleY = dividerY + 60;
  ctx.fillStyle = "#f1f5f9";
  ctx.textBaseline = "top";
  ctx.textAlign = "center";

  if (language === "ka") {
    ctx.font = 'bold 58px "Noto Sans Georgian", sans-serif';
    ctx.fillText("რა მოხდა დღეს", WIDTH / 2, titleY);
  } else {
    ctx.font = 'bold 58px "Noto Sans Georgian", sans-serif';
    ctx.fillText("Daily Intelligence", WIDTH / 2, titleY);
    ctx.fillText("Briefing", WIDTH / 2, titleY + 75);
  }

  // 6. Subtitle
  const subtitleY = language === "ka" ? titleY + 85 : titleY + 185;
  ctx.fillStyle = "#94a3b8";
  ctx.font = '30px "Noto Sans Georgian", sans-serif';
  ctx.fillText("Media Watch Tower", WIDTH / 2, subtitleY);

  // 7. Bar chart
  const chartY = subtitleY + 100;
  const barHeights = [80, 120, 55, 100, 70, 130, 90];
  const barWidth = 22;
  const barGap = 14;
  const totalChartWidth = barHeights.length * (barWidth + barGap) - barGap;
  const chartStartX = (WIDTH - totalChartWidth) / 2;
  const maxBarH = 130;

  for (let i = 0; i < barHeights.length; i++) {
    const h = barHeights[i];
    const x = chartStartX + i * (barWidth + barGap);
    const y = chartY + maxBarH - h;
    const intensity = h / maxBarH;
    ctx.globalAlpha = 0.3 + intensity * 0.5;
    ctx.fillStyle = "#34d399";
    roundRect(ctx, x, y, barWidth, h, 5);
    ctx.fill();
  }
  ctx.globalAlpha = 1.0;

  // 8. Date below chart
  const dateY = chartY + maxBarH + 40;
  ctx.fillStyle = "#94a3b8";
  ctx.font = '26px "Noto Sans Georgian", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(dateStr, WIDTH / 2, dateY);

  // 9. Horizontal line
  const lineY = dateY + 50;
  ctx.strokeStyle = "rgba(100, 116, 139, 0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(100, lineY);
  ctx.lineTo(WIDTH - 100, lineY);
  ctx.stroke();

  // 10. Bottom tagline
  ctx.fillStyle = "#475569";
  ctx.font = '22px "Noto Sans Georgian", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("Verified by XTelo", WIDTH / 2, HEIGHT - 100);

  // 11. Border
  ctx.strokeStyle = "rgba(100, 116, 139, 0.15)";
  ctx.lineWidth = 2;
  roundRect(ctx, 1, 1, WIDTH - 2, HEIGHT - 2, 16);
  ctx.stroke();

  // 12. Export
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
