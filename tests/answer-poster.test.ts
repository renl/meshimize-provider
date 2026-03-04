import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnswerPoster } from "../src/answer-poster.js";
import type { OutgoingAnswer } from "../src/types.js";
import pino from "pino";

// ─── Helpers ───

function createMockLogger(): pino.Logger {
  return pino({ level: "silent" });
}

function createMockAnswer(overrides?: Partial<OutgoingAnswer>): OutgoingAnswer {
  return {
    content: "Based on the documentation, you can deploy by running `fly deploy`.",
    message_type: "answer",
    parent_message_id: "msg-001",
    ...overrides,
  };
}

function createMockResponse(
  status: number,
  body: string = "",
  headers: Record<string, string> = {},
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: vi.fn().mockResolvedValue(body),
    headers: {
      get: (name: string) => headers[name] ?? null,
    },
  } as unknown as Response;
}

// ─── Tests ───

describe("AnswerPoster", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should make a successful POST (201) with correct URL, headers, body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(createMockResponse(201));

    const poster = new AnswerPoster({
      serverUrl: "https://api.meshimize.com",
      token: "test-token-123",
      logger: createMockLogger(),
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    const answer = createMockAnswer();
    const resultPromise = poster.post("group-abc", answer);
    const result = await resultPromise;

    expect(result).toEqual({ success: true, httpStatus: 201, deadLettered: false });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.meshimize.com/api/v1/groups/group-abc/messages");
    expect(options.method).toBe("POST");

    const reqHeaders = options.headers as Record<string, string>;
    expect(reqHeaders["Content-Type"]).toBe("application/json");
    expect(reqHeaders["Authorization"]).toBe("Bearer test-token-123");

    const parsedBody = JSON.parse(options.body as string) as {
      message: { content: string; message_type: string; parent_message_id: string };
    };
    expect(parsedBody.message.content).toBe(answer.content);
    expect(parsedBody.message.message_type).toBe("answer");
    expect(parsedBody.message.parent_message_id).toBe("msg-001");
  });

  it("should retry on 500 — waits 2s, retries once", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(createMockResponse(500, "Internal Server Error"))
      .mockResolvedValueOnce(createMockResponse(201));

    const poster = new AnswerPoster({
      serverUrl: "https://api.meshimize.com",
      token: "test-token",
      logger: createMockLogger(),
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    const resultPromise = poster.post("group-abc", createMockAnswer());

    // Advance past the 2s retry wait
    await vi.advanceTimersByTimeAsync(2100);

    const result = await resultPromise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ success: true, httpStatus: 201, deadLettered: false });
  });

  it("should dead-letter after second failure and log DEAD_LETTER error", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(createMockResponse(500, "Internal Server Error"))
      .mockResolvedValueOnce(createMockResponse(502, "Bad Gateway"));

    const logger = createMockLogger();
    const errorSpy = vi.spyOn(logger, "error");

    const poster = new AnswerPoster({
      serverUrl: "https://api.meshimize.com",
      token: "test-token",
      logger,
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    const resultPromise = poster.post("group-abc", createMockAnswer());

    // Advance past the 2s retry wait
    await vi.advanceTimersByTimeAsync(2100);

    const result = await resultPromise;

    expect(result).toEqual({ success: false, httpStatus: 502, deadLettered: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify DEAD_LETTER log
    expect(errorSpy).toHaveBeenCalled();
    const errorCall = errorSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(errorCall.dead_letter).toBe(true);
    expect(errorCall.msg).toContain("DEAD_LETTER");
    expect(errorCall.group_id).toBe("group-abc");
    expect(errorCall.question_id).toBe("msg-001");
  });

  it("should handle HTTP 429 with Retry-After header — wait and retry (not counted as failure)", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(createMockResponse(429, "Too Many Requests", { "Retry-After": "3" }))
      .mockResolvedValueOnce(createMockResponse(201));

    const poster = new AnswerPoster({
      serverUrl: "https://api.meshimize.com",
      token: "test-token",
      logger: createMockLogger(),
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    const resultPromise = poster.post("group-abc", createMockAnswer());

    // Advance past the 3s Retry-After wait
    await vi.advanceTimersByTimeAsync(3100);

    const result = await resultPromise;

    expect(result).toEqual({ success: true, httpStatus: 201, deadLettered: false });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should use correct Authorization header (Bearer token)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(createMockResponse(201));

    const poster = new AnswerPoster({
      serverUrl: "https://api.meshimize.com",
      token: "my-secret-api-key",
      logger: createMockLogger(),
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    await poster.post("group-abc", createMockAnswer());

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const reqHeaders = options.headers as Record<string, string>;
    expect(reqHeaders["Authorization"]).toBe("Bearer my-secret-api-key");
  });

  it("should format answer body correctly per spec", async () => {
    const mockFetch = vi.fn().mockResolvedValue(createMockResponse(201));

    const poster = new AnswerPoster({
      serverUrl: "https://api.meshimize.com",
      token: "test-token",
      logger: createMockLogger(),
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    const answer = createMockAnswer({
      content: "Test answer content",
      message_type: "answer",
      parent_message_id: "parent-msg-123",
    });

    await poster.post("group-xyz", answer);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const parsedBody = JSON.parse(options.body as string) as {
      message: { content: string; message_type: string; parent_message_id: string };
    };

    expect(parsedBody).toEqual({
      message: {
        content: "Test answer content",
        message_type: "answer",
        parent_message_id: "parent-msg-123",
      },
    });
  });

  it("should return correct PostResult tracking fields", async () => {
    const mockFetch = vi.fn().mockResolvedValue(createMockResponse(201));

    const poster = new AnswerPoster({
      serverUrl: "https://api.meshimize.com",
      token: "test-token",
      logger: createMockLogger(),
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    const result = await poster.post("group-abc", createMockAnswer());

    expect(result.success).toBe(true);
    expect(result.httpStatus).toBe(201);
    expect(result.deadLettered).toBe(false);
  });

  it("should handle concurrent posts to different groups independently", async () => {
    const mockFetch = vi.fn().mockResolvedValue(createMockResponse(201));

    const poster = new AnswerPoster({
      serverUrl: "https://api.meshimize.com",
      token: "test-token",
      logger: createMockLogger(),
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    const [result1, result2] = await Promise.all([
      poster.post("group-aaa", createMockAnswer({ parent_message_id: "msg-aaa" })),
      poster.post("group-bbb", createMockAnswer({ parent_message_id: "msg-bbb" })),
    ]);

    expect(result1).toEqual({ success: true, httpStatus: 201, deadLettered: false });
    expect(result2).toEqual({ success: true, httpStatus: 201, deadLettered: false });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify different URLs were called
    const urls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls).toContain("https://api.meshimize.com/api/v1/groups/group-aaa/messages");
    expect(urls).toContain("https://api.meshimize.com/api/v1/groups/group-bbb/messages");
  });
});
