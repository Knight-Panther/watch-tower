export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "pretty" | "json";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";
let currentFormat: LogFormat = "pretty";

export const setLogLevel = (level: LogLevel) => {
  currentLevel = level;
};

export const setLogFormat = (format: LogFormat) => {
  currentFormat = format;
};

const shouldLog = (level: LogLevel): boolean =>
  LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];

// ─── Log Capture (for testing) ──────────────────────────────────────────────

export type CapturedLog = {
  level: LogLevel;
  msg: string;
  context?: Record<string, unknown>;
  args: unknown[];
  ts: string;
};

let capturing = false;
let capturedLogs: CapturedLog[] = [];

// ─── Core log function ──────────────────────────────────────────────────────

// Use dynamic lookup so vi.spyOn can intercept in tests
const getConsoleMethod = (level: LogLevel): ((...args: unknown[]) => void) => {
  switch (level) {
    case "debug":
      return console.debug;
    case "info":
      return console.info;
    case "warn":
      return console.warn;
    case "error":
      return console.error;
  }
};

/**
 * Parse args into context object + message string.
 * Supports two calling conventions:
 *   logger.info("message", extra...)         — string-first
 *   logger.info({ key: val }, "message")     — pino-style: context-first
 */
const parseArgs = (
  args: unknown[],
): { context?: Record<string, unknown>; msg: string; rest: unknown[] } => {
  if (args.length === 0) return { msg: "", rest: [] };

  // Pino-style: first arg is plain object, second is string
  if (
    args.length >= 2 &&
    typeof args[0] === "object" &&
    args[0] !== null &&
    !Array.isArray(args[0]) &&
    typeof args[1] === "string"
  ) {
    return {
      context: args[0] as Record<string, unknown>,
      msg: args[1],
      rest: args.slice(2),
    };
  }

  // String-first: first arg is the message
  if (typeof args[0] === "string") {
    return { msg: args[0], rest: args.slice(1) };
  }

  // Fallback: stringify first arg
  return { msg: String(args[0]), rest: args.slice(1) };
};

const emit = (
  level: LogLevel,
  baseContext: Record<string, unknown> | undefined,
  args: unknown[],
) => {
  if (!shouldLog(level)) return;

  const { context: callContext, msg, rest } = parseArgs(args);
  const merged = { ...baseContext, ...callContext };
  const ts = new Date().toISOString();

  // Capture for tests
  if (capturing) {
    capturedLogs.push({
      level,
      msg,
      context: Object.keys(merged).length > 0 ? merged : undefined,
      args: rest,
      ts,
    });
  }

  if (currentFormat === "json") {
    const entry: Record<string, unknown> = { ts, level, msg, ...merged };
    // Append rest args as 'extra' if present
    if (rest.length === 1) entry.extra = rest[0];
    else if (rest.length > 1) entry.extra = rest;
    getConsoleMethod(level)(JSON.stringify(entry));
  } else {
    // Pretty: original behavior — pass everything to console
    if (Object.keys(merged).length > 0) {
      getConsoleMethod(level)(merged, msg, ...rest);
    } else {
      getConsoleMethod(level)(msg, ...rest);
    }
  }
};

// ─── Logger type ────────────────────────────────────────────────────────────

export type Logger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  child: (context: Record<string, unknown>) => Logger;
};

const createLogger = (baseContext?: Record<string, unknown>): Logger => ({
  debug: (...args: unknown[]) => emit("debug", baseContext, args),
  info: (...args: unknown[]) => emit("info", baseContext, args),
  warn: (...args: unknown[]) => emit("warn", baseContext, args),
  error: (...args: unknown[]) => emit("error", baseContext, args),
  child: (ctx: Record<string, unknown>) => createLogger({ ...baseContext, ...ctx }),
});

// ─── Public API ─────────────────────────────────────────────────────────────

export const logger: Logger & {
  captureStart: () => void;
  captureStop: () => CapturedLog[];
} = {
  ...createLogger(),
  /**
   * Start capturing all log output. Useful in tests:
   *   logger.captureStart();
   *   await doSomething();
   *   const logs = logger.captureStop();
   *   expect(logs.filter(l => l.level === "error")).toHaveLength(0);
   */
  captureStart: () => {
    capturing = true;
    capturedLogs = [];
  },
  captureStop: () => {
    capturing = false;
    const result = capturedLogs;
    capturedLogs = [];
    return result;
  },
};
