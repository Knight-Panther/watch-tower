import { describe, it, expect } from "vitest";
import { formatAlertMessage, mergeTemplate } from "@watch-tower/worker/processors/alert-processor";

// Mock article for testing
const mockArticle = {
  articleId: "test-123",
  title: "FDA Approves New Cancer Drug",
  llmSummary: "A breakthrough cancer treatment has been approved.",
  url: "https://example.com/article/1",
  sectorName: "Biotech",
  score: 4,
  matchedAlertKeywords: ["FDA approval"],
};

describe("mergeTemplate", () => {
  it("returns defaults when null passed", () => {
    const result = mergeTemplate(null);
    expect(result.showAlert).toBe(true);
    expect(result.showTitle).toBe(true);
    expect(result.showUrl).toBe(true);
    expect(result.showSummary).toBe(true);
    expect(result.showScore).toBe(true);
    expect(result.showSector).toBe(true);
    expect(result.showKeyword).toBe(true);
    expect(result.alertEmoji).toBe("🔔");
  });

  it("returns defaults when empty object passed", () => {
    const result = mergeTemplate({});
    expect(result.showAlert).toBe(true);
    expect(result.alertEmoji).toBe("🔔");
  });

  it("overrides specific fields", () => {
    const result = mergeTemplate({ alertEmoji: "🚨", showScore: false });
    expect(result.alertEmoji).toBe("🚨");
    expect(result.showScore).toBe(false);
    // Other defaults preserved
    expect(result.showAlert).toBe(true);
    expect(result.showTitle).toBe(true);
  });
});

describe("formatAlertMessage", () => {
  const defaultTemplate = mergeTemplate(null);

  it("includes alert header with emoji and rule name", () => {
    const msg = formatAlertMessage("My Rule", "FDA approval", mockArticle, defaultTemplate);
    expect(msg).toContain("🔔");
    expect(msg).toContain("My Rule");
  });

  it("includes keyword in message", () => {
    const msg = formatAlertMessage("My Rule", "FDA approval", mockArticle, defaultTemplate);
    expect(msg).toContain("FDA approval");
  });

  it("includes score with label", () => {
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, defaultTemplate);
    expect(msg).toContain("4/5");
    expect(msg).toContain("High");
  });

  it("includes sector name", () => {
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, defaultTemplate);
    expect(msg).toContain("Biotech");
  });

  it("includes article title", () => {
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, defaultTemplate);
    expect(msg).toContain("FDA Approves New Cancer Drug");
  });

  it("includes summary", () => {
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, defaultTemplate);
    expect(msg).toContain("breakthrough cancer treatment");
  });

  it("includes URL as link", () => {
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, defaultTemplate);
    expect(msg).toContain('href="https://example.com/article/1"');
    expect(msg).toContain("Read more");
  });

  it("hides alert header when showAlert=false", () => {
    const template = mergeTemplate({ showAlert: false });
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, template);
    expect(msg).not.toContain("🔔");
    expect(msg).not.toContain("Alert:");
  });

  it("hides score when showScore=false", () => {
    const template = mergeTemplate({ showScore: false });
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, template);
    expect(msg).not.toContain("4/5");
  });

  it("hides sector when showSector=false", () => {
    const template = mergeTemplate({ showSector: false });
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, template);
    expect(msg).not.toContain("Sector:");
  });

  it("hides keyword when showKeyword=false", () => {
    const template = mergeTemplate({ showKeyword: false });
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, template);
    expect(msg).not.toContain("Keyword:");
  });

  it("hides URL when showUrl=false", () => {
    const template = mergeTemplate({ showUrl: false });
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, template);
    expect(msg).not.toContain("href=");
    expect(msg).not.toContain("Read more");
  });

  it("hides summary when showSummary=false", () => {
    const template = mergeTemplate({ showSummary: false });
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, template);
    expect(msg).not.toContain("breakthrough cancer treatment");
  });

  it("uses Georgian labels when language=ka", () => {
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, defaultTemplate, "ka");
    expect(msg).toContain("შეტყობინება");
    expect(msg).toContain("საკვანძო სიტყვა");
    expect(msg).toContain("ქულა");
    expect(msg).toContain("სექტორი");
    expect(msg).toContain("წაიკითხეთ მეტი");
  });

  it("uses English labels when language=en", () => {
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, defaultTemplate, "en");
    expect(msg).toContain("Alert:");
    expect(msg).toContain("Keyword:");
    expect(msg).toContain("Score:");
    expect(msg).toContain("Sector:");
    expect(msg).toContain("Read more");
  });

  it("uses custom emoji", () => {
    const template = mergeTemplate({ alertEmoji: "🚨" });
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, template);
    expect(msg).toContain("🚨");
    expect(msg).not.toContain("🔔");
  });

  it("shows correct score labels for each level", () => {
    const scores = [
      { score: 1, label: "Low" },
      { score: 2, label: "Low" },
      { score: 3, label: "Medium" },
      { score: 4, label: "High" },
      { score: 5, label: "Critical" },
    ];

    for (const { score, label } of scores) {
      const article = { ...mockArticle, score };
      const msg = formatAlertMessage("Rule", "kw", article, defaultTemplate);
      expect(msg).toContain(`${score}/5 (${label})`);
    }
  });

  it("handles article with no summary", () => {
    const article = { ...mockArticle, llmSummary: null };
    const msg = formatAlertMessage("Rule", "kw", article, defaultTemplate);
    expect(msg).toContain("FDA Approves New Cancer Drug");
    // Should not contain summary text
    expect(msg).not.toContain("breakthrough");
  });

  it("handles article with no sector", () => {
    const article = { ...mockArticle, sectorName: null };
    const msg = formatAlertMessage("Rule", "kw", article, defaultTemplate);
    expect(msg).not.toContain("Sector:");
  });

  it("escapes HTML special chars in title", () => {
    const article = { ...mockArticle, title: "Tom & Jerry <script>" };
    const msg = formatAlertMessage("Rule", "kw", article, defaultTemplate);
    expect(msg).toContain("Tom &amp; Jerry &lt;script&gt;");
  });

  it("uses custom labels from template", () => {
    const template = mergeTemplate({
      labels: { alert: "Warning", keyword: "Tag", score: "Rating" },
    });
    const msg = formatAlertMessage("My Rule", "FDA", mockArticle, template, "en");
    expect(msg).toContain("Warning:");
    expect(msg).toContain("Tag:");
    expect(msg).toContain("Rating:");
  });
});
