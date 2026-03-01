import { describe, it, expect } from "vitest";
import { validateFeedUrl } from "@watch-tower/shared";

describe("validateFeedUrl", () => {
  // --- Valid URLs ---
  describe("valid URLs", () => {
    it("accepts standard HTTPS URL", () => {
      const result = validateFeedUrl("https://example.com/feed.xml");
      expect(result.valid).toBe(true);
      expect(result.url).toBeInstanceOf(URL);
      expect(result.url!.hostname).toBe("example.com");
    });

    it("accepts HTTP URL", () => {
      const result = validateFeedUrl("http://news.ycombinator.com/rss");
      expect(result.valid).toBe(true);
    });

    it("accepts URL with port", () => {
      const result = validateFeedUrl("https://example.com:8443/feed");
      expect(result.valid).toBe(true);
    });

    it("accepts URL with query params", () => {
      const result = validateFeedUrl("https://reddit.com/r/technology/.rss?limit=50");
      expect(result.valid).toBe(true);
    });

    it("accepts URL with path segments", () => {
      const result = validateFeedUrl("https://blog.example.com/category/tech/feed.xml");
      expect(result.valid).toBe(true);
    });

    it("accepts URL with subdomain", () => {
      const result = validateFeedUrl("https://feeds.bbci.co.uk/news/rss.xml");
      expect(result.valid).toBe(true);
    });
  });

  // --- Invalid Protocols ---
  describe("blocks non-HTTP protocols", () => {
    it("rejects file:// protocol", () => {
      const result = validateFeedUrl("file:///etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid protocol");
    });

    it("rejects ftp:// protocol", () => {
      const result = validateFeedUrl("ftp://example.com/feed.xml");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid protocol");
    });

    it("rejects javascript: protocol", () => {
      const result = validateFeedUrl("javascript:alert(1)");
      expect(result.valid).toBe(false);
      // May be caught as invalid URL or invalid protocol
    });

    it("rejects data: protocol", () => {
      const result = validateFeedUrl("data:text/html,<h1>hi</h1>");
      expect(result.valid).toBe(false);
    });
  });

  // --- Invalid URL format ---
  describe("blocks invalid URLs", () => {
    it("rejects empty string", () => {
      const result = validateFeedUrl("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid URL");
    });

    it("rejects non-URL string", () => {
      const result = validateFeedUrl("not a url");
      expect(result.valid).toBe(false);
    });

    it("rejects URL without protocol", () => {
      const result = validateFeedUrl("example.com/feed.xml");
      expect(result.valid).toBe(false);
    });
  });

  // --- Localhost / Loopback ---
  describe("blocks localhost and loopback", () => {
    it("rejects localhost", () => {
      const result = validateFeedUrl("http://localhost/feed");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not allowed");
    });

    it("rejects 127.0.0.1", () => {
      const result = validateFeedUrl("http://127.0.0.1/feed");
      expect(result.valid).toBe(false);
    });

    it("rejects 0.0.0.0", () => {
      const result = validateFeedUrl("http://0.0.0.0/feed");
      expect(result.valid).toBe(false);
    });

    it("rejects ::1 (IPv6 loopback)", () => {
      const result = validateFeedUrl("http://[::1]/feed");
      expect(result.valid).toBe(false);
    });

    it("rejects 127.x.x.x range", () => {
      const result = validateFeedUrl("http://127.0.0.2/feed");
      expect(result.valid).toBe(false);
    });
  });

  // --- Private IP Ranges (SSRF Protection) ---
  describe("blocks private IP ranges", () => {
    it("rejects 10.x.x.x (Class A)", () => {
      const result = validateFeedUrl("http://10.0.0.1/feed");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Private IP");
    });

    it("rejects 172.16.x.x (Class B start)", () => {
      const result = validateFeedUrl("http://172.16.0.1/feed");
      expect(result.valid).toBe(false);
    });

    it("rejects 172.31.x.x (Class B end)", () => {
      const result = validateFeedUrl("http://172.31.255.255/feed");
      expect(result.valid).toBe(false);
    });

    it("allows 172.32.x.x (outside Class B range)", () => {
      const result = validateFeedUrl("http://172.32.0.1/feed");
      expect(result.valid).toBe(true);
    });

    it("rejects 192.168.x.x (Class C)", () => {
      const result = validateFeedUrl("http://192.168.1.1/feed");
      expect(result.valid).toBe(false);
    });

    it("rejects 169.254.x.x (link-local)", () => {
      const result = validateFeedUrl("http://169.254.1.1/feed");
      expect(result.valid).toBe(false);
    });

    it("rejects 0.x.x.x (invalid)", () => {
      const result = validateFeedUrl("http://0.1.2.3/feed");
      expect(result.valid).toBe(false);
    });

    it("rejects 100.64.x.x (carrier-grade NAT)", () => {
      const result = validateFeedUrl("http://100.64.0.1/feed");
      expect(result.valid).toBe(false);
    });

    it("rejects 100.127.x.x (carrier-grade NAT end)", () => {
      const result = validateFeedUrl("http://100.127.255.255/feed");
      expect(result.valid).toBe(false);
    });

    it("allows 100.128.x.x (outside carrier-grade NAT)", () => {
      const result = validateFeedUrl("http://100.128.0.1/feed");
      expect(result.valid).toBe(true);
    });
  });

  // --- Cloud Metadata Endpoints ---
  describe("blocks cloud metadata endpoints", () => {
    it("rejects AWS/Azure/GCP metadata IP", () => {
      const result = validateFeedUrl("http://169.254.169.254/latest/meta-data/");
      expect(result.valid).toBe(false);
    });

    it("rejects GCP metadata hostname", () => {
      const result = validateFeedUrl("http://metadata.google.internal/computeMetadata/v1/");
      expect(result.valid).toBe(false);
    });

    it("rejects any hostname containing 'metadata'", () => {
      const result = validateFeedUrl("http://metadata.evil.com/feed");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Metadata");
    });
  });
});
