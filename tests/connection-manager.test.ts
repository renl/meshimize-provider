import { describe, it, expect, vi } from "vitest";
import {
  ConnectionManager,
  getReconnectDelay,
  type WebSocketLike,
  type ConnectionManagerOptions,
} from "../src/connection-manager.js";
import type { Config, GroupConfig } from "../src/config.js";
import type { IncomingMessage, IncomingQuestion, ConnectionState } from "../src/types.js";
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

function createConnectionManager(overrides?: Partial<ConnectionManagerOptions>): {
  cm: ConnectionManager;
  mockWs: MockWebSocket;
  stateChanges: ConnectionState[];
  questions: { question: IncomingQuestion; groupConfig: GroupConfig }[];
} {
  const mockWs = new MockWebSocket();
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
    ...overrides,
  });

  return { cm, mockWs, stateChanges, questions };
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

  it("should return fallback delay of 1000ms for empty delays array", () => {
    expect(getReconnectDelay(0, [])).toBe(1000);
    expect(getReconnectDelay(5, [])).toBe(1000);
  });
});

describe("ConnectionManager", () => {
  // NOTE: Only tests that need timer control (reconnection, explicit disconnect check)
  // use fake timers. Other tests use real timers to avoid blocking async flows.

  it("should construct WebSocket URL with wss:// for https:// server_url", async () => {
    const mockWs = new MockWebSocket();
    let capturedUrl = "";

    const cm = new ConnectionManager({
      config: createMockConfig(),
      logger: createMockLogger(),
      onQuestion: () => {},
      onConnectionStateChange: () => {},
      webSocketFactory: (url) => {
        capturedUrl = url;
        return mockWs;
      },
    });

    const connectPromise = cm.connect();
    mockWs.simulateOpen();
    await connectPromise;

    expect(capturedUrl).toMatch(/^wss:\/\//);
    expect(capturedUrl).toContain("api.meshimize.com");
    expect(capturedUrl).toContain("/socket/websocket");
    expect(capturedUrl).toContain("token=test-api-key-123");
    expect(capturedUrl).toContain("vsn=2.0.0");
  });

  it("should use ws:// for http:// server_url", async () => {
    const mockWs = new MockWebSocket();
    let capturedUrl = "";

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
    });

    const connectPromise = cm.connect();
    mockWs.simulateOpen();
    await connectPromise;

    expect(capturedUrl).toMatch(/^ws:\/\//);
    expect(capturedUrl).toContain("localhost:4000");
    expect(capturedUrl).toContain("/socket/websocket");
    expect(capturedUrl).toContain("token=test-key");
  });

  it("should connect WebSocket directly with API key as token (no REST calls)", async () => {
    const mockWs = new MockWebSocket();
    let capturedUrl = "";

    const cm = new ConnectionManager({
      config: createMockConfig(),
      logger: createMockLogger(),
      onQuestion: () => {},
      onConnectionStateChange: () => {},
      webSocketFactory: (url) => {
        capturedUrl = url;
        return mockWs;
      },
    });

    const connectPromise = cm.connect();
    mockWs.simulateOpen();
    await connectPromise;

    // Verify the API key is used directly as the token parameter
    expect(capturedUrl).toContain("token=test-api-key-123");
    // Verify no REST auth call was made — the URL should be a WebSocket URL, not HTTP
    expect(capturedUrl).toMatch(/^wss?:\/\//);
    expect(capturedUrl).not.toContain("/api/v1/auth/login");
  });

  it("should join channel with correct topic format (group:{group_id})", async () => {
    const { cm, mockWs } = createConnectionManager();

    const connectPromise = cm.connect();
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
      id: "msg-001",
      group_id: group.group_id,
      sender: { id: "user-456", display_name: "Alice", verified: false },
      content: "What is Meshimize?",
      message_type: "question",
      inserted_at: "2026-03-03T10:00:00Z",
      parent_message_id: null,
    };

    mockWs.simulateMessage([null, null, `group:${group.group_id}`, "new_message", questionPayload]);

    expect(questions).toHaveLength(1);
    expect(questions[0].question.id).toBe("msg-001");
    expect(questions[0].question.content).toBe("What is Meshimize?");
    expect(questions[0].question.message_type).toBe("question");
    expect(questions[0].groupConfig.group_id).toBe(group.group_id);
  });

  it("should NOT forward messages with message_type 'answer' to onQuestion (prevents infinite loop)", async () => {
    const { cm, mockWs, questions } = createConnectionManager();

    const connectPromise = cm.connect();
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

    // Simulate incoming answer message (NOT a question)
    const answerPayload: IncomingMessage = {
      id: "msg-answer-001",
      group_id: group.group_id,
      sender: { id: "agent-001", display_name: "Provider Agent", verified: true },
      content: "This is an answer",
      message_type: "answer",
      inserted_at: "2026-03-03T10:01:00Z",
      parent_message_id: "msg-001",
    };

    mockWs.simulateMessage([null, null, `group:${group.group_id}`, "new_message", answerPayload]);

    expect(questions).toHaveLength(0);
  });

  it("should NOT forward messages with message_type 'post' to onQuestion", async () => {
    const { cm, mockWs, questions } = createConnectionManager();

    const connectPromise = cm.connect();
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

    // Simulate incoming post message (NOT a question)
    const postPayload: IncomingMessage = {
      id: "msg-post-001",
      group_id: group.group_id,
      sender: { id: "user-123", display_name: "Human User", verified: false },
      content: "Just a general post",
      message_type: "post",
      inserted_at: "2026-03-03T10:02:00Z",
      parent_message_id: null,
    };

    mockWs.simulateMessage([null, null, `group:${group.group_id}`, "new_message", postPayload]);

    expect(questions).toHaveLength(0);
  });

  it("should ONLY forward messages with message_type 'question' to onQuestion", async () => {
    const { cm, mockWs, questions } = createConnectionManager();

    const connectPromise = cm.connect();
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

    // Send answer — should be ignored
    mockWs.simulateMessage([
      null,
      null,
      `group:${group.group_id}`,
      "new_message",
      {
        id: "msg-a1",
        group_id: group.group_id,
        sender: { id: "agent-001", display_name: "Agent", verified: true },
        content: "Answer",
        message_type: "answer",
        inserted_at: "2026-03-03T10:00:00Z",
        parent_message_id: "msg-q1",
      },
    ]);

    // Send post — should be ignored
    mockWs.simulateMessage([
      null,
      null,
      `group:${group.group_id}`,
      "new_message",
      {
        id: "msg-p1",
        group_id: group.group_id,
        sender: { id: "user-001", display_name: "User", verified: false },
        content: "Post",
        message_type: "post",
        inserted_at: "2026-03-03T10:01:00Z",
        parent_message_id: null,
      },
    ]);

    // Send question — should be forwarded
    mockWs.simulateMessage([
      null,
      null,
      `group:${group.group_id}`,
      "new_message",
      {
        id: "msg-q1",
        group_id: group.group_id,
        sender: { id: "user-002", display_name: "Questioner", verified: false },
        content: "How do I deploy?",
        message_type: "question",
        inserted_at: "2026-03-03T10:02:00Z",
        parent_message_id: null,
      },
    ]);

    expect(questions).toHaveLength(1);
    expect(questions[0].question.id).toBe("msg-q1");
    expect(questions[0].question.content).toBe("How do I deploy?");
  });

  it("should reconnect on disconnect with exponential backoff from config delays", async () => {
    vi.useFakeTimers();

    const mockWs1 = new MockWebSocket();
    const mockWs2 = new MockWebSocket();
    let wsIndex = 0;
    const websockets = [mockWs1, mockWs2];

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
    });

    // Initial connect
    const connectPromise = cm.connect();
    mockWs1.simulateOpen();
    await connectPromise;

    expect(stateChanges).toEqual(["connecting", "connected"]);

    // Simulate disconnect
    mockWs1.simulateClose();

    expect(stateChanges).toEqual(["connecting", "connected", "disconnected"]);

    // Advance timer by the first delay (100ms) — triggers reconnect setTimeout
    await vi.advanceTimersByTimeAsync(100);

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
    // State changes to "connecting" synchronously
    expect(stateChanges[0]).toBe("connecting");

    mockWs.simulateOpen();
    await connectPromise;

    expect(stateChanges).toEqual(["connecting", "connected"]);
    expect(cm.getState()).toBe("connected");
  });

  it("should clean up resources on graceful disconnect", async () => {
    vi.useFakeTimers();

    const { cm, mockWs, stateChanges } = createConnectionManager();

    const connectPromise = cm.connect();
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

  it("should include API key as token in WebSocket URL", async () => {
    const mockWs = new MockWebSocket();
    let capturedUrl = "";

    const apiKey = "sk-provider-abc-xyz-789";
    const cm = new ConnectionManager({
      config: createMockConfig({
        meshimize: {
          server_url: "https://api.meshimize.com",
          api_key: apiKey,
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
    });

    const connectPromise = cm.connect();
    mockWs.simulateOpen();
    await connectPromise;

    // Verify the API key is properly URL-encoded and used as token
    expect(capturedUrl).toContain(`token=${encodeURIComponent(apiKey)}`);
    expect(capturedUrl).toContain("vsn=2.0.0");
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

  it("should remove channel entry on join failure (stale channel cleanup)", async () => {
    const { cm, mockWs, questions } = createConnectionManager();

    const connectPromise = cm.connect();
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

    // Simulate a new_message on the failed topic — should NOT trigger onQuestion
    mockWs.simulateMessage([
      null,
      null,
      `group:${group.group_id}`,
      "new_message",
      {
        id: "msg-stale",
        group_id: group.group_id,
        sender: { id: "user-999", display_name: "Eve", verified: false },
        content: "Should not be received",
        message_type: "question",
        inserted_at: "2026-03-03T10:00:00Z",
        parent_message_id: null,
      },
    ]);

    expect(questions).toHaveLength(0);
  });

  it("should reject pending joins on unexpected disconnect", async () => {
    vi.useFakeTimers();

    const { cm, mockWs } = createConnectionManager();

    const connectPromise = cm.connect();
    mockWs.simulateOpen();
    await connectPromise;

    const group = createMockGroupConfig();
    const joinPromise = cm.joinGroup(group);

    // Before the join reply comes back, simulate disconnect
    mockWs.simulateClose();

    await expect(joinPromise).rejects.toThrow("Socket disconnected");

    vi.useRealTimers();
  });

  it("should reset state to disconnected when WebSocket connection fails", async () => {
    const mockWs = new MockWebSocket();
    const stateChanges: ConnectionState[] = [];

    const cm = new ConnectionManager({
      config: createMockConfig(),
      logger: createMockLogger(),
      onQuestion: () => {},
      onConnectionStateChange: (state) => {
        stateChanges.push(state);
      },
      webSocketFactory: () => mockWs,
    });

    const connectPromise = cm.connect();

    // Simulate WebSocket error before connection established
    mockWs.simulateError(new Error("Connection refused"));

    await expect(connectPromise).rejects.toThrow("WebSocket connection failed");
    expect(cm.getState()).toBe("disconnected");
    expect(stateChanges).toEqual(["connecting", "disconnected"]);
  });

  it("should reject connect promise when socket closes before opening", async () => {
    const mockWs = new MockWebSocket();
    const stateChanges: ConnectionState[] = [];

    const cm = new ConnectionManager({
      config: createMockConfig(),
      logger: createMockLogger(),
      onQuestion: () => {},
      onConnectionStateChange: (state) => {
        stateChanges.push(state);
      },
      webSocketFactory: () => mockWs,
    });

    const connectPromise = cm.connect();

    // Socket closes before onopen fires
    mockWs.simulateClose();

    await expect(connectPromise).rejects.toThrow("WebSocket closed before connection established");
    expect(cm.getState()).toBe("disconnected");
  });

  it("should re-join channels after reconnect and deliver new messages", async () => {
    vi.useFakeTimers();

    const mockWs1 = new MockWebSocket();
    const mockWs2 = new MockWebSocket();
    let wsIndex = 0;
    const websockets = [mockWs1, mockWs2];

    const questions: { question: IncomingQuestion; groupConfig: GroupConfig }[] = [];

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
      onQuestion: (question, groupConfig) => {
        questions.push({ question, groupConfig });
      },
      onConnectionStateChange: () => {},
      webSocketFactory: () => {
        const ws = websockets[wsIndex];
        wsIndex++;
        return ws;
      },
    });

    // 1. Initial connect
    const connectPromise = cm.connect();
    mockWs1.simulateOpen();
    await connectPromise;

    // 2. Join a group
    const group = createMockGroupConfig();
    const joinPromise = cm.joinGroup(group);
    const joinMsg1 = JSON.parse(mockWs1.sentMessages[0]) as unknown[];
    mockWs1.simulateMessage([
      joinMsg1[0],
      joinMsg1[1],
      `group:${group.group_id}`,
      "phx_reply",
      { status: "ok", response: {} },
    ]);
    await joinPromise;

    // 3. Simulate disconnect
    mockWs1.simulateClose();

    // 4. Advance timer to trigger reconnect (100ms delay)
    await vi.advanceTimersByTimeAsync(100);
    // Simulate second WebSocket opening
    mockWs2.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    expect(cm.getState()).toBe("connected");

    // 5. Check that phx_join was re-sent on the second WebSocket
    const rejoinMessages = mockWs2.sentMessages.filter((m) => {
      const parsed = JSON.parse(m) as unknown[];
      return parsed[3] === "phx_join";
    });
    expect(rejoinMessages.length).toBeGreaterThanOrEqual(1);

    const rejoinMsg = JSON.parse(rejoinMessages[0]) as unknown[];
    expect(rejoinMsg[2]).toBe(`group:${group.group_id}`);
    expect(rejoinMsg[4]).toEqual({ api_key: "test-api-key-123" });

    // 6. Simulate successful rejoin reply
    mockWs2.simulateMessage([
      rejoinMsg[0],
      rejoinMsg[1],
      `group:${group.group_id}`,
      "phx_reply",
      { status: "ok", response: {} },
    ]);
    await vi.advanceTimersByTimeAsync(0);

    // 7. Simulate a new_message after reconnect and verify it's delivered
    const questionPayload: IncomingQuestion = {
      id: "msg-reconnect-001",
      group_id: group.group_id,
      sender: { id: "user-789", display_name: "Bob", verified: false },
      content: "Question after reconnect?",
      message_type: "question",
      inserted_at: "2026-03-03T12:00:00Z",
      parent_message_id: null,
    };
    mockWs2.simulateMessage([
      null,
      null,
      `group:${group.group_id}`,
      "new_message",
      questionPayload,
    ]);

    expect(questions).toHaveLength(1);
    expect(questions[0].question.id).toBe("msg-reconnect-001");
    expect(questions[0].question.content).toBe("Question after reconnect?");
    expect(questions[0].groupConfig.group_id).toBe(group.group_id);

    vi.useRealTimers();
  });
});
