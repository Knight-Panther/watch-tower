export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export const setLogLevel = (level: LogLevel) => {
  currentLevel = level;
};

const shouldLog = (level: LogLevel): boolean =>
  LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];

export const logger = {
  debug: (...args: unknown[]) => shouldLog("debug") && console.debug(...args),
  info: (...args: unknown[]) => shouldLog("info") && console.info(...args),
  warn: (...args: unknown[]) => shouldLog("warn") && console.warn(...args),
  error: (...args: unknown[]) => shouldLog("error") && console.error(...args),
};
