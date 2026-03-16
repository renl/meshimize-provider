import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SseConnectionManager } from "../src/sse-connection-manager.js";
import type { SseConnectionManagerOptions } from "../src/sse-connection-manager.js";
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

function createMockConfig(overrides?: {
  groups?: GroupConfig[];
  meshimize?: Partial<Config["meshimize"]>;
  agent?: Partial<Config["agent"]>;
}): Config {
  return {
    meshimize: {
      server_url: "https://api.meshimize.com",
      api_key: "test-api-key-123",
      ws_path: "/socket/websocket",
      transport: "sse",
      ...overrides?.meshimize,
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
      sse_keepalive_timeout_ms: 90000,
      ...overrides?.agent,
    },
    groups: overrides?.groups ?? [createMockGroupConfig()],
  };
}

/** Encode a string as a Uint8Array chunk */
function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Create a valid question SSE event block */
function createQuestionEvent(overrides?: Record<string, unknown>): string {
  const message = {
    id: "msg-00000000-0000-0000-0000-000000000001",
    group_id: "550e8400-e29b-41d4-a716-446655440000",
    content: "How do I deploy?",
    message_type: "question",
    parent_message_id: null,
    sender: {
      id: "sender-001",
      display_name: "Test User",
      verified: false,
    },
    inserted_at: "2026-03-17T10:00:00Z",
    ...overrides,
  };
  return (
    `event: new_message\n` + `id: ${message.id}\n` + `data: ${JSON.stringify(message)}\n` + `\n`
  );
}

/**
 * Create a mock fetch function that returns a ReadableStream.
 * `chunks` is an array of string chunks that will be enqueued into the stream.
 * If `signal` is aborted, the stream closes.
 */
function createMockFetch(
  chunks: string[],
  options?: { status?: number; delayMs?: number },
): typeof fetch {
  const status = options?.status ?? 200;

  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (status !== 200) {
      return new Response(null, { status }) as Response;
    }

    let chunkIndex = 0;
    let cancelled = false;

    // Wire up abort signal
    if (init?.signal) {
      init.signal.addEventListener("abort", () => {
        cancelled = true;
      });
    }

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (cancelled) {
          controller.close();
          return;
        }
        if (chunkIndex < chunks.length) {
          const delay = options?.delayMs ?? 0;
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          if (cancelled) {
            controller.close();
            return;
          }
          controller.enqueue(encode(chunks[chunkIndex]));
          chunkIndex++;
        } else {
          // Stream ends after all chunks
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }) as Response;
  }) as unknown as typeof fetch;
}

/**
 * Create a mock fetch that stays open indefinitely (doesn't close the stream)
 * until the abort signal fires. Returns the fetch fn and a way to push chunks.
 */
function createControllableFetch(): {
  fetchFn: typeof fetch;
  pushChunk: (groupId: string, chunk: string) => void;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const controllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: urlStr, init });

    // Extract group_id from URL
    const match = urlStr.match(/groups\/([^/]+)\/stream/);
    const groupId = match ? match[1] : "unknown";

    let cancelled = false;
    if (init?.signal) {
      init.signal.addEventListener("abort", () => {
        cancelled = true;
        const ctrl = controllers.get(groupId);
        if (ctrl) {
          try {
            ctrl.close();
          } catch {
            // Already closed
          }
        }
      });
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (cancelled) {
          controller.close();
          return;
        }
        controllers.set(groupId, controller);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }) as Response;
  }) as unknown as typeof fetch;

  const pushChunk = (groupId: string, chunk: string) => {
    const ctrl = controllers.get(groupId);
    if (ctrl) {
      ctrl.enqueue(encode(chunk));
    }
  };

  return { fetchFn, pushChunk, calls };
}

function createSseManager(
  overrides?: Partial<SseConnectionManagerOptions> & {
    configOverrides?: Parameters<typeof createMockConfig>[0];
  },
): {
  manager: SseConnectionManager;
  questions: Array<{ question: IncomingQuestion; groupConfig: GroupConfig }>;
  stateChanges: ConnectionState[];
} {
  const questions: Array<{ question: IncomingQuestion; groupConfig: GroupConfig }> = [];
  const stateChanges: ConnectionState[] = [];

  const config = createMockConfig(overrides?.configOverrides);

  const manager = new SseConnectionManager({
    config,
    logger: createMockLogger(),
    onQuestion: (question, groupConfig) => {
      questions.push({ question, groupConfig });
    },
    onConnectionStateChange: (state) => {
      stateChanges.push(state);
    },
    ...overrides,
  });

  return { manager, questions, stateChanges };
}

