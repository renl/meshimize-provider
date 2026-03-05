import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LifecycleManager } from "../src/lifecycle-manager.js";
import type { Config, GroupConfig } from "../src/config.js";
import pino from "pino";

// ─── Mock ConnectionManager ───

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
      mockConnect.mockReset().mockResolvedValue(undefined);
      mockJoinGroup.mockReset().mockResolvedValue(undefined);
      mockDisconnect.mockReset().mockResolvedValue(undefined);
      mockGetState.mockReset().mockReturnValue("disconnected");
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

// ─── Mock RagPipeline ───

const mockNeedsIngestion = vi.fn().mockResolvedValue(false);
const mockIngest = vi.fn().mockResolvedValue({
  groupId: "test",
  groupName: "Test",
  docCount: 5,
  chunkCount: 20,
  durationMs: 100,
});
const mockRetrieve = vi.fn().mockResolvedValue([]);

vi.mock("../src/rag-pipeline.js", () => ({
  RagPipeline: vi.fn().mockImplementation(() => ({
    needsIngestion: mockNeedsIngestion,
    ingest: mockIngest,
    retrieve: mockRetrieve,
  })),
}));

// ─── Mock ChromaDB (for waitForChromaDb readiness loop) ───

const mockHeartbeat = vi.fn().mockResolvedValue({ "nanosecond heartbeat": 1234567890 });

vi.mock("chromadb", () => ({
  ChromaClient: vi.fn().mockImplementation(() => ({
    heartbeat: mockHeartbeat,
  })),
}));

// ─── Mock AnswerGenerator ───

const mockGenerate = vi.fn().mockResolvedValue({
  content: "Test answer",
  answerType: "llm_answer",
  promptTokens: 100,
  completionTokens: 20,
  llmMs: 500,
});

vi.mock("../src/answer-generator.js", () => ({
  AnswerGenerator: vi.fn().mockImplementation(() => ({
    generate: mockGenerate,
  })),
}));

// ─── Mock AnswerPoster ───

const mockPost = vi.fn().mockResolvedValue({
  success: true,
  httpStatus: 201,
  deadLettered: false,
});

