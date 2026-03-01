import { describe, it, expect } from "vitest";
import { cleanForTelegram } from "@watch-tower/worker/utils/telegram-alert";

describe("cleanForTelegram", () => {
  it("passes plain text through", () => {
    expect(cleanForTelegram("Hello world")).toBe("Hello world");
  });

  it("decodes numeric HTML entities", () => {
    // &#8217; = right single quote '
    expect(cleanForTelegram("it&#8217;s")).toBe("it\u2019s");
  });

  it("decodes &#8211; (en dash)", () => {
    // &#8211; → – (U+2013 en dash), no & < > to re-escape
    expect(cleanForTelegram("2020&#8211;2025")).toBe("2020\u20132025");
  });

  it("decodes &amp; and re-escapes for Telegram", () => {
    // &amp; → & (decode) → &amp; (re-escape)
    expect(cleanForTelegram("Tom &amp; Jerry")).toBe("Tom &amp; Jerry");
  });

  it("decodes &lt; and re-escapes for Telegram", () => {
    // &lt; → < (decode) → &lt; (re-escape)
    expect(cleanForTelegram("a &lt; b")).toBe("a &lt; b");
  });

  it("decodes &gt; and re-escapes for Telegram", () => {
    // &gt; → > (decode) → &gt; (re-escape)
    expect(cleanForTelegram("a &gt; b")).toBe("a &gt; b");
  });

  it("decodes &quot;", () => {
    expect(cleanForTelegram('He said &quot;hello&quot;')).toBe('He said "hello"');
  });

  it("decodes &apos;", () => {
    expect(cleanForTelegram("it&apos;s fine")).toBe("it's fine");
  });

  it("escapes raw < for Telegram", () => {
    expect(cleanForTelegram("a < b")).toBe("a &lt; b");
  });

  it("escapes raw > for Telegram", () => {
    expect(cleanForTelegram("a > b")).toBe("a &gt; b");
  });

  it("escapes raw & for Telegram", () => {
    expect(cleanForTelegram("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  it("handles mixed entities and raw chars", () => {
    const input = "Q&amp;A: Is 5 &gt; 3? It&apos;s true";
    const result = cleanForTelegram(input);
    // &amp; → & → &amp;  (round-trips)
    // &gt; → > → &gt;    (round-trips)
    // &apos; → '          (decoded, no re-escape needed)
    // Raw text passes through
    expect(result).toContain("&amp;");
    expect(result).toContain("&gt;");
    expect(result).toContain("'");
  });

  it("handles empty string", () => {
    expect(cleanForTelegram("")).toBe("");
  });

  it("handles text with no special chars", () => {
    expect(cleanForTelegram("Breaking news today")).toBe("Breaking news today");
  });

  it("handles multiple numeric entities", () => {
    // &#8220; = left double quote "  &#8221; = right double quote "
    const result = cleanForTelegram("&#8220;Hello&#8221;");
    expect(result).toBe("\u201CHello\u201D");
  });
});
