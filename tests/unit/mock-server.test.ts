import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startMockServer,
  stopMockServer,
  mockFeedUrl,
  mockDynamicUrl,
  MOCK_SERVER_PORT,
} from "../mock-server/index.js";

describe("mock-server", () => {
  beforeAll(async () => {
    await startMockServer();
  });

  afterAll(async () => {
    await stopMockServer();
  });

  it("serves basic-feed.xml", async () => {
    const res = await fetch(mockFeedUrl("basic-feed"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    const text = await res.text();
    expect(text).toContain("<item>");
    expect(text).toContain("<?xml");
  });

  it("serves empty-feed.xml (zero items)", async () => {
    const res = await fetch(mockFeedUrl("empty-feed"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("<item>");
  });

  it("returns 404 for unknown fixture", async () => {
    const res = await fetch(mockFeedUrl("nonexistent"));
    expect(res.status).toBe(404);
  });

  it("simulates HTTP 500 via ?status=500", async () => {
    const res = await fetch(mockFeedUrl("basic-feed", { status: 500 }));
    expect(res.status).toBe(500);
  });

  it("generates dynamic articles", async () => {
    const res = await fetch(mockDynamicUrl(3));
    expect(res.status).toBe(200);
    const text = await res.text();
    const items = text.match(/<item>/g) || [];
    expect(items).toHaveLength(3);
  });

  it("defaults to 5 articles when 0 requested (0 is falsy in JS)", async () => {
    const res = await fetch(mockDynamicUrl(0));
    expect(res.status).toBe(200);
    const text = await res.text();
    const items = text.match(/<item>/g) || [];
    expect(items).toHaveLength(5);
  });

  it("health endpoint returns 200", async () => {
    const res = await fetch(`http://127.0.0.1:${MOCK_SERVER_PORT}/health`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("OK");
  });

  it("mockFeedUrl builds correct URL", () => {
    expect(mockFeedUrl("basic-feed")).toBe(
      `http://127.0.0.1:${MOCK_SERVER_PORT}/feed/basic-feed`,
    );
  });

  it("mockFeedUrl includes query params", () => {
    const url = mockFeedUrl("basic-feed", { delay: 100, status: 200 });
    expect(url).toContain("delay=100");
    expect(url).toContain("status=200");
  });

  it("mockDynamicUrl builds correct URL", () => {
    expect(mockDynamicUrl(10)).toBe(
      `http://127.0.0.1:${MOCK_SERVER_PORT}/dynamic?articles=10`,
    );
  });

  it("serves content-encoded feed", async () => {
    const res = await fetch(mockFeedUrl("content-encoded"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("content:encoded");
  });

  it("serves many-articles feed (200 items)", async () => {
    const res = await fetch(mockFeedUrl("many-articles"));
    expect(res.status).toBe(200);
    const text = await res.text();
    const items = text.match(/<item>/g) || [];
    expect(items).toHaveLength(200);
  });

  it("idempotent start (calling start twice is safe)", async () => {
    // Should not throw or start a second server
    await startMockServer();
    const res = await fetch(`http://127.0.0.1:${MOCK_SERVER_PORT}/health`);
    expect(res.status).toBe(200);
  });
});
