import { z } from "zod";

// ─── Image Template Schema ──────────────────────────────────────────────────
// Defines the visual layout for AI-generated news card images.
// Controls title overlay, backdrop, and watermark positioning.

const hexColorRegex = /^#[0-9A-Fa-f]{6,8}$/;

export const imageTemplateSchema = z.object({
  // Title overlay
  titlePosition: z.object({
    x: z.number().min(0).max(100), // percentage of image width
    y: z.number().min(0).max(100), // percentage of image height
  }),
  titleAlignment: z.enum(["left", "center", "right"]).default("left"),
  titleMaxWidth: z.number().min(20).max(100).default(80),
  titleFontSize: z.number().min(16).max(96).default(42),
  titleFontFamily: z.string().default("Noto Sans Georgian"),
  titleColor: z.string().regex(hexColorRegex).default("#FFFFFF"),

  // Semi-transparent backdrop behind title
  backdropEnabled: z.boolean().default(true),
  backdropColor: z.string().regex(hexColorRegex).default("#000000B3"),
  backdropPadding: z.number().min(0).max(100).default(24),
  backdropBorderRadius: z.number().min(0).max(50).default(12),

  // XTelo watermark
  watermarkPosition: z.object({
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
  }),
  watermarkScale: z.number().min(0.05).max(1).default(0.15),
});

export type ImageTemplateConfig = z.infer<typeof imageTemplateSchema>;

// ─── Default Template ───────────────────────────────────────────────────────

export const DEFAULT_IMAGE_TEMPLATE: ImageTemplateConfig = {
  titlePosition: { x: 10, y: 70 },
  titleAlignment: "left",
  titleMaxWidth: 80,
  titleFontSize: 42,
  titleFontFamily: "Noto Sans Georgian",
  titleColor: "#FFFFFF",

  backdropEnabled: true,
  backdropColor: "#000000B3", // black 70% opacity
  backdropPadding: 24,
  backdropBorderRadius: 12,

  watermarkPosition: { x: 85, y: 5 }, // top-right
  watermarkScale: 0.15,
};
