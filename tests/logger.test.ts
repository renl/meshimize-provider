import { describe, it, expect } from "vitest";
import { createLogger } from "../src/logger.js";
import pino from "pino";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("logger", () => {
  it("should create a logger with the correct level", () => {
    const logger = createLogger("debug");
    expect(logger.level).toBe("debug");

    const loggerInfo = createLogger("info");
    expect(loggerInfo.level).toBe("info");
  });

  it("should redact api_key fields in log output", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "meshimize-logger-test-"));
    const logFile = join(tempDir, "test.log");

    const dest = pino.destination({ dest: logFile, sync: true });
    try {
      const logger = createLogger("info", dest);

      logger.info({ api_key: "super-secret-key" }, "test message");
      dest.flushSync();

      const output = readFileSync(logFile, "utf-8");
      const parsed = JSON.parse(output.trim()) as Record<string, unknown>;

      expect(parsed.api_key).toBe("[REDACTED]");
      expect(output).not.toContain("super-secret-key");
    } finally {
      dest.destroy();
      // Allow file handle to fully release on Windows
      await new Promise((resolve) => setTimeout(resolve, 50));
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should include ISO timestamp in log output", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "meshimize-logger-test-"));
    const logFile = join(tempDir, "test.log");

    const dest = pino.destination({ dest: logFile, sync: true });
    try {
      const logger = createLogger("info", dest);

      logger.info("timestamp test");
      dest.flushSync();

      const output = readFileSync(logFile, "utf-8");
      const parsed = JSON.parse(output.trim()) as Record<string, unknown>;

      // ISO timestamp should be present and match ISO 8601 pattern
      expect(parsed.time).toBeDefined();
      expect(typeof parsed.time).toBe("string");
      expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } finally {
      dest.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should format level as label string instead of numeric", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "meshimize-logger-test-"));
    const logFile = join(tempDir, "test.log");

    const dest = pino.destination({ dest: logFile, sync: true });
    try {
      const logger = createLogger("info", dest);

      logger.info("level format test");
      dest.flushSync();

      const output = readFileSync(logFile, "utf-8");
      const parsed = JSON.parse(output.trim()) as Record<string, unknown>;

      expect(parsed.level).toBe("info");
      expect(typeof parsed.level).toBe("string");
    } finally {
      dest.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
