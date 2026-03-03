import { describe, it, expect, afterEach } from "vitest";
import { startHealthServer } from "../src/health-server.js";
import type { HealthResponse } from "../src/types.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// ─── Helpers ───

function healthyResponse(): HealthResponse {
  return {
    status: "healthy",
    version: "0.1.0",
    uptime_seconds: 42,
    groups: [
      {
        group_id: "550e8400-e29b-41d4-a716-446655440000",
        group_name: "Test Group",
        status: "ready",
        queue_depth: 0,
        answered_count: 5,
      },
    ],
    connection: "connected",
  };
}

function degradedResponse(): HealthResponse {
  return {
    status: "degraded",
    version: "0.1.0",
    uptime_seconds: 100,
    groups: [],
    connection: "disconnected",
  };
}

async function startAndGetPort(
  getHealth: () => HealthResponse,
): Promise<{ server: Server; port: number }> {
  const srv = await startHealthServer(0, getHealth);
  const addr = srv.address() as AddressInfo;
  return { server: srv, port: addr.port };
}

// ─── Tests ───

describe("health-server", () => {
  let server: Server | undefined;

  afterEach(() => {
    return new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
        server = undefined;
      } else {
        resolve();
      }
    });
  });

  it("should return 200 for healthy status on GET /health", async () => {
    const result = await startAndGetPort(healthyResponse);
    server = result.server;

    const res = await fetch(`http://127.0.0.1:${result.port}/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe("healthy");
  });

  it("should return 503 for degraded status on GET /health", async () => {
    const result = await startAndGetPort(degradedResponse);
    server = result.server;

    const res = await fetch(`http://127.0.0.1:${result.port}/health`);
    expect(res.status).toBe(503);

    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe("degraded");
  });

  it("should return correct JSON shape on GET /health", async () => {
    const result = await startAndGetPort(healthyResponse);
    server = result.server;

    const res = await fetch(`http://127.0.0.1:${result.port}/health`);
    const body = (await res.json()) as HealthResponse;

    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("uptime_seconds");
    expect(body).toHaveProperty("groups");
    expect(body).toHaveProperty("connection");
    expect(Array.isArray(body.groups)).toBe(true);

    // Verify group shape
    expect(body.groups[0]).toHaveProperty("group_id");
    expect(body.groups[0]).toHaveProperty("group_name");
    expect(body.groups[0]).toHaveProperty("status");
    expect(body.groups[0]).toHaveProperty("queue_depth");
    expect(body.groups[0]).toHaveProperty("answered_count");
  });

  it("should return 404 for unknown paths", async () => {
    const result = await startAndGetPort(healthyResponse);
    server = result.server;

    const res = await fetch(`http://127.0.0.1:${result.port}/unknown`);
    expect(res.status).toBe(404);
  });

  it("should start and stop cleanly", async () => {
    const result = await startAndGetPort(healthyResponse);
    server = result.server;
    const port = result.port;

    // Verify it's running
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    // Close the server
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
    server = undefined;

    // Verify it's stopped - fetch should throw
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
