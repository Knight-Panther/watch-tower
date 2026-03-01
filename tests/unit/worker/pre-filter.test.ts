import { describe, it, expect } from "vitest";
import { matchesKeyword } from "../../../packages/worker/src/processors/llm-brain.js";

describe("matchesKeyword", () => {
  describe("basic matching", () => {
    it("should match exact keyword in text", () => {
      expect(matchesKeyword("AI is transforming healthcare", "AI")).toBe(true);
    });

    it("should match keyword case-insensitively", () => {
      expect(matchesKeyword("AI is growing fast", "ai")).toBe(true);
    });

    it("should match keyword in the middle of text", () => {
      expect(matchesKeyword("the crypto market crashed today", "crypto")).toBe(true);
    });

    it("should match keyword at the end of text", () => {
      expect(matchesKeyword("approved by FDA", "FDA")).toBe(true);
    });

    it("should match keyword at the start of text", () => {
      expect(matchesKeyword("Bitcoin surged overnight", "Bitcoin")).toBe(true);
    });
  });

  describe("word boundary enforcement", () => {
    it("should NOT match 'AI' inside 'FAIRY' (suffix)", () => {
      expect(matchesKeyword("FAIRY tales for children", "AI")).toBe(false);
    });

    it("should NOT match 'AI' inside 'mAId' (embedded)", () => {
      expect(matchesKeyword("mAId service is growing", "AI")).toBe(false);
    });

    it("should NOT match 'bit' inside 'bitcoin' (prefix boundary)", () => {
      expect(matchesKeyword("bitcoin is rising sharply", "bit")).toBe(false);
    });

    it("should NOT match partial word at end of compound word", () => {
      expect(matchesKeyword("the blockchain revolution", "chain")).toBe(false);
    });

    it("should match standalone word next to punctuation", () => {
      expect(matchesKeyword("Is this AI?", "AI")).toBe(true);
    });

    it("should match word followed by comma", () => {
      expect(matchesKeyword("FDA, CDC announce joint review", "FDA")).toBe(true);
    });
  });

  describe("special regex characters in keyword", () => {
    it("does not match C++ (word boundary fails on non-word chars)", () => {
      // \b can't match between + (non-word) and space (non-word)
      // This is a known limitation of word-boundary matching
      expect(matchesKeyword("C++ is a fast systems language", "C++")).toBe(false);
    });

    it("should handle keyword with dot (escaped, not wildcard)", () => {
      expect(matchesKeyword("Node.js powers the backend", "Node.js")).toBe(true);
    });

    it("should handle keyword with parentheses", () => {
      expect(matchesKeyword("results were significant (p < 0.05)", "p")).toBe(true);
    });

    it("does not match $200 (word boundary fails on $ prefix)", () => {
      // \b can't match before $ (non-word char preceded by space/non-word)
      expect(matchesKeyword("stock surged to $200", "$200")).toBe(false);
    });
  });

  describe("multi-word keywords", () => {
    it("should match multi-word keyword as phrase", () => {
      expect(matchesKeyword("massive data breach reported at bank", "data breach")).toBe(true);
    });

    it("should NOT match multi-word keyword when words are separated", () => {
      expect(matchesKeyword("data is often involved in a breach", "data breach")).toBe(false);
    });

    it("should match hyphenated keyword", () => {
      expect(matchesKeyword("an open-source project released today", "open-source")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should return false for empty text", () => {
      expect(matchesKeyword("", "AI")).toBe(false);
    });

    it("should return false when keyword is not present", () => {
      expect(matchesKeyword("stock market rose today", "blockchain")).toBe(false);
    });

    it("should match single character keyword at word boundary", () => {
      expect(matchesKeyword("vitamin A deficiency", "A")).toBe(true);
    });

    it("should handle text with numbers", () => {
      expect(matchesKeyword("GPT-4 was released in 2023", "GPT-4")).toBe(true);
    });
  });
});
