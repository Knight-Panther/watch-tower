import { z } from "zod";

// ─── Post Template Schema ────────────────────────────────────────────────────
// Defines the configuration for how posts are formatted per social platform.
// Each platform (Telegram, LinkedIn, Facebook) can have its own template.

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

// ─── Platform Defaults ───────────────────────────────────────────────────────
// Each platform has different conventions and audience expectations.

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

/**
 * Get the default template for a platform.
 * Falls back to telegram defaults for unknown platforms.
 */
export const getDefaultTemplate = (platform: string): PostTemplateConfig => {
  return defaultTemplates[platform.toLowerCase()] ?? defaultTemplates.telegram;
};
