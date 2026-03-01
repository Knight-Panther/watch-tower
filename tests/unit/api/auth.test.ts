import { describe, it, expect, vi } from "vitest";
import { createRequireApiKey } from "@watch-tower/api/utils/auth";

// Minimal mock for Fastify request/reply
const createMockRequest = (
  headers: Record<string, string | undefined> = {},
  query: Record<string, unknown> = {},
) => ({
  headers,
  query,
});

const createMockReply = () => {
  const reply = {
    statusCode: 200,
    body: null as unknown,
    code(status: number) {
      reply.statusCode = status;
      return reply;
    },
    send(body: unknown) {
      reply.body = body;
      return reply;
    },
  };
  return reply;
};

describe("createRequireApiKey", () => {
  const API_KEY = "test-secret-key-12345";
  const requireApiKey = createRequireApiKey(API_KEY);

  it("allows request with valid x-api-key header", async () => {
    const req = createMockRequest({ "x-api-key": API_KEY });
    const reply = createMockReply();
    const result = await requireApiKey(req as any, reply as any);
    // No return value means the middleware passed
    expect(result).toBeUndefined();
  });

  it("allows request with valid api_key query param", async () => {
    const req = createMockRequest({}, { api_key: API_KEY });
    const reply = createMockReply();
    const result = await requireApiKey(req as any, reply as any);
    expect(result).toBeUndefined();
  });

  it("prefers header over query param", async () => {
    const req = createMockRequest(
      { "x-api-key": API_KEY },
      { api_key: "wrong-key" },
    );
    const reply = createMockReply();
    const result = await requireApiKey(req as any, reply as any);
    expect(result).toBeUndefined();
  });

  it("rejects request with no key", async () => {
    const req = createMockRequest();
    const reply = createMockReply();
    await requireApiKey(req as any, reply as any);
    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects request with wrong key", async () => {
    const req = createMockRequest({ "x-api-key": "wrong-key" });
    const reply = createMockReply();
    await requireApiKey(req as any, reply as any);
    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects request with empty string key", async () => {
    const req = createMockRequest({ "x-api-key": "" });
    const reply = createMockReply();
    await requireApiKey(req as any, reply as any);
    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects key with different length (timing-safe)", async () => {
    const req = createMockRequest({ "x-api-key": "short" });
    const reply = createMockReply();
    await requireApiKey(req as any, reply as any);
    expect(reply.statusCode).toBe(401);
  });

  it("rejects key with same length but wrong content", async () => {
    // Same length as API_KEY but different content
    const wrongKey = "x".repeat(API_KEY.length);
    const req = createMockRequest({ "x-api-key": wrongKey });
    const reply = createMockReply();
    await requireApiKey(req as any, reply as any);
    expect(reply.statusCode).toBe(401);
  });

  it("returns 500 when server has no API key configured", async () => {
    const noKeyMiddleware = createRequireApiKey("");
    const req = createMockRequest({ "x-api-key": "anything" });
    const reply = createMockReply();
    await noKeyMiddleware(req as any, reply as any);
    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({ error: "Server misconfigured: API_KEY not set" });
  });
});
