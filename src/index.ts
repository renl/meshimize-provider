import { loadConfig, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { startHealthServer } from "./health-server.js";
import type { HealthResponse } from "./types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Read version from package.json
function getVersion(): string {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(currentDir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const version = getVersion();
  const cliArgs = process.argv.slice(2);
  const configPath =
    cliArgs.find((arg) => !arg.startsWith("-")) || "config/meshimize-provider.yaml";

  // Load and validate configuration
  let config: Config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error("Failed to load config:", err);
    process.exit(1);
  }

  // Initialize logger
  const logger = createLogger(config.agent.log_level);
  logger.info({ version, configPath }, "meshimize-provider starting");

  // Track startup time for uptime calculation
  const startTime = Date.now();

  // Health response builder
  const getHealth = (): HealthResponse => ({
    status: "starting",
    version,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    groups: config.groups.map((g) => ({
      group_id: g.group_id,
      group_name: g.group_name,
      status: "initializing",
      queue_depth: 0,
      answered_count: 0,
    })),
    connection: "disconnected",
  });

  // Start health server
  const healthServer = await startHealthServer(config.agent.health_port, getHealth);
  logger.info({ port: config.agent.health_port }, "Health server started");

  // Graceful shutdown (idempotent)
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down...");
    healthServer.close(() => {
      logger.info("Health server closed");
      process.exit(0);
    });
    // Force exit after timeout
    setTimeout(() => {
      logger.warn("Shutdown timeout — forcing exit");
      process.exit(1);
    }, config.agent.shutdown_timeout_ms);
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  logger.info("meshimize-provider ready (Slice 2 — config + health only)");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
