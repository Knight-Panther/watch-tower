import { describe, it, expect } from "vitest";
import { extractRootDomain } from "../../../packages/worker/src/utils/domain-whitelist.js";

describe("extractRootDomain", () => {
  describe("standard single-part TLDs", () => {
    it("should strip www subdomain from .com domain", () => {
      expect(extractRootDomain("https://www.reuters.com/rss")).toBe("reuters.com");
    });

    it("should return root domain with no subdomain", () => {
      expect(extractRootDomain("https://example.com")).toBe("example.com");
    });

    it("should strip deep subdomain and return root", () => {
      expect(extractRootDomain("https://a.b.c.example.com/feed")).toBe("example.com");
    });

    it("should handle domain with path", () => {
      expect(extractRootDomain("https://example.com/long/path/feed.xml")).toBe("example.com");
    });

    it("should handle domain with port", () => {
      expect(extractRootDomain("https://example.com:8080/feed")).toBe("example.com");
    });

    it("should handle domain with query parameters", () => {
      expect(extractRootDomain("https://example.com/rss?format=atom")).toBe("example.com");
    });

    it("should handle HTTP URLs", () => {
      expect(extractRootDomain("http://news.ycombinator.com/rss")).toBe("ycombinator.com");
    });
  });

  describe("two-part TLDs", () => {
    it("should handle .co.uk (BBC feeds)", () => {
      expect(extractRootDomain("https://feeds.bbci.co.uk/news")).toBe("bbci.co.uk");
    });

    it("should handle .co.uk with www", () => {
      expect(extractRootDomain("https://news.bbc.co.uk")).toBe("bbc.co.uk");
    });

    it("should handle .com.au (Australian domain)", () => {
      expect(extractRootDomain("https://news.abc.com.au")).toBe("abc.com.au");
    });

    it("should handle .co.jp (Japanese domain)", () => {
      expect(extractRootDomain("https://news.nhk.co.jp")).toBe("nhk.co.jp");
    });

    it("should handle .com.br (Brazilian domain)", () => {
      expect(extractRootDomain("https://g1.globo.com.br")).toBe("globo.com.br");
    });

    it("should handle .co.nz (New Zealand domain)", () => {
      expect(extractRootDomain("https://feeds.stuff.co.nz/rss")).toBe("stuff.co.nz");
    });

    it("should handle .org.uk domain", () => {
      expect(extractRootDomain("https://news.bbc.org.uk/feed")).toBe("bbc.org.uk");
    });

    it("should handle .co.in (Indian domain)", () => {
      expect(extractRootDomain("https://feeds.thehindu.co.in/rss")).toBe("thehindu.co.in");
    });
  });

  describe("invalid inputs", () => {
    it("should return null for invalid URL string", () => {
      expect(extractRootDomain("not-a-url")).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(extractRootDomain("")).toBeNull();
    });

    it("should return null for plain text with no protocol", () => {
      expect(extractRootDomain("example.com")).toBeNull();
    });
  });

  describe("IP addresses", () => {
    it("should return IPv4 address as-is", () => {
      expect(extractRootDomain("http://127.0.0.1:9999/feed")).toBe("127.0.0.1");
    });

    it("should return IPv4 address without port", () => {
      expect(extractRootDomain("https://192.168.1.100/rss")).toBe("192.168.1.100");
    });

    it("should return public IPv4 address as-is", () => {
      expect(extractRootDomain("http://203.0.113.42:8080/feed.xml")).toBe("203.0.113.42");
    });
  });

  describe("hostname normalization", () => {
    it("should lowercase the extracted domain", () => {
      expect(extractRootDomain("https://www.REUTERS.COM/rss")).toBe("reuters.com");
    });
  });
});
