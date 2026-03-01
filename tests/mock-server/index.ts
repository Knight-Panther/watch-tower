/**
 * Mock RSS HTTP server for integration and e2e tests.
 *
 * Serves static XML fixtures and supports query-param-driven edge cases:
 *   ?delay=N     — delay response by N milliseconds
 *   ?status=N    — return HTTP status N (e.g. 500, 404)
 *   ?size=10mb   — return an oversized response (~10 MB)
 *
 * Routes:
 *   GET /feed/:filename        → serves tests/fixtures/rss/:filename.xml
 *   GET /dynamic?articles=N   → generates N articles dynamically
 *
 * Usage in tests:
 *   import { startMockServer, stopMockServer, MOCK_SERVER_PORT } from "../mock-server/index.js";
 *   beforeAll(() => startMockServer());
 *   afterAll(() => stopMockServer());
 */

import http from "http";
import fs from "fs";
import path from "path";
import { generateArticles, generateLargeContent } from "./scenarios.js";

export const MOCK_SERVER_PORT = 9999;

/**
 * Resolve the fixtures directory relative to the project root.
 * Uses process.cwd() (the monorepo root) to stay compatible with
 * the CommonJS tsconfig used by the tests workspace, which does not
 * support import.meta.url.
 */
const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures/rss");

let server: http.Server | null = null;

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Parse a raw request URL into pathname + URLSearchParams.
 * Falls back gracefully when the URL is malformed.
 */
const parseUrl = (
  rawUrl: string | undefined,
): { pathname: string; params: URLSearchParams } => {
  try {
    const base = `http://localhost:${MOCK_SERVER_PORT}`;
    const parsed = new URL(rawUrl ?? "/", base);
    return { pathname: parsed.pathname, params: parsed.searchParams };
  } catch {
    return { pathname: "/", params: new URLSearchParams() };
  }
};

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const sendError = (res: http.ServerResponse, statusCode: number, message: string): void => {
  res.writeHead(statusCode, { "Content-Type": "text/plain" });
  res.end(message);
};

const sendXml = (res: http.ServerResponse, xml: string, statusCode = 200): void => {
  const body = Buffer.from(xml, "utf-8");
  res.writeHead(statusCode, {
    "Content-Type": "application/rss+xml; charset=utf-8",
    "Content-Length": String(body.byteLength),
  });
  res.end(body);
};

// ---------------------------------------------------------------------------
// Query-param edge case: delay
// ---------------------------------------------------------------------------

