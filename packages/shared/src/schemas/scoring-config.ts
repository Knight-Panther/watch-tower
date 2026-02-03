import { z } from "zod";

/**
 * Schema for structured scoring configuration.
 * Stored in scoring_rules.score_criteria JSONB column.
 * The worker builds the prompt from this at runtime.
 */
export const scoringConfigSchema = z.object({
  // Scoring guidance - what to prioritize or ignore
  priorities: z.array(z.string().min(1).max(100)).max(20).default([]),
  ignore: z.array(z.string().min(1).max(100)).max(20).default([]),

  // Score definitions - what each level (1-5) means
  score1: z
    .string()
    .max(500)
    .default("Not newsworthy (press releases, minor updates, promotional content)"),
  score2: z.string().max(500).default("Low importance (routine news, minor developments)"),
  score3: z.string().max(500).default("Moderate importance (notable but not urgent)"),
  score4: z.string().max(500).default("High importance (significant developments, major launches)"),
  score5: z
    .string()
    .max(500)
    .default("Critical importance (industry-changing news, major breaking stories)"),

  // Summary settings
  summaryMaxChars: z.number().int().min(50).max(500).default(200),
  summaryTone: z.enum(["professional", "casual", "urgent"]).default("professional"),
  summaryLanguage: z.string().min(1).max(50).default("English"),
  summaryStyle: z
    .string()
    .max(300)
    .default("Start with the key fact. Include company or person name when relevant."),
});

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;

/**
 * Default config used when no custom config exists.
 * Also used to populate the UI form for new rules.
 */
export const defaultScoringConfig: ScoringConfig = scoringConfigSchema.parse({});
