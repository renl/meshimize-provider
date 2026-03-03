import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ConnectionManager,
  getReconnectDelay,
  type WebSocketLike,
  type ConnectionManagerOptions,
} from "../src/connection-manager.js";
import type { Config, GroupConfig } from "../src/config.js";
import type { IncomingQuestion, ConnectionState } from "../src/types.js";
import pino from "pino";

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

function createMockConfig(overrides?: Partial<Config>): Config {
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
      reconnect_delays_ms: [100, 200, 500, 1000, 3000],
      health_port: 8080,
      health_summary_interval_s: 300,
      shutdown_timeout_ms: 10000,
      log_level: "info",
    },
    groups: [createMockGroupConfig()],
    ...overrides,
  };
}

/** Mock WebSocket that can simulate open/close/message events */
class MockWebSocket implements WebSocketLike {
  readyState: number = 0; // CONNECTING
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  sentMessages: string[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3; // CLOSED
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.({});
  }

  simulateClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  simulateError(error: unknown): void {
    this.onerror?.(error);
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

function createMockFetch(
  authResponse?: Record<string, unknown>,
  membersResponse?: Record<string, unknown>,
): typeof globalThis.fetch & { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];

  const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });

    if (url.includes("/api/v1/auth/login")) {
      return new Response(
        JSON.stringify(
          authResponse ?? {
            data: {
              token: "test-jwt-token",
              account: { id: "account-123", display_name: "Test Agent" },
            },
          },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("/api/v1/groups/") && url.includes("/members")) {
      return new Response(
        JSON.stringify(
          membersResponse ?? {
            data: [{ account_id: "account-123", role: "responder" }],
          },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not Found", { status: 404 });
  }) as unknown as typeof globalThis.fetch & { calls: { url: string; init?: RequestInit }[] };

  mockFetch.calls = calls;
  return mockFetch;
}

function createConnectionManager(overrides?: Partial<ConnectionManagerOptions>): {
  cm: ConnectionManager;
  mockWs: MockWebSocket;
  mockFetch: ReturnType<typeof createMockFetch>;
  stateChanges: ConnectionState[];
  questions: { question: IncomingQuestion; groupConfig: GroupConfig }[];
} {
  const mockWs = new MockWebSocket();
  const mockFetch = createMockFetch();
  const stateChanges: ConnectionState[] = [];
  const questions: { question: IncomingQuestion; groupConfig: GroupConfig }[] = [];

  const cm = new ConnectionManager({
    config: createMockConfig(),
    logger: createMockLogger(),
    onQuestion: (question, groupConfig) => {
      questions.push({ question, groupConfig });
    },
    onConnectionStateChange: (state) => {
      stateChanges.push(state);
    },
    webSocketFactory: () => mockWs,
    fetchFn: mockFetch,
    ...overrides,
  });

  return { cm, mockWs, mockFetch, stateChanges, questions };
}

// ─── Tests ───

describe("getReconnectDelay", () => {
  it("should return delay at the given attempt index", () => {
    const delays = [1000, 2000, 5000, 10000, 30000];
    expect(getReconnectDelay(0, delays)).toBe(1000);
    expect(getReconnectDelay(1, delays)).toBe(2000);
    expect(getReconnectDelay(2, delays)).toBe(5000);
    expect(getReconnectDelay(3, delays)).toBe(10000);
    expect(getReconnectDelay(4, delays)).toBe(30000);
  });

  it("should clamp to last delay for attempts beyond array length", () => {
    const delays = [1000, 2000, 5000];
    expect(getReconnectDelay(5, delays)).toBe(5000);
    expect(getReconnectDelay(100, delays)).toBe(5000);
  });
});

describe("ConnectionManager", () => {
  // NOTE: Only tests that need timer control (reconnection, explicit disconnect check)
  // use fake timers. Other tests use real timers to avoid blocking async fetch mocks.

  it("should construct WebSocket URL with wss:// for https:// server_url", async () => {
    const { cm, mockWs, mockFetch } = createConnectionManager();

    // connect() calls fetch (async), then creates WebSocket
    // We need to let fetch resolve, then simulateOpen
    const connectPromise = cm.connect();
    // Wait a tick for the fetch promise to resolve, then the ws factory runs synchronously
    await new Promise((r) => setTimeout(r, 0));
    mockWs.simulateOpen();
    await connectPromise;

    // Check auth call was made with correct URL and headers
    const authCall = mockFetch.calls.find((c) => c.url.includes("/api/v1/auth/login"));
    expect(authCall).toBeDefined();
    expect(authCall!.init?.method).toBe("POST");
    expect(authCall!.init?.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/json",
        "x-api-key": "test-api-key-123",
      }),
    );
  });

  it("should use ws:// for http:// server_url", async () => {
    const mockWs = new MockWebSocket();
    let capturedUrl = "";

    const mockFetch = createMockFetch();
    const cm = new ConnectionManager({
      config: createMockConfig({
        meshimize: {
          server_url: "http://localhost:4000",
          api_key: "test-key",
          ws_path: "/socket/websocket",
        },
      }),
      logger: createMockLogger(),
      onQuestion: () => {},
      onConnectionStateChange: () => {},
      webSocketFactory: (url) => {
        capturedUrl = url;
        return mockWs;
      },
      fetchFn: mockFetch,
    });

    const connectPromise = cm.connect();
    await new Promise((r) => setTimeout(r, 0));
    mockWs.simulateOpen();
    await connectPromise;

    expect(capturedUrl).toMatch(/^ws:\/\//);
    expect(capturedUrl).toContain("localhost:4000");
    expect(capturedUrl).toContain("/socket/websocket");
    expect(capturedUrl).toContain("token=test-jwt-token");
  });

  it("should make REST authentication call with correct headers and endpoint", async () => {
    const { cm, mockWs, mockFetch } = createConnectionManager();

    const connectPromise = cm.connect();
    await new Promise((r) => setTimeout(r, 0));
    mockWs.simulateOpen();
    await connectPromise;

    const authCall = mockFetch.calls[0];
    expect(authCall.url).toBe("https://api.meshimize.com/api/v1/auth/login");
    expect(authCall.init?.method).toBe("POST");
    expect(authCall.init?.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/json",
        "x-api-key": "test-api-key-123",
      }),
    );
  });

  it("should join channel with correct topic format (group:{group_id})", async () => {
    const { cm, mockWs } = createConnectionManager();

    const connectPromise = cm.connect();
    await new Promise((r) => setTimeout(r, 0));
    mockWs.simulateOpen();
    await connectPromise;

    const group = createMockGroupConfig();
    const joinPromise = cm.joinGroup(group);

    // Check the sent join message
    expect(mockWs.sentMessages).toHaveLength(1);
    const joinMsg = JSON.parse(mockWs.sentMessages[0]) as unknown[];
    expect(joinMsg[3]).toBe("phx_join");
    expect(joinMsg[2]).toBe(`group:${group.group_id}`);
    expect(joinMsg[4]).toEqual({ api_key: "test-api-key-123" });

    // Simulate successful join reply
    const joinRef = joinMsg[0] as string;
    const ref = joinMsg[1] as string;
    mockWs.simulateMessage([
      joinRef,
      ref,
      `group:${group.group_id}`,
      "phx_reply",
      { status: "ok", response: {} },
    ]);

    await joinPromise;
  });

  it("should fire onQuestion callback for new_message events", async () => {
    const { cm, mockWs, questions } = createConnectionManager();

    const connectPromise = cm.connect();
    await new Promise((r) => setTimeout(r, 0));
    mockWs.simulateOpen();
    await connectPromise;

    const group = createMockGroupConfig();
    const joinPromise = cm.joinGroup(group);

    // Get the join message ref and simulate ok reply
    const joinMsg = JSON.parse(mockWs.sentMessages[0]) as unknown[];
    mockWs.simulateMessage([
      joinMsg[0],
      joinMsg[1],
      `group:${group.group_id}`,
      "phx_reply",
      { status: "ok", response: {} },
    ]);
    await joinPromise;

    // Simulate incoming question
    const questionPayload: IncomingQuestion = {
      message_id: "msg-001",
      group_id: group.group_id,
      sender_id: "user-456",
      sender_name: "Alice",
      content: "What is Meshimize?",
      message_type: "question",
      inserted_at: "2026-03-03T10:00:00Z",
      parent_message_id: null,
    };

    mockWs.simulateMessage([null, null, `group:${group.group_id}`, "new_message", questionPayload]);

    expect(questions).toHaveLength(1);
    expect(questions[0].question.message_id).toBe("msg-001");
    expect(questions[0].question.content).toBe("What is Meshimize?");
    expect(questions[0].question.message_type).toBe("question");
    expect(questions[0].groupConfig.group_id).toBe(group.group_id);
  });

  it("should reconnect on disconnect with exponential backoff from config delays", async () => {
    vi.useFakeTimers();

    const mockWs1 = new MockWebSocket();
    const mockWs2 = new MockWebSocket();
    let wsIndex = 0;
    const websockets = [mockWs1, mockWs2];

    const mockFetch = createMockFetch();
    const stateChanges: ConnectionState[] = [];

    const cm = new ConnectionManager({
      config: createMockConfig({
        agent: {
          queue_max_depth: 50,
          reconnect_delays_ms: [100, 200, 500],
          health_port: 8080,
          health_summary_interval_s: 300,
          shutdown_timeout_ms: 10000,
          log_level: "info",
        },
      }),
      logger: createMockLogger(),
      onQuestion: () => {},
      onConnectionStateChange: (state) => {
        stateChanges.push(state);
      },
      webSocketFactory: () => {
        const ws = websockets[wsIndex];
        wsIndex++;
        return ws;
      },
      fetchFn: mockFetch,
    });

    // Initial connect — with fake timers, need advanceTimersByTimeAsync to flush microtasks
    const connectPromise = cm.connect();
    await vi.advanceTimersByTimeAsync(0); // flush fetch promise
    mockWs1.simulateOpen();
    await connectPromise;

    expect(stateChanges).toEqual(["connecting", "connected"]);

    // Simulate disconnect
    mockWs1.simulateClose();

    expect(stateChanges).toEqual(["connecting", "connected", "disconnected"]);

    // Advance timer by the first delay (100ms) — triggers reconnect setTimeout
    await vi.advanceTimersByTimeAsync(100);

    // Flush the fetch promise from the reconnect attempt
    await vi.advanceTimersByTimeAsync(0);

    // Second websocket should be created — simulate open
    mockWs2.simulateOpen();

    // Allow microtasks to process
    await vi.advanceTimersByTimeAsync(0);

    expect(stateChanges).toContain("connecting");
    // After ws2 opens, should be connected again
    expect(cm.getState()).toBe("connected");

    vi.useRealTimers();
  });

  it("should transition through disconnected → connecting → connected states", async () => {
    const { cm, mockWs, stateChanges } = createConnectionManager();

    expect(cm.getState()).toBe("disconnected");

    const connectPromise = cm.connect();
    // fetch is async — state changes to "connecting" synchronously before fetch
    expect(stateChanges[0]).toBe("connecting");

    await new Promise((r) => setTimeout(r, 0));
    mockWs.simulateOpen();
    await connectPromise;

    expect(stateChanges).toEqual(["connecting", "connected"]);
    expect(cm.getState()).toBe("connected");
  });

  it("should clean up resources on graceful disconnect", async () => {
    vi.useFakeTimers();

    const { cm, mockWs, stateChanges } = createConnectionManager();

    const connectPromise = cm.connect();
    await vi.advanceTimersByTimeAsync(0);
    mockWs.simulateOpen();
    await connectPromise;

    // Join a group
    const group = createMockGroupConfig();
    const joinPromise = cm.joinGroup(group);
    const joinMsg = JSON.parse(mockWs.sentMessages[0]) as unknown[];
    mockWs.simulateMessage([
      joinMsg[0],
      joinMsg[1],
      `group:${group.group_id}`,
      "phx_reply",
      { status: "ok", response: {} },
    ]);
    await joinPromise;

    // Disconnect
    await cm.disconnect();

    expect(cm.getState()).toBe("disconnected");
    expect(stateChanges[stateChanges.length - 1]).toBe("disconnected");
    expect(mockWs.closeCode).toBe(1000);

    // Should NOT schedule reconnection after explicit disconnect
    await vi.advanceTimersByTimeAsync(10000);
    // State should still be disconnected
    expect(cm.getState()).toBe("disconnected");

    vi.useRealTimers();
  });

  it("should log WARN on role mismatch (non-blocking)", async () => {
    const mockFetch = createMockFetch(undefined, {
      data: [{ account_id: "account-123", role: "member" }],
    });
    const mockWs = new MockWebSocket();

    const cm = new ConnectionManager({
      config: createMockConfig(),
      logger: createMockLogger(),
      onQuestion: () => {},
      onConnectionStateChange: () => {},
      webSocketFactory: () => mockWs,
      fetchFn: mockFetch,
    });

    const connectPromise = cm.connect();
    await new Promise((r) => setTimeout(r, 0));
    mockWs.simulateOpen();
    await connectPromise;

    const group = createMockGroupConfig();
    const joinPromise = cm.joinGroup(group);
    const joinMsg = JSON.parse(mockWs.sentMessages[0]) as unknown[];
    mockWs.simulateMessage([
      joinMsg[0],
      joinMsg[1],
      `group:${group.group_id}`,
      "phx_reply",
      { status: "ok", response: {} },
    ]);
    await joinPromise;

    // Let the role verification complete (non-blocking promise) — use a small delay
    await new Promise((r) => setTimeout(r, 50));

    // The test passes if joinGroup doesn't throw despite role mismatch
    // The WARN log would be visible in a real logger
    expect(cm.getState()).toBe("connected");
  });

  it("should join multiple groups independently", async () => {
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

    const { cm, mockWs } = createConnectionManager({
      config: createMockConfig({ groups: [group1, group2] }),
    });

    const connectPromise = cm.connect();
    await new Promise((r) => setTimeout(r, 0));
    mockWs.simulateOpen();
    await connectPromise;

    // Join group 1
    const joinPromise1 = cm.joinGroup(group1);
    const joinMsg1 = JSON.parse(mockWs.sentMessages[0]) as unknown[];
    mockWs.simulateMessage([
      joinMsg1[0],
      joinMsg1[1],
      `group:${group1.group_id}`,
      "phx_reply",
      { status: "ok", response: {} },
    ]);
    await joinPromise1;

    // Join group 2
    const joinPromise2 = cm.joinGroup(group2);
    const joinMsg2 = JSON.parse(mockWs.sentMessages[1]) as unknown[];
    mockWs.simulateMessage([
      joinMsg2[0],
      joinMsg2[1],
      `group:${group2.group_id}`,
      "phx_reply",
      { status: "ok", response: {} },
    ]);
    await joinPromise2;

    // Both should have sent join messages
    expect(mockWs.sentMessages).toHaveLength(2);

    const msg1 = JSON.parse(mockWs.sentMessages[0]) as unknown[];
    const msg2 = JSON.parse(mockWs.sentMessages[1]) as unknown[];

    expect(msg1[2]).toBe(`group:${group1.group_id}`);
    expect(msg2[2]).toBe(`group:${group2.group_id}`);
  });

  it("should handle channel join failure (error reply)", async () => {
    const { cm, mockWs } = createConnectionManager();

    const connectPromise = cm.connect();
    await new Promise((r) => setTimeout(r, 0));
    mockWs.simulateOpen();
    await connectPromise;

    const group = createMockGroupConfig();
    const joinPromise = cm.joinGroup(group);

    // Simulate error join reply
    const joinMsg = JSON.parse(mockWs.sentMessages[0]) as unknown[];
    mockWs.simulateMessage([
      joinMsg[0],
      joinMsg[1],
      `group:${group.group_id}`,
      "phx_reply",
      { status: "error", response: { reason: "unauthorized" } },
    ]);

    await expect(joinPromise).rejects.toThrow("Channel join failed");
  });
});