vi.mock("../src/answer-poster.js", () => ({
  AnswerPoster: vi.fn().mockImplementation(() => ({
    post: mockPost,
  })),
}));

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
      model: "qwen3.5-flash",
      api_key: "test-llm-key",
      max_tokens: 1000,
      temperature: 0.3,
    },
    embedding: {
      provider: "openai",
      model: "text-embedding-v4",
      api_key: "test-embed-key",
      dimensions: 1536,
      batch_size: 10,
      requests_per_minute: 3000,
    },
    vector_store: {
      provider: "chromadb",
      persist_directory: "http://localhost:8000",
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
    // Use mockReset() (not mockClear()) so that changed implementations
    // (e.g. .mockRejectedValue()) don't leak between tests, then re-apply defaults.
    mockNeedsIngestion.mockReset().mockResolvedValue(false);
    mockIngest.mockReset().mockResolvedValue({
      groupId: "test",
      groupName: "Test",
      docCount: 5,
      chunkCount: 20,
      durationMs: 100,
    });
    mockRetrieve.mockReset().mockResolvedValue([]);
    mockGenerate.mockReset().mockResolvedValue({
      content: "Test answer",
      answerType: "llm_answer",
      promptTokens: 100,
      completionTokens: 20,
      llmMs: 500,
    });
    mockPost.mockReset().mockResolvedValue({
      success: true,
      httpStatus: 201,
      deadLettered: false,
    });
    mockHeartbeat.mockReset().mockResolvedValue({ "nanosecond heartbeat": 1234567890 });
  });

  afterEach(() => {
    vi.clearAllMocks();
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

    expect(MockConnectionManager.lastInstance).not.toBeNull();
    expect(MockConnectionManager.mockConnect).toHaveBeenCalledTimes(1);
    expect(MockConnectionManager.mockJoinGroup).toHaveBeenCalledTimes(2);
    expect(MockConnectionManager.mockJoinGroup).toHaveBeenCalledWith(group1);
    expect(MockConnectionManager.mockJoinGroup).toHaveBeenCalledWith(group2);

    await lm.shutdown();
  });

  it("should call router.stop() then router.drain() during graceful shutdown", async () => {
    const lm = new LifecycleManager({
      config: createMockConfig(),
      logger: createMockLogger(),
      version: "0.1.0",
    });

    await lm.start();

    const router = lm.getQuestionRouter()!;
    const stopSpy = vi.spyOn(router, "stop");
    const drainSpy = vi.spyOn(router, "drain");

    await lm.shutdown();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledTimes(1);
    // stop() called before drain()
    expect(stopSpy.mock.invocationCallOrder[0]).toBeLessThan(drainSpy.mock.invocationCallOrder[0]);
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

    const cmOptions = MockConnectionManager.lastOptions as {
      onConnectionStateChange: (state: string) => void;
    };
    expect(cmOptions.onConnectionStateChange).toBeDefined();

    cmOptions.onConnectionStateChange("connecting");
    expect(lm.getConnectionState()).toBe("connecting");

    cmOptions.onConnectionStateChange("connected");
    expect(lm.getConnectionState()).toBe("connected");

    await lm.shutdown();
  });

  it("should reset connection state to disconnected after shutdown", async () => {
    const lm = new LifecycleManager({
      config: createMockConfig(),
      logger: createMockLogger(),
      version: "0.1.0",
    });

    await lm.start();

    const cmOptions = MockConnectionManager.lastOptions as {
      onConnectionStateChange: (state: string) => void;
    };
    cmOptions.onConnectionStateChange("connected");
    expect(lm.getConnectionState()).toBe("connected");

    await lm.shutdown();
    expect(lm.getConnectionState()).toBe("disconnected");
  });

  it("should run ingestion for groups that need it before connecting", async () => {
    mockNeedsIngestion.mockResolvedValue(true);

    const group = createMockGroupConfig();
    const lm = new LifecycleManager({
      config: createMockConfig([group]),
      logger: createMockLogger(),
      version: "0.1.0",
    });

    await lm.start();

    expect(mockNeedsIngestion).toHaveBeenCalledTimes(1);
    expect(mockIngest).toHaveBeenCalledTimes(1);
    // Ingestion should happen before connect
    expect(mockIngest.mock.invocationCallOrder[0]).toBeLessThan(
      MockConnectionManager.mockConnect.mock.invocationCallOrder[0],
    );

    await lm.shutdown();
  });

  it("should reach ready state after all groups joined", async () => {
    const group1 = createMockGroupConfig({
      group_id: "550e8400-e29b-41d4-a716-446655440001",
      slug: "group-one",
    });
    const group2 = createMockGroupConfig({
      group_id: "550e8400-e29b-41d4-a716-446655440002",
      slug: "group-two",
    });

    const lm = new LifecycleManager({
      config: createMockConfig([group1, group2]),
      logger: createMockLogger(),
      version: "0.1.0",
    });

    expect(lm.isStarted()).toBe(false);

    await lm.start();

    expect(lm.isStarted()).toBe(true);
    expect(MockConnectionManager.mockJoinGroup).toHaveBeenCalledTimes(2);

    await lm.shutdown();
  });

  it("should handle connection failure during startup gracefully", async () => {
    MockConnectionManager.mockConnect.mockRejectedValue(new Error("Connection refused"));

    const lm = new LifecycleManager({
      config: createMockConfig(),
      logger: createMockLogger(),
      version: "0.1.0",
    });

    await expect(lm.start()).rejects.toThrow("Connection refused");
    expect(lm.isStarted()).toBe(false);
  });

  it("should return questionRouter after start via getQuestionRouter", async () => {
    const lm = new LifecycleManager({
      config: createMockConfig(),
      logger: createMockLogger(),
      version: "0.1.0",
    });

    expect(lm.getQuestionRouter()).toBeNull();

    await lm.start();

    const router = lm.getQuestionRouter();
    expect(router).not.toBeNull();
    expect(router!.getStats()).toHaveLength(1);

    await lm.shutdown();
  });

  it("should mark groups as degraded when ingestion fails", async () => {
    mockNeedsIngestion.mockResolvedValue(true);
    mockIngest.mockRejectedValue(new Error("ChromaDB unavailable"));

    const group = createMockGroupConfig();
    const lm = new LifecycleManager({
      config: createMockConfig([group]),
      logger: createMockLogger(),
      version: "0.1.0",
    });

    await lm.start();

    const router = lm.getQuestionRouter()!;
    const stats = router.getStats();
    expect(stats[0].status).toBe("degraded");

    await lm.shutdown();
  });

  it("should wait for ChromaDB readiness before ingestion", async () => {
    // ChromaDB fails twice, then succeeds
    mockHeartbeat
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ "nanosecond heartbeat": 1234567890 });

    mockNeedsIngestion.mockResolvedValue(true);

    const lm = new LifecycleManager({
      config: createMockConfig(),
      logger: createMockLogger(),
      version: "0.1.0",
      chromaDbMaxRetries: 10,
      chromaDbInitialDelayMs: 0,
    });

    await lm.start();

    // Heartbeat called 3 times (2 failures + 1 success)
    expect(mockHeartbeat).toHaveBeenCalledTimes(3);
    // Ingestion should still proceed after ChromaDB becomes ready
    expect(mockNeedsIngestion).toHaveBeenCalledTimes(1);
    expect(mockIngest).toHaveBeenCalledTimes(1);

    await lm.shutdown();
  });

  it("should skip ingestion and mark groups degraded when ChromaDB never becomes ready", async () => {
    // ChromaDB never responds — fail all retries
    mockHeartbeat.mockRejectedValue(new Error("ECONNREFUSED"));

    const group = createMockGroupConfig();
    const lm = new LifecycleManager({
      config: createMockConfig([group]),
      logger: createMockLogger(),
      version: "0.1.0",
      chromaDbMaxRetries: 10,
      chromaDbInitialDelayMs: 0,
    });

    await lm.start();

    // Heartbeat called maxRetries (10) times
    expect(mockHeartbeat).toHaveBeenCalledTimes(10);
    // Ingestion should NOT have been attempted
    expect(mockNeedsIngestion).not.toHaveBeenCalled();
    expect(mockIngest).not.toHaveBeenCalled();

    // Group should be degraded
    const router = lm.getQuestionRouter()!;
    const stats = router.getStats();
    expect(stats[0].status).toBe("degraded");

    await lm.shutdown();
  });

  it("should succeed on first heartbeat without retries", async () => {
    // ChromaDB ready immediately
    mockHeartbeat.mockResolvedValueOnce({ "nanosecond heartbeat": 1234567890 });

    const lm = new LifecycleManager({
      config: createMockConfig(),
      logger: createMockLogger(),
      version: "0.1.0",
      chromaDbMaxRetries: 10,
      chromaDbInitialDelayMs: 0,
    });

    await lm.start();

    expect(mockHeartbeat).toHaveBeenCalledTimes(1);

    await lm.shutdown();
  });
});
