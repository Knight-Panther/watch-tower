import { z } from "zod";

/**
 * Schema for a single calibration example used in few-shot scoring prompts.
 */
const scoringExampleSchema = z.object({
  title: z.string().min(1).max(200),
  score: z.number().int().min(1).max(5),
  reasoning: z.string().min(1).max(300),
});

export type ScoringExample = z.infer<typeof scoringExampleSchema>;

/**
 * Schema for structured scoring configuration.
 * Stored in scoring_rules.score_criteria JSONB column.
 * The worker builds the prompt from this at runtime.
 */
export const scoringConfigSchema = z.object({
  // Scoring guidance - what to prioritize or ignore
  priorities: z.array(z.string().min(1).max(500)).max(20).default([]),
  ignore: z.array(z.string().min(1).max(500)).max(20).default([]),
  // Hard reject keywords - articles matching these skip LLM entirely (cost gate)
  rejectKeywords: z.array(z.string().min(1).max(100)).max(50).default([]),

  // Score definitions - what each level (1-5) means (concrete signals, not vague labels)
  score1: z
    .string()
    .max(500)
    .default(
      "Noise — press releases, promotional content, SEO articles, product listings, " +
        "routine HR announcements, no new information beyond what is already known",
    ),
  score2: z
    .string()
    .max(500)
    .default(
      "Routine — scheduled earnings reports meeting expectations, minor personnel changes, " +
        "incremental updates to previously reported stories, conference attendance announcements",
    ),
  score3: z
    .string()
    .max(500)
    .default(
      "Noteworthy — new development in an ongoing story, notable partnership or collaboration, " +
        "regulatory filing, earnings with modest surprise, product launch from established company",
    ),
  score4: z
    .string()
    .max(500)
    .default(
      "Significant — unexpected corporate action (M&A, IPO filing, major lawsuit), " +
        "policy shift with broad impact, earnings with major surprise, security breach " +
        "affecting users, leadership change at major company",
    ),
  score5: z
    .string()
    .max(500)
    .default(
      "Breaking/Urgent — market-moving event, catastrophic incident, unprecedented regulatory " +
        "action, major geopolitical development affecting markets, critical infrastructure " +
        "failure, confirmed major data breach at scale",
    ),

  // Few-shot calibration examples (empty = use built-in defaults)
  examples: z.array(scoringExampleSchema).max(20).default([]),

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

/**
 * Built-in calibration examples used when config.examples is empty.
 * Generic enough to work across sectors. Sector-specific examples
 * can be added via the scoring rules UI.
 */
export const DEFAULT_SCORING_EXAMPLES: ScoringExample[] = [
  {
    title: "TechStartup Inc. announces redesigned company logo and brand refresh",
    score: 1,
    reasoning:
      "Pure promotional content. No new information about business operations, " +
      "products, or market dynamics.",
  },
  {
    title: "Acme Corp reports Q3 earnings in line with analyst expectations",
    score: 2,
    reasoning:
      "Scheduled earnings meeting expectations. Routine, no surprise element. " +
      "Already anticipated by the market.",
  },
  {
    title: "Acme Corp expands operations to 3 new European markets",
    score: 3,
    reasoning:
      "Expansion is noteworthy but expected growth for a company at this stage. " +
      "No urgency or surprise element. Affects one company only.",
  },
  {
    title: "Acme Corp acquires rival Beta Inc for $2.1B in surprise all-cash deal",
    score: 4,
    reasoning:
      "M&A is a significant corporate action. The surprise element and deal size " +
      "indicate this was not priced in. Affects sector competitive dynamics.",
  },
  {
    title: "Global semiconductor supply chain halted after major fabrication plant fire in Taiwan",
    score: 5,
    reasoning:
      "Critical infrastructure failure affecting entire industry. Market-moving. " +
      "Urgent. Multiple sectors impacted globally.",
  },
];
