import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { logger, setLogLevel, setLogFormat } from "@watch-tower/shared";

describe("logger", () => {
  beforeEach(() => {
    setLogLevel("debug");
    setLogFormat("pretty");
  });

  afterEach(() => {
    // Ensure capture is stopped
    try {
      logger.captureStop();
    } catch {
      // ignore
    }
    setLogLevel("info");
    setLogFormat("pretty");
  });

  describe("basic logging", () => {
    it("logs info messages", () => {
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      logger.info("hello world");
      expect(spy).toHaveBeenCalledWith("hello world");
      spy.mockRestore();
    });

    it("logs warn messages", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      logger.warn("watch out");
      expect(spy).toHaveBeenCalledWith("watch out");
      spy.mockRestore();
    });

    it("logs error messages", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      logger.error("bad thing happened");
      expect(spy).toHaveBeenCalledWith("bad thing happened");
      spy.mockRestore();
    });

    it("logs debug messages when level is debug", () => {
      const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
      setLogLevel("debug");
      logger.debug("debugging info");
      expect(spy).toHaveBeenCalledWith("debugging info");
      spy.mockRestore();
    });
  });

  describe("log levels", () => {
    it("suppresses debug when level is info", () => {
      const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
      setLogLevel("info");
      logger.debug("should not appear");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("suppresses info when level is warn", () => {
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      setLogLevel("warn");
      logger.info("should not appear");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("suppresses warn when level is error", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      setLogLevel("error");
      logger.warn("should not appear");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("always shows error messages", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      setLogLevel("error");
      logger.error("always visible");
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("pino-style context object", () => {
    it("passes context object when using pino-style args", () => {
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      logger.info({ userId: "abc" }, "user logged in");
      expect(spy).toHaveBeenCalledWith({ userId: "abc" }, "user logged in");
      spy.mockRestore();
    });
  });

  describe("JSON format", () => {
    it("outputs JSON when format is json", () => {
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      setLogFormat("json");
      logger.info("test message");
      expect(spy).toHaveBeenCalledTimes(1);
      const output = spy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.level).toBe("info");
      expect(parsed.msg).toBe("test message");
      expect(parsed.ts).toBeDefined();
      spy.mockRestore();
    });

    it("includes context in JSON output", () => {
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      setLogFormat("json");
      logger.info({ sourceId: 42 }, "processing");
      const parsed = JSON.parse(spy.mock.calls[0][0] as string);
      expect(parsed.sourceId).toBe(42);
      expect(parsed.msg).toBe("processing");
      spy.mockRestore();
    });
  });

  describe("child loggers", () => {
    it("creates child logger with context", () => {
      logger.captureStart();
      const child = logger.child({ jobId: "abc-123" });
      child.info("processing");
      const logs = logger.captureStop();
      expect(logs).toHaveLength(1);
      expect(logs[0].msg).toBe("processing");
      expect(logs[0].context?.jobId).toBe("abc-123");
    });

    it("merges parent and child context", () => {
      logger.captureStart();
      const parent = logger.child({ pipeline: "ingest" });
      const child = parent.child({ sourceId: 42 });
      child.info("fetching");
      const logs = logger.captureStop();
      expect(logs[0].context?.pipeline).toBe("ingest");
      expect(logs[0].context?.sourceId).toBe(42);
    });

    it("child context overrides parent for same key", () => {
      logger.captureStart();
      const parent = logger.child({ step: "start" });
      const child = parent.child({ step: "process" });
      child.info("running");
      const logs = logger.captureStop();
      expect(logs[0].context?.step).toBe("process");
    });

    it("child logger respects log level", () => {
      setLogLevel("warn");
      logger.captureStart();
      const child = logger.child({ jobId: "abc" });
      child.info("should not appear");
      child.warn("should appear");
      const logs = logger.captureStop();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe("warn");
    });
  });

  describe("log capture", () => {
    it("captures logs between start and stop", () => {
      logger.captureStart();
      logger.info("first");
      logger.warn("second");
      logger.error("third");
      const logs = logger.captureStop();
      expect(logs).toHaveLength(3);
      expect(logs[0].level).toBe("info");
      expect(logs[0].msg).toBe("first");
      expect(logs[1].level).toBe("warn");
      expect(logs[2].level).toBe("error");
    });

    it("returns empty array when no logs captured", () => {
      logger.captureStart();
      const logs = logger.captureStop();
      expect(logs).toEqual([]);
    });

    it("includes timestamp in captured logs", () => {
      logger.captureStart();
      logger.info("timestamped");
      const logs = logger.captureStop();
      expect(logs[0].ts).toBeDefined();
      // ISO 8601 format
      expect(new Date(logs[0].ts).toISOString()).toBe(logs[0].ts);
    });

    it("captures context from pino-style args", () => {
      logger.captureStart();
      logger.info({ articleId: "xyz" }, "scored article");
      const logs = logger.captureStop();
      expect(logs[0].context?.articleId).toBe("xyz");
      expect(logs[0].msg).toBe("scored article");
    });

    it("clears captured logs on stop", () => {
      logger.captureStart();
      logger.info("first batch");
      logger.captureStop();
      logger.captureStart();
      const logs = logger.captureStop();
      expect(logs).toHaveLength(0);
    });

    it("does not capture when not started", () => {
      // Just make sure no errors thrown
      logger.info("not captured");
      const logs = logger.captureStop();
      expect(logs).toHaveLength(0);
    });

    it("respects log level during capture", () => {
      setLogLevel("error");
      logger.captureStart();
      logger.info("filtered out");
      logger.error("kept");
      const logs = logger.captureStop();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe("error");
    });
  });
});
