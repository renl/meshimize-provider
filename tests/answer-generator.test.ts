import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AnswerGenerator,
  NO_CONTEXT_TEMPLATE,
  ERROR_FALLBACK_TEMPLATE,
  MAX_CONTEXT_TOKENS,
  estimateTokens,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
} from "../src/answer-generator.js";
import type { Config, GroupConfig } from "../src/config.js";
import type { RetrievedChunk } from "../src/types.js";
import pino from "pino";

// ─── Mock LangChain ───

const mockInvoke = vi.fn();

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    invoke: mockInvoke,
  })),
}));

vi.mock("@langchain/anthropic", () => ({
  ChatAnthropic: vi.fn().mockImplementation(() => ({
    invoke: mockInvoke,
  })),
}));

// ─── Helpers ───

function createMockLogger(): pino.Logger {
  return pino({ level: "silent" });
}

function createMockConfig(overrides?: Partial<Config["llm"]>): Config {
  return {
    meshimize: {
      server_url: "https://api.meshimize.com",
      api_key: "test-api-key",
      ws_path: "/socket/websocket",
    },
    llm: {
      provider: "openai",
      model: "gpt-4o-mini",
      api_key: "test-llm-key",
      max_tokens: 1000,
      temperature: 0.3,
      ...overrides,
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
    groups: [],
  };
}

function createMockGroupConfig(overrides?: Partial<GroupConfig>): GroupConfig {
  return {
    group_id: "550e8400-e29b-41d4-a716-446655440000",
    group_name: "Fly.io Docs",
    slug: "fly-docs",
    docs_path: "./docs",
    chunk_size: 1000,
    chunk_overlap: 200,
    top_k: 5,
    max_concurrency: 2,
    ...overrides,
  };
}

function createMockChunk(overrides?: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    content: "To deploy on Fly.io, run `fly deploy` from your project directory.",
    source: "getting-started/deploy.md",
    score: 0.15,
    ...overrides,
  };
}

// ─── Tests ───

describe("AnswerGenerator", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({
      content: "Based on the documentation, you can deploy by running `fly deploy`.",
      usage_metadata: {
        input_tokens: 150,
        output_tokens: 25,
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should call LLM with correct prompt (system + user messages)", async () => {
    const generator = new AnswerGenerator({
      config: createMockConfig(),
      logger: createMockLogger(),
    });

    const chunks = [createMockChunk()];
    const groupConfig = createMockGroupConfig();

    await generator.generate("How do I deploy?", chunks, groupConfig);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const messages = mockInvoke.mock.calls[0][0] as { role: string; content: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("Question: How do I deploy?");
  });

  it("should include source attribution in context", async () => {
    const generator = new AnswerGenerator({
      config: createMockConfig(),
      logger: createMockLogger(),
    });

    const chunks = [createMockChunk({ source: "getting-started/deploy.md" })];
    const groupConfig = createMockGroupConfig();

    await generator.generate("How do I deploy?", chunks, groupConfig);

    const messages = mockInvoke.mock.calls[0][0] as { role: string; content: string }[];
    expect(messages[1].content).toContain("[Source: getting-started/deploy.md]");
  });

  it("should return NO_CONTEXT_TEMPLATE when no chunks (no LLM call)", async () => {
    const generator = new AnswerGenerator({
      config: createMockConfig(),
      logger: createMockLogger(),
    });

    const result = await generator.generate("How do I deploy?", [], createMockGroupConfig());

    expect(result.content).toBe(NO_CONTEXT_TEMPLATE);
    expect(result.answerType).toBe("no_context");
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("should return ERROR_FALLBACK_TEMPLATE after LLM fails twice", async () => {
    mockInvoke.mockRejectedValue(new Error("LLM API error"));

    const generator = new AnswerGenerator({
      config: createMockConfig(),
      logger: createMockLogger(),
    });

    const chunks = [createMockChunk()];
    const result = await generator.generate("How do I deploy?", chunks, createMockGroupConfig());

    expect(result.content).toBe(ERROR_FALLBACK_TEMPLATE);
    expect(result.answerType).toBe("error_fallback");
    // LLM was called twice (initial + retry)
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("should respect token budget (truncate chunks over MAX_CONTEXT_TOKENS)", async () => {
    const generator = new AnswerGenerator({
      config: createMockConfig(),
      logger: createMockLogger(),
    });

    // Create chunks that exceed token budget
    const bigContent = "x".repeat(MAX_CONTEXT_TOKENS * 4); // Way over budget
    const chunks = [
      createMockChunk({ content: bigContent, source: "big-doc.md" }),
      createMockChunk({ content: "Small additional content", source: "small-doc.md" }),
    ];

    await generator.generate("Question?", chunks, createMockGroupConfig());

    const messages = mockInvoke.mock.calls[0][0] as { role: string; content: string }[];
    // The second chunk should not be included (budget exceeded)
    expect(messages[1].content).not.toContain("[Source: small-doc.md]");
    expect(messages[1].content).toContain("[Source: big-doc.md]");
  });

  it("should use system_prompt from group config when provided", async () => {
    const generator = new AnswerGenerator({
      config: createMockConfig(),
      logger: createMockLogger(),
    });

    const customPrompt = "You are a custom assistant. Be concise.";
    const groupConfig = createMockGroupConfig({ system_prompt: customPrompt });
    const chunks = [createMockChunk()];

    await generator.generate("How do I deploy?", chunks, groupConfig);

    const messages = mockInvoke.mock.calls[0][0] as { role: string; content: string }[];
    expect(messages[0].content).toBe(customPrompt);
  });

  it("should use default system prompt with group_name when no system_prompt in config", async () => {
    const generator = new AnswerGenerator({
      config: createMockConfig(),
      logger: createMockLogger(),
    });

    const groupConfig = createMockGroupConfig({
      group_name: "Fly.io Docs",
      system_prompt: undefined,
    });
    const chunks = [createMockChunk()];

    await generator.generate("How do I deploy?", chunks, groupConfig);

    const messages = mockInvoke.mock.calls[0][0] as { role: string; content: string }[];
    const expectedPrompt = DEFAULT_SYSTEM_PROMPT_TEMPLATE.replace("{group_name}", "Fly.io Docs");
    expect(messages[0].content).toBe(expectedPrompt);
  });

  it("should estimate tokens correctly using heuristic", () => {
    // estimateTokens: Math.ceil(text.length / 4)
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });

  it("should truncate oversized first chunk to fit within MAX_CONTEXT_TOKENS", async () => {
    const generator = new AnswerGenerator({
      config: createMockConfig(),
      logger: createMockLogger(),
    });

    // Create a single chunk that massively exceeds the token budget
    const oversizedContent = "x".repeat(MAX_CONTEXT_TOKENS * 8); // 8x over budget
    const chunks = [createMockChunk({ content: oversizedContent, source: "huge-doc.md" })];

    await generator.generate("Question?", chunks, createMockGroupConfig());

    const messages = mockInvoke.mock.calls[0][0] as { role: string; content: string }[];
    const userMessage = messages[1].content;

    // The context should be truncated — the user message should NOT contain the full oversized content
    // MAX_CONTEXT_TOKENS * 4 chars is the max (reverse heuristic), plus source prefix and framing (~200 chars)
    expect(userMessage.length).toBeLessThan(oversizedContent.length);
    // Verify it was actually truncated, not just fully included
    expect(userMessage).not.toContain(oversizedContent);
  });
});
