import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LifecycleManager } from "../src/lifecycle-manager.js";
import type { Config, GroupConfig } from "../src/config.js";
import pino from "pino";

// ─── Mock ConnectionManager ───

// We mock the connection-manager module so LifecycleManager uses a fake ConnectionManager
vi.mock("../src/connection-manager.js", () => {
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const mockJoinGroup = vi.fn().mockResolvedValue(undefined);
  const mockDisconnect = vi.fn().mockResolvedValue(undefined);
  const mockGetState = vi.fn().mockReturnValue("disconnected");

  class MockConnectionManager {
    connect = mockConnect;
    joinGroup = mockJoinGroup;
    disconnect = mockDisconnect;
    getState = mockGetState;

    constructor(public readonly options: Record<string, unknown>) {
      // Store the onConnectionStateChange callback for testing
      MockConnectionManager.lastInstance = this;
      MockConnectionManager.lastOptions = options;
    }

    static lastInstance: MockConnectionManager | null = null;
    static lastOptions: Record<string, unknown> | null = null;
    static mockConnect = mockConnect;
    static mockJoinGroup = mockJoinGroup;
    static mockDisconnect = mockDisconnect;
    static mockGetState = mockGetState;

    static resetAll(): void {
      mockConnect.mockClear().mockResolvedValue(undefined);
      mockJoinGroup.mockClear().mockResolvedValue(undefined);
      mockDisconnect.mockClear().mockResolvedValue(undefined);
      mockGetState.mockClear().mockReturnValue("disconnected");
      MockConnectionManager.lastInstance = null;
      MockConnectionManager.lastOptions = null;
    }
  }

  return {
    ConnectionManager: MockConnectionManager,
    getReconnectDelay: (attempt: number, delays: number[]) =>
      delays[Math.min(attempt, delays.length - 1)],
  };
});

// Import the mocked module to access static helpers
const { ConnectionManager: MockCM } = await import("../src/connection-manager.js");
const MockConnectionManager = MockCM as unknown as {
  lastInstance: {
    options: Record<string, unknown>;
    connect: ReturnType<typeof vi.fn>;
    joinGroup: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  } | null;
  lastOptions: Record<string, unknown> | null;
  mockConnect: ReturnType<typeof vi.fn>;
  mockJoinGroup: ReturnType<typeof vi.fn>;
  mockDisconnect: ReturnType<typeof vi.fn>;
  mockGetState: ReturnType<typeof vi.fn>;
  resetAll: () => void;
};

// ─── Helpers ───

function createMockLogger(): pino.Logger {
  return pino({ level: "silent" });
}

function createMockGroupConfig(overrides?: Partial<GroupConfig>): GroupConfig {
  return {
    group_id: "550e8400-e29b-41d4-a716-446655440000",
    group_name: "Test Group",
    slug: "test-group",
    docs_path: "./test-docs",
    chunk_size: 1000,
    chunk_overlap: 200,
    top_k: 5,
    max_concurrency: 2,
    ...overrides,
  };
}

function createMockConfig(groups?: GroupConfig[]): Config {
  return {
    meshimize: {
      server_url: "https://api.meshimize.com",
      api_key: "test-api-key-123",
      ws_path: "/socket/websocket",
    },
    llm: {
      provider: "openai",
      model: "gpt-4o-mini",
      api_key: "test-llm-key",
      max_tokens: 1000,
      temperature: 0.3,
    },
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      api_key: "test-embed-key",
      dimensions: 1536,
      batch_size: 500,
      requests_per_minute: 3000,
    },
    vector_store: {
      provider: "chromadb",
      persist_directory: "./data/chromadb",
      collection_prefix: "meshimize",
      distance_metric: "cosine",
      stale_days: 7,
    },
    agent: {
      queue_max_depth: 50,
      reconnect_delays_ms: [1000, 2000, 5000, 10000, 30000],
      health_port: 8080,
      health_summary_interval_s: 300,
      shutdown_timeout_ms: 10000,
      log_level: "info",
    },
    groups: groups ?? [createMockGroupConfig()],
  };
}

// ─── Tests ───

describe("LifecycleManager", () => {
  beforeEach(() => {
    MockConnectionManager.resetAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should create ConnectionManager, connect, and join all groups on start", async () => {
    const group1 = createMockGroupConfig({
      group_id: "550e8400-e29b-41d4-a716-446655440001",
      group_name: "Group One",
      slug: "group-one",
    });
    const group2 = createMockGroupConfig({
      group_id: "550e8400-e29b-41d4-a716-446655440002",
      group_name: "Group Two",
      slug: "group-two",
    });
    const config = createMockConfig([group1, group2]);

    const lm = new LifecycleManager({
      config,
      logger: createMockLogger(),
      version: "0.1.0",
    });

    await lm.start();

    // ConnectionManager should have been created
    expect(MockConnectionManager.lastInstance).not.toBeNull();

    // connect() should have been called once
    expect(MockConnectionManager.mockConnect).toHaveBeenCalledTimes(1);

    // joinGroup should have been called for each group
    expect(MockConnectionManager.mockJoinGroup).toHaveBeenCalledTimes(2);
    expect(MockConnectionManager.mockJoinGroup).toHaveBeenCalledWith(group1);
    expect(MockConnectionManager.mockJoinGroup).toHaveBeenCalledWith(group2);
  });

  it("should call disconnect on ConnectionManager during shutdown", async () => {
    const lm = new LifecycleManager({
      config: createMockConfig(),
      logger: createMockLogger(),
      version: "0.1.0",
    });

    await lm.start();
    await lm.shutdown();

    expect(MockConnectionManager.mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it("should track connection state via onConnectionStateChange callback", async () => {
    const lm = new LifecycleManager({
      config: createMockConfig(),
      logger: createMockLogger(),
      version: "0.1.0",
    });

    expect(lm.getConnectionState()).toBe("disconnected");

    await lm.start();

    // Simulate the ConnectionManager calling the onConnectionStateChange callback
    const cmOptions = MockConnectionManager.lastOptions as {
      onConnectionStateChange: (state: string) => void;
    };
    expect(cmOptions.onConnectionStateChange).toBeDefined();

    cmOptions.onConnectionStateChange("connecting");
    expect(lm.getConnectionState()).toBe("connecting");

    cmOptions.onConnectionStateChange("connected");
    expect(lm.getConnectionState()).toBe("connected");
  });

  it("should reset connection state to disconnected after shutdown", async () => {
    const lm = new LifecycleManager({
      config: createMockConfig(),
      logger: createMockLogger(),
      version: "0.1.0",
    });

    await lm.start();

    // Simulate connected state
    const cmOptions = MockConnectionManager.lastOptions as {
      onConnectionStateChange: (state: string) => void;
    };
    cmOptions.onConnectionStateChange("connected");
    expect(lm.getConnectionState()).toBe("connected");

    await lm.shutdown();
    expect(lm.getConnectionState()).toBe("disconnected");
  });
});
