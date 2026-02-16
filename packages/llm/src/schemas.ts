import { z } from "zod";

/**
 * Schema for validating LLM scoring response.
 * Handles edge cases: string scores, out-of-range values, missing fields.
 */
export const ScoringResponseSchema = z.object({
  score: z.coerce.number().min(1).max(5).transform((v) => Math.round(v)),
  summary: z
    .string()
    .optional()
    .nullable()
    .transform((v) => {
      if (!v || v.length <= 500) return v;
      // Safety net: truncate at word boundary if model ignores the char limit instruction
      const truncated = v.slice(0, 497);
      const lastSpace = truncated.lastIndexOf(" ");
      return (lastSpace > 400 ? truncated.slice(0, lastSpace) : truncated) + "...";
    }),
  // Reasoning is for debugging only - allow longer text, truncate if needed
  reasoning: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 1000 ? v.slice(0, 1000) + "..." : v)),
});

export type ScoringResponse = z.infer<typeof ScoringResponseSchema>;

/**
 * Parse and validate LLM response text.
 * Strips markdown code fences and handles common LLM quirks.
 */
export const parseScoringResponse = (
  text: string,
): { success: true; data: ScoringResponse } | { success: false; error: string } => {
  try {
    // Strip markdown code fences if present
    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    // Extract JSON object from text (handles preambles like "Here is the JSON:")
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: "No JSON object found in response" };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validated = ScoringResponseSchema.safeParse(parsed);

    if (!validated.success) {
      return { success: false, error: validated.error.message };
    }

    return { success: true, data: validated.data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown parse error" };
  }
};