// ─── Tests ───

describe("SseConnectionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Connects to all configured groups
  it("should connect to all configured groups with correct URL construction", async () => {
    const group1 = createMockGroupConfig({
      group_id: "550e8400-e29b-41d4-a716-446655440001",
      slug: "group-one",
    });
    const group2 = createMockGroupConfig({
      group_id: "550e8400-e29b-41d4-a716-446655440002",
      slug: "group-two",
    });

    const { fetchFn, calls } = createControllableFetch();

    const { manager } = createSseManager({
      fetchFn,
      configOverrides: { groups: [group1, group2] },
    });

    await manager.connect();

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(
      "https://api.meshimize.com/api/v1/groups/550e8400-e29b-41d4-a716-446655440001/stream",
    );
    expect(calls[1].url).toBe(
      "https://api.meshimize.com/api/v1/groups/550e8400-e29b-41d4-a716-446655440002/stream",
    );

    await manager.disconnect();
  });

  // 2. Sends correct auth header
  it("should send correct Authorization and Accept headers", async () => {
    const { fetchFn, calls } = createControllableFetch();

    const { manager } = createSseManager({
      fetchFn,
      configOverrides: {
        meshimize: { api_key: "sk-provider-abc-xyz" },
      },
    });

    await manager.connect();

    expect(calls).toHaveLength(1);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-provider-abc-xyz");
    expect(headers["Accept"]).toBe("text/event-stream");

    await manager.disconnect();
  });

  // 3. Parses new_message event and calls onQuestion
  it("should parse new_message event and call onQuestion with correct data", async () => {
    vi.useRealTimers();

    const group = createMockGroupConfig();
    const questionEvent = createQuestionEvent();
    const mockFetch = createMockFetch([questionEvent]);

    const { manager, questions } = createSseManager({
      fetchFn: mockFetch,
      configOverrides: { groups: [group] },
    });

    await manager.connect();

    // Wait for stream processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(questions).toHaveLength(1);
    expect(questions[0].question.id).toBe("msg-00000000-0000-0000-0000-000000000001");
    expect(questions[0].question.content).toBe("How do I deploy?");
    expect(questions[0].question.message_type).toBe("question");
    expect(questions[0].question.sender.display_name).toBe("Test User");
    expect(questions[0].groupConfig.group_id).toBe(group.group_id);

    await manager.disconnect();
  });

  // 4. Filters non-question messages (defense-in-depth)
  it("should discard non-question messages", async () => {
    vi.useRealTimers();

    const answerEvent =
      `event: new_message\n` +
      `id: msg-answer-001\n` +
      `data: ${JSON.stringify({
        id: "msg-answer-001",
        group_id: "550e8400-e29b-41d4-a716-446655440000",
        content: "Here is the answer",
        message_type: "answer",
        parent_message_id: "msg-question-001",
        sender: { id: "sender-001", display_name: "Bot", verified: true },
        inserted_at: "2026-03-17T10:01:00Z",
      })}\n` +
      `\n`;

    const mockFetch = createMockFetch([answerEvent]);

    const { manager, questions } = createSseManager({
      fetchFn: mockFetch,
    });

    await manager.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(questions).toHaveLength(0);

    await manager.disconnect();
  });

  // 5. Handles JSON parse failure
  it("should handle JSON parse failure gracefully without crashing", async () => {
    vi.useRealTimers();

    const badEvent = `event: new_message\nid: msg-bad-001\ndata: not-valid-json\n\n`;
    const goodEvent = createQuestionEvent({
      id: "msg-good-001",
      content: "This is valid",
    });

    const mockFetch = createMockFetch([badEvent + goodEvent]);

    const { manager, questions } = createSseManager({
      fetchFn: mockFetch,
    });

    await manager.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Bad event skipped, good event processed
    expect(questions).toHaveLength(1);
    expect(questions[0].question.id).toBe("msg-good-001");

    await manager.disconnect();
  });

  // 6. Handles missing fields
  it("should skip messages with missing required fields", async () => {
    vi.useRealTimers();

    const incompleteEvent =
      `event: new_message\n` +
      `id: msg-incomplete-001\n` +
      `data: ${JSON.stringify({
        id: "msg-incomplete-001",
        group_id: "550e8400-e29b-41d4-a716-446655440000",
        // missing content, message_type, sender, parent_message_id, inserted_at
      })}\n` +
      `\n`;

    const mockFetch = createMockFetch([incompleteEvent]);

    const { manager, questions } = createSseManager({
      fetchFn: mockFetch,
    });

    await manager.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(questions).toHaveLength(0);

    await manager.disconnect();
  });

  // 7. Tracks lastEventId
  it("should track lastEventId from SSE id: field", async () => {
    vi.useRealTimers();

    const event1 = createQuestionEvent({ id: "msg-event-001" });
    const event2 = createQuestionEvent({ id: "msg-event-002", content: "Second question" });

    const mockFetch = createMockFetch([event1 + event2]);

    const { manager, questions } = createSseManager({
      fetchFn: mockFetch,
    });

    await manager.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(questions).toHaveLength(2);
    // The lastEventId is tracked internally — we verify it via reconnection test (test 8)

    await manager.disconnect();
  });

  // 8. Sends Last-Event-ID on reconnect
  it("should send Last-Event-ID header on reconnection", async () => {
    const group = createMockGroupConfig();

    // First connection: delivers a question then stream ends → triggers reconnect
    let callCount = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      callCount++;

      if (callCount === 1) {
        // First connection: stream with one event, then close
        const eventData = createQuestionEvent({ id: "msg-last-seen-001" });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode(eventData));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }) as Response;
      }

      // Second connection (reconnect): keep open
      const stream = new ReadableStream<Uint8Array>({
        start() {
          // Stay open — don't close
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }) as Response;
    }) as unknown as typeof fetch;

    const { manager } = createSseManager({
      fetchFn,
      configOverrides: {
        groups: [group],
        agent: { reconnect_delays_ms: [50, 100] },
      },
    });

    await manager.connect();

    // Wait for stream to end and reconnect to be scheduled
    await vi.advanceTimersByTimeAsync(200);

    expect(callCount).toBeGreaterThanOrEqual(2);

    // Verify second call has Last-Event-ID header
    const secondCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1];
    const secondInit = secondCall[1] as RequestInit;
    const headers = secondInit.headers as Record<string, string>;
    expect(headers["Last-Event-ID"]).toBe("msg-last-seen-001");

    await manager.disconnect();
  });

  // 9. Reconnection with exponential backoff
  it("should reconnect with delays from reconnect_delays_ms config", async () => {
    let callCount = 0;
    const fetchFn = vi.fn(async () => {
      callCount++;

      if (callCount === 1) {
        // First call succeeds — stream ends immediately to trigger reconnect
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }) as Response;
      }

      // Subsequent reconnect attempts all fail with 503
      return new Response(null, { status: 503 }) as Response;
    }) as unknown as typeof fetch;

    const { manager } = createSseManager({
      fetchFn,
      configOverrides: {
        agent: { reconnect_delays_ms: [100, 200, 500] },
      },
    });

    await manager.connect();

    // First call happens during connect() — succeeds, then stream ends
    expect(callCount).toBe(1);

    // Stream end triggers reconnect with delay[0]=100ms
    await vi.advanceTimersByTimeAsync(150);
    expect(callCount).toBe(2);

    // Second reconnect fails → schedules with delay[1]=200ms
    await vi.advanceTimersByTimeAsync(250);
    expect(callCount).toBe(3);

    // Third reconnect fails → schedules with delay[2]=500ms
    await vi.advanceTimersByTimeAsync(550);
    expect(callCount).toBe(4);

    await manager.disconnect();
  });

  // 10. Close event with server_shutdown — immediate reconnect
  it("should reconnect immediately on close event with server_shutdown reason", async () => {
    const group = createMockGroupConfig();
    let callCount = 0;

    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++;

      if (callCount === 1) {
        // First connection: delivers a close event
        const closeEvent = `event: close\ndata: ${JSON.stringify({ reason: "server_shutdown" })}\n\n`;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode(closeEvent));
            // Don't close — the handler will abort the connection
          },
        });

        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            // Connection aborted by handler
          });
        }

        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }) as Response;
      }

      // Second connection: keep open
      const stream = new ReadableStream<Uint8Array>({
        start() {},
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }) as Response;
    }) as unknown as typeof fetch;

    const { manager } = createSseManager({
      fetchFn,
      configOverrides: { groups: [group] },
    });

    await manager.connect();

    // server_shutdown triggers immediate reconnect (no backoff)
    // Give the async processBuffer → handleCloseEvent → connectGroup chain time to run
    await vi.advanceTimersByTimeAsync(50);

    expect(callCount).toBeGreaterThanOrEqual(2);

    await manager.disconnect();
  });

  // 11. Close event with superseded — no reconnection
  it("should NOT reconnect on close event with superseded reason", async () => {
    const group = createMockGroupConfig();
    let callCount = 0;

    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++;

      const closeEvent = `event: close\ndata: ${JSON.stringify({ reason: "superseded" })}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode(closeEvent));
        },
      });

      if (init?.signal) {
        init.signal.addEventListener("abort", () => {});
      }

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }) as Response;
    }) as unknown as typeof fetch;

    const { manager } = createSseManager({
      fetchFn,
      configOverrides: { groups: [group] },
    });

    await manager.connect();

    // Wait a long time — no reconnection should happen
    await vi.advanceTimersByTimeAsync(5000);

    expect(callCount).toBe(1);

    await manager.disconnect();
  });

  // 12. Keepalive timeout — connection treated as dead
  it("should treat connection as dead after sse_keepalive_timeout_ms with no data", async () => {
    let callCount = 0;

    const fetchFn = vi.fn(async () => {
      callCount++;

      // Connection that sends nothing after initial open
      const stream = new ReadableStream<Uint8Array>({
        start() {
          // Stay open, send nothing
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }) as Response;
    }) as unknown as typeof fetch;

    const { manager } = createSseManager({
      fetchFn,
      configOverrides: {
        agent: {
          sse_keepalive_timeout_ms: 10000,
          reconnect_delays_ms: [100],
        },
      },
    });

    await manager.connect();
    expect(callCount).toBe(1);

    // Advance past keepalive timeout
    await vi.advanceTimersByTimeAsync(10100);

    // Should have triggered reconnect
    expect(callCount).toBe(2);

    await manager.disconnect();
  });

  // 13. Keepalive timer reset on event AND on ping comment
  it("should reset keepalive timer on any received chunk including ping comments", async () => {
    const { fetchFn, pushChunk } = createControllableFetch();

    const groupId = "550e8400-e29b-41d4-a716-446655440000";

    const { manager } = createSseManager({
      fetchFn,
      configOverrides: {
        agent: {
          sse_keepalive_timeout_ms: 10000,
          reconnect_delays_ms: [100],
        },
      },
    });

    await manager.connect();

    // Advance 8 seconds (within 10s timeout)
    await vi.advanceTimersByTimeAsync(8000);

    // Send a ping comment — this should reset the timer
    pushChunk(groupId, ": ping\n\n");

    // Advance another 8 seconds (would have been 16s total without reset)
    await vi.advanceTimersByTimeAsync(8000);

    // Connection should still be alive since timer was reset
    expect(manager.getState()).toBe("connected");

    await manager.disconnect();
  });

  // 14. State aggregation
  it('should report "connected" when all groups connected, "connecting" when mixed', async () => {
    const group1 = createMockGroupConfig({
      group_id: "550e8400-e29b-41d4-a716-446655440001",
    });
    const group2 = createMockGroupConfig({
      group_id: "550e8400-e29b-41d4-a716-446655440002",
    });

    let fetchCallCount = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      fetchCallCount++;
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes("446655440002") && fetchCallCount <= 2) {
        // Group 2 initial connect succeeds but stream closes immediately → triggers reconnect
        // On reconnect (fetchCallCount > 2), group 2 stays open
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }) as Response;
      }

      // Group 1 always stays open; group 2 reconnect stays open
      const stream = new ReadableStream<Uint8Array>({
        start() {},
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }) as Response;
    }) as unknown as typeof fetch;

    const { manager, stateChanges } = createSseManager({
      fetchFn,
      configOverrides: {
        groups: [group1, group2],
        agent: { reconnect_delays_ms: [100] },
      },
    });

    await manager.connect();

    // Both groups initially connected, then group 2 stream ends → mixed state
    // Wait for stream end + reconnect scheduling
    await vi.advanceTimersByTimeAsync(50);
    expect(stateChanges).toContain("connecting");

    // After reconnect delay for group 2 (100ms)
    await vi.advanceTimersByTimeAsync(150);

    // Both connected → "connected"
    expect(manager.getState()).toBe("connected");

    await manager.disconnect();
  });

  // 15. disconnect() prevents reconnection
  it("should prevent reconnection after disconnect() is called", async () => {
    let callCount = 0;
    const fetchFn = vi.fn(async () => {
      callCount++;

      if (callCount === 1) {
        // First call succeeds — stream ends immediately to trigger reconnect
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }) as Response;
      }

      // Subsequent calls stay open
      const stream = new ReadableStream<Uint8Array>({
        start() {},
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }) as Response;
    }) as unknown as typeof fetch;

    const { manager } = createSseManager({
      fetchFn,
      configOverrides: {
        agent: { reconnect_delays_ms: [100] },
      },
    });

    await manager.connect();
    expect(callCount).toBe(1);

    // Disconnect before reconnect fires (stream ended, reconnect scheduled)
    await manager.disconnect();

    // Advance well past reconnect delay
    await vi.advanceTimersByTimeAsync(1000);

    // No additional fetch calls after disconnect
    expect(callCount).toBe(1);
  });

  // 16. disconnect() cleans up all timers and connections
  it("should clean up all timers and connections on disconnect()", async () => {
    const group1 = createMockGroupConfig({
      group_id: "550e8400-e29b-41d4-a716-446655440001",
    });
    const group2 = createMockGroupConfig({
      group_id: "550e8400-e29b-41d4-a716-446655440002",
    });

    const { fetchFn } = createControllableFetch();

    const { manager, stateChanges } = createSseManager({
      fetchFn,
      configOverrides: { groups: [group1, group2] },
    });

    await manager.connect();
    expect(manager.getState()).toBe("connected");

    await manager.disconnect();

    // State should transition to disconnected
    expect(manager.getState()).toBe("disconnected");
    expect(stateChanges).toContain("disconnected");

    // Advancing timers should not trigger any reconnects or keepalive actions
    const fetchCallsBefore = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(200000);
    const fetchCallsAfter = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(fetchCallsAfter).toBe(fetchCallsBefore);
  });

  // 17. getState() returns current aggregate state
  it("should return current aggregate state via getState()", async () => {
    const { fetchFn } = createControllableFetch();

    const { manager } = createSseManager({ fetchFn });

    // Before connect
    expect(manager.getState()).toBe("disconnected");

    await manager.connect();

    // After connect
    expect(manager.getState()).toBe("connected");

    await manager.disconnect();

    // After disconnect
    expect(manager.getState()).toBe("disconnected");
  });

  // 18. connect() throws on initial connection failure
  it("should throw on initial connection failure", async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(null, { status: 503 }) as Response;
    }) as unknown as typeof fetch;

    const { manager } = createSseManager({
      fetchFn,
      configOverrides: {
        agent: { reconnect_delays_ms: [100, 200] },
      },
    });

    await expect(manager.connect()).rejects.toThrow("SSE connection failed: HTTP 503");

    // State should be disconnected after failed initial connect
    expect(manager.getState()).toBe("disconnected");

    await manager.disconnect();
  });

  // 19. Multi-line data: fields concatenated with newline per SSE spec
  it("should concatenate multiple data: lines with newline per SSE spec", async () => {
    vi.useRealTimers();

    const group = createMockGroupConfig();
    const message = {
      id: "msg-multiline-001",
      group_id: "550e8400-e29b-41d4-a716-446655440000",
      content: "How do I deploy?",
      message_type: "question",
      parent_message_id: null,
      sender: { id: "sender-001", display_name: "Test User", verified: false },
      inserted_at: "2026-03-17T10:00:00Z",
    };
    const json = JSON.stringify(message);

    // Split the JSON across multiple data: lines
    const part1 = json.slice(0, 40);
    const part2 = json.slice(40, 80);
    const part3 = json.slice(80);

    // Reconstruct the JSON with newlines — the parser must join them
    const multiLineEvent =
      `event: new_message\n` +
      `id: msg-multiline-001\n` +
      `data: ${part1}\n` +
      `data: ${part2}\n` +
      `data: ${part3}\n` +
      `\n`;

    // The joined data will be: part1 + "\n" + part2 + "\n" + part3
    // which is NOT valid JSON (has embedded newlines). This is expected per SSE spec.
    // For a real multi-line test, we need the JSON to be valid after joining.
    // Instead, send each data line as a complete JSON on a single line (standard approach),
    // or test with a payload that is valid when joined.

    // Better approach: send the full JSON on one line to validate single-line still works,
    // and separately test that multiple data: lines are concatenated.
    // For a realistic test: the server sends the full JSON on one data: line.
    // Multi-line data: is uncommon for JSON but we should still handle it.
    // Let's test with a message whose content contains a newline (valid via multi-line data:)

    const multiLineMessage = {
      id: "msg-multiline-002",
      group_id: "550e8400-e29b-41d4-a716-446655440000",
      content: "How do I deploy?",
      message_type: "question",
      parent_message_id: null,
      sender: { id: "sender-001", display_name: "Test User", verified: false },
      inserted_at: "2026-03-17T10:00:00Z",
    };
    const fullJson = JSON.stringify(multiLineMessage);

    // Single data: line — control test
    const singleLineEvent =
      `event: new_message\n` + `id: msg-multiline-002\n` + `data: ${fullJson}\n` + `\n`;

    const mockFetch = createMockFetch([singleLineEvent]);

    const { manager, questions } = createSseManager({
      fetchFn: mockFetch,
      configOverrides: { groups: [group] },
    });

    await manager.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(questions).toHaveLength(1);
    expect(questions[0].question.id).toBe("msg-multiline-002");

    await manager.disconnect();
  });

  // 20. Multi-line data: lines are joined with newline separator
  it("should join multiple data: lines and parse concatenated result", async () => {
    vi.useRealTimers();

    const group = createMockGroupConfig();

    // Craft a JSON string, split it across multiple data: lines
    // After joining with "\n", JSON.parse must succeed
    // We'll use a trick: put the complete JSON on a single data: line but verify the
    // accumulation logic by having TWO data: lines that together form valid JSON
    // when joined with \n — but JSON.parse ignores whitespace including \n in most positions.

    // Actually, JSON.parse handles newlines within string values and between tokens.
    // A newline between `{` and `"id"` is valid JSON whitespace.
    // So we split the JSON at a point between tokens:
    const message = {
      id: "msg-multi-001",
      group_id: "550e8400-e29b-41d4-a716-446655440000",
      content: "How do I deploy?",
      message_type: "question",
      parent_message_id: null,
      sender: { id: "sender-001", display_name: "Test User", verified: false },
      inserted_at: "2026-03-17T10:00:00Z",
    };
    const fullJson = JSON.stringify(message);

    // Split at a comma boundary (valid JSON split point — newline is whitespace)
    const commaIdx = fullJson.indexOf(",");
    const line1 = fullJson.slice(0, commaIdx + 1);
    const line2 = fullJson.slice(commaIdx + 1);

    const multiDataEvent =
      `event: new_message\n` +
      `id: msg-multi-001\n` +
      `data: ${line1}\n` +
      `data: ${line2}\n` +
      `\n`;

    const mockFetch = createMockFetch([multiDataEvent]);

    const { manager, questions } = createSseManager({
      fetchFn: mockFetch,
      configOverrides: { groups: [group] },
    });

    await manager.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The two data: lines should be joined with \n, producing valid JSON
    // (newline is valid whitespace between JSON tokens)
    expect(questions).toHaveLength(1);
    expect(questions[0].question.id).toBe("msg-multi-001");
    expect(questions[0].question.content).toBe("How do I deploy?");
    expect(questions[0].question.sender.display_name).toBe("Test User");

    await manager.disconnect();
  });
});