const applyDelay = (params: URLSearchParams): Promise<void> => {
  const raw = params.get("delay");
  if (!raw) return Promise.resolve();
  const ms = parseInt(raw, 10);
  if (!isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// ---------------------------------------------------------------------------
// Query-param edge case: forced status override
// ---------------------------------------------------------------------------

const getForcedStatus = (params: URLSearchParams): number | null => {
  const raw = params.get("status");
  if (!raw) return null;
  const code = parseInt(raw, 10);
  return isFinite(code) && code >= 100 && code <= 599 ? code : null;
};

// ---------------------------------------------------------------------------
// Query-param edge case: oversized response
// ---------------------------------------------------------------------------

const getSizeMb = (params: URLSearchParams): number | null => {
  const raw = params.get("size");
  if (!raw) return null;
  // Accept "10mb", "10MB", or bare "10"
  const numeric = parseFloat(raw.toLowerCase().replace("mb", "").trim());
  return isFinite(numeric) && numeric > 0 ? numeric : null;
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * Serve a fixture file from the rss/ directory.
 * Filename is the path segment after /feed/, without the .xml extension.
 */
const handleFeedRoute = async (
  res: http.ServerResponse,
  filename: string,
  params: URLSearchParams,
): Promise<void> => {
  // Sanitise filename — prevent path traversal
  const safe = path.basename(filename);
  if (!safe || safe.includes("..")) {
    sendError(res, 400, "Invalid filename");
    return;
  }

  // Apply delay before any other processing
  await applyDelay(params);

  // Forced HTTP status takes priority over content
  const forcedStatus = getForcedStatus(params);
  if (forcedStatus !== null && forcedStatus !== 200) {
    res.writeHead(forcedStatus, { "Content-Type": "text/plain" });
    res.end(`Simulated ${forcedStatus} response`);
    return;
  }

  // Oversized response for size-limit testing
  const sizeMb = getSizeMb(params);
  if (sizeMb !== null) {
    const xml = generateLargeContent(sizeMb);
    // Report the real size via Content-Length so the HEAD-check in secure-rss.ts fires
    const body = Buffer.from(xml, "utf-8");
    res.writeHead(forcedStatus ?? 200, {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Content-Length": String(body.byteLength),
    });
    res.end(body);
    return;
  }

  // Normal file serve
  const filePath = path.join(FIXTURES_DIR, `${safe}.xml`);

  if (!fs.existsSync(filePath)) {
    sendError(res, 404, `Fixture not found: ${safe}.xml`);
    return;
  }

  try {
    const xml = fs.readFileSync(filePath, "utf-8");
    sendXml(res, xml, forcedStatus ?? 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown read error";
    sendError(res, 500, `Failed to read fixture: ${message}`);
  }
};

/**
 * Generate N articles dynamically.
 * Query param: ?articles=N (default 5, capped at 500)
 */
const handleDynamicRoute = async (
  res: http.ServerResponse,
  params: URLSearchParams,
): Promise<void> => {
  await applyDelay(params);

  const forcedStatus = getForcedStatus(params);
  if (forcedStatus !== null && forcedStatus !== 200) {
    res.writeHead(forcedStatus, { "Content-Type": "text/plain" });
    res.end(`Simulated ${forcedStatus} response`);
    return;
  }

  const raw = params.get("articles");
  const count = raw ? Math.min(Math.max(parseInt(raw, 10) || 5, 0), 500) : 5;

  const xml = generateArticles(count);
  sendXml(res, xml, forcedStatus ?? 200);
};

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

const requestHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> => {
  // Only GET and HEAD are supported
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendError(res, 405, "Method Not Allowed");
    return;
  }

  const { pathname, params } = parseUrl(req.url);

  // Route: /feed/:filename
  const feedMatch = pathname.match(/^\/feed\/([^/]+)$/);
  if (feedMatch) {
    await handleFeedRoute(res, feedMatch[1] ?? "", params);
    return;
  }

  // Route: /dynamic
  if (pathname === "/dynamic") {
    await handleDynamicRoute(res, params);
    return;
  }

  // Health check: /health
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  sendError(res, 404, `Unknown route: ${pathname}`);
};

// ---------------------------------------------------------------------------
// Lifecycle exports
// ---------------------------------------------------------------------------

/**
 * Start the mock HTTP server on MOCK_SERVER_PORT.
 * Resolves when the server is listening and ready to accept connections.
 * Safe to call multiple times — subsequent calls are no-ops if already running.
 */
export const startMockServer = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (server) {
      // Already running
      resolve();
      return;
    }

    server = http.createServer((req, res) => {
      requestHandler(req, res).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Internal server error";
        if (!res.headersSent) {
          sendError(res, 500, message);
        }
      });
    });

    server.on("error", (err) => {
      server = null;
      reject(err);
    });

    server.listen(MOCK_SERVER_PORT, "127.0.0.1", () => {
      resolve();
    });
  });
};

/**
 * Stop the mock HTTP server.
 * Resolves when all connections are closed.
 * Safe to call when the server is not running.
 */
export const stopMockServer = (): Promise<void> => {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }

    const closing = server;
    server = null;
    closing.close(() => resolve());
  });
};

/**
 * Convenience URL builder for test code.
 * Example: mockFeedUrl("basic-feed") → "http://127.0.0.1:9999/feed/basic-feed"
 */
export const mockFeedUrl = (filename: string, params?: Record<string, string | number>): string => {
  const base = `http://127.0.0.1:${MOCK_SERVER_PORT}/feed/${encodeURIComponent(filename)}`;
  if (!params || Object.keys(params).length === 0) return base;
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  return `${base}?${qs}`;
};

/**
 * Convenience URL builder for the dynamic route.
 * Example: mockDynamicUrl(10) → "http://127.0.0.1:9999/dynamic?articles=10"
 */
export const mockDynamicUrl = (
  articleCount: number,
  params?: Record<string, string | number>,
): string => {
  const base = `http://127.0.0.1:${MOCK_SERVER_PORT}/dynamic`;
  const merged: Record<string, string> = { articles: String(articleCount) };
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      merged[k] = String(v);
    }
  }
  return `${base}?${new URLSearchParams(merged).toString()}`;
};
