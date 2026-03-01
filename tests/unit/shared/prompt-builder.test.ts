import { describe, it, expect } from "vitest";
import {
  buildScoringSystemPrompt,
  buildScoringUserMessage,
  buildScoringPrompt,
  defaultScoringConfig,
  scoringConfigSchema,
} from "@watch-tower/shared";

describe("buildScoringSystemPrompt", () => {
  it("includes sector name in role", () => {
    const result = buildScoringSystemPrompt(defaultScoringConfig, "Biotech");
    expect(result).toContain("Biotech news analyst");
  });

  it("includes scoring rubric 1-5", () => {
    const result = buildScoringSystemPrompt(defaultScoringConfig, "Tech");
    expect(result).toContain("1 =");
    expect(result).toContain("2 =");
    expect(result).toContain("3 =");
    expect(result).toContain("4 =");
    expect(result).toContain("5 =");
  });

  it("includes PRIORITIZE section when priorities exist", () => {
    const config = scoringConfigSchema.parse({ priorities: ["AI", "machine learning"] });
    const result = buildScoringSystemPrompt(config, "Tech");
    expect(result).toContain("PRIORITIZE articles about: AI, machine learning");
  });

  it("omits PRIORITIZE section when priorities empty", () => {
    const result = buildScoringSystemPrompt(defaultScoringConfig, "Tech");
    expect(result).not.toContain("PRIORITIZE");
  });

  it("includes DE-PRIORITIZE section when ignore list exists", () => {
    const config = scoringConfigSchema.parse({ ignore: ["sponsored", "press releases"] });
    const result = buildScoringSystemPrompt(config, "Tech");
    expect(result).toContain("DE-PRIORITIZE articles about: sponsored, press releases");
  });

  it("omits DE-PRIORITIZE section when ignore empty", () => {
    const result = buildScoringSystemPrompt(defaultScoringConfig, "Tech");
    expect(result).not.toContain("DE-PRIORITIZE");
  });

  it("uses custom score definitions", () => {
    const config = scoringConfigSchema.parse({ score1: "Total garbage", score5: "World changing" });
    const result = buildScoringSystemPrompt(config, "Tech");
    expect(result).toContain("1 = Total garbage");
    expect(result).toContain("5 = World changing");
  });

  it("includes summary settings", () => {
    const config = scoringConfigSchema.parse({
      summaryMaxChars: 300,
      summaryTone: "urgent",
      summaryLanguage: "Georgian",
    });
    const result = buildScoringSystemPrompt(config, "Tech");
    expect(result).toContain("Maximum 300 characters");
    expect(result).toContain("Tone: urgent");
    expect(result).toContain("Language: Georgian");
  });

  it("includes default calibration examples when none provided", () => {
    const result = buildScoringSystemPrompt(defaultScoringConfig, "Tech");
    expect(result).toContain("CALIBRATION EXAMPLES");
    expect(result).toContain("redesigned company logo");
  });

  it("uses custom examples when provided", () => {
    const config = scoringConfigSchema.parse({
      examples: [{ title: "Custom example headline", score: 3, reasoning: "Because reasons" }],
    });
    const result = buildScoringSystemPrompt(config, "Tech");
    expect(result).toContain("Custom example headline");
    expect(result).toContain("Because reasons");
    expect(result).not.toContain("redesigned company logo");
  });

  it("includes edge case instructions", () => {
    const result = buildScoringSystemPrompt(defaultScoringConfig, "Tech");
    expect(result).toContain("Empty or very short content");
    expect(result).toContain("Non-English article");
    expect(result).toContain("promotional or sponsored");
  });

  it("includes JSON output format instruction", () => {
    const result = buildScoringSystemPrompt(defaultScoringConfig, "Tech");
    expect(result).toContain("valid JSON object");
    expect(result).toContain('"reasoning"');
    expect(result).toContain('"score"');
    expect(result).toContain('"summary"');
  });

  it("includes decision signals", () => {
    const result = buildScoringSystemPrompt(defaultScoringConfig, "Tech");
    expect(result).toContain("Novelty");
    expect(result).toContain("Surprise");
    expect(result).toContain("Scope");
    expect(result).toContain("Urgency");
  });
});

describe("buildScoringUserMessage", () => {
  it("includes sector, title, and content", () => {
    const result = buildScoringUserMessage("Big News", "The full article text.", "Crypto");
    expect(result).toContain("Sector: Crypto");
    expect(result).toContain("Article Title: Big News");
    expect(result).toContain("Article Content: The full article text.");
  });

  it("includes categories when provided", () => {
    const result = buildScoringUserMessage("Title", "Content", "Tech", ["AI", "Startups"]);
    expect(result).toContain("Categories: AI, Startups");
  });

  it("omits categories line when empty array", () => {
    const result = buildScoringUserMessage("Title", "Content", "Tech", []);
    expect(result).not.toContain("Categories");
  });

  it("omits categories line when undefined", () => {
    const result = buildScoringUserMessage("Title", "Content", "Tech");
    expect(result).not.toContain("Categories");
  });

  it("shows fallback text when content is empty", () => {
    const result = buildScoringUserMessage("Title Only", "", "Tech");
    expect(result).toContain("No content available");
  });
});

describe("buildScoringPrompt", () => {
  it("combines system and user template", () => {
    const result = buildScoringPrompt(defaultScoringConfig, "Tech");
    expect(result).toContain("news analyst");
    expect(result).toContain("Article Title: {title}");
    expect(result).toContain("Article Content: {content}");
    expect(result).toContain("Sector: {sector}");
  });
});
