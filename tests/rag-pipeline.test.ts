import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import type { GroupConfig } from "../src/config.js";

// ─── Hoisted mocks (available to vi.mock factories) ───

const {
  mockEmbedDocuments,
  mockEmbedQuery,
  mockAdd,
  mockQuery,
  mockCount,
  mockPeek,
  mockCollection,
  mockGetOrCreateCollection,
  mockGetCollection,
  mockListCollections,
  mockDeleteCollection,
} = vi.hoisted(() => {
  const mockEmbedDocuments = vi.fn().mockImplementation((texts: string[]) =>
    Promise.resolve(
      texts.map(() =>
        Array(1536)
          .fill(0)
          .map((_, i) => i / 1536),
      ),
    ),
  );

  const mockEmbedQuery = vi.fn().mockImplementation(() =>
    Promise.resolve(
      Array(1536)
        .fill(0)
        .map((_, i) => i / 1536),
    ),
  );

  const mockAdd = vi.fn().mockResolvedValue(undefined);
  const mockQuery = vi.fn().mockResolvedValue({
    ids: [["chunk_0", "chunk_1"]],
    documents: [["Document content 1", "Document content 2"]],
    metadatas: [[{ source: "file1.md" }, { source: "file2.md" }]],
    distances: [[0.1, 0.3]],
  });
  const mockCount = vi.fn().mockResolvedValue(10);
  const mockPeek = vi.fn().mockResolvedValue({ ids: [], documents: [] });

  const mockCollection = {
    name: "test_collection",
    id: "test-id",
    metadata: { ingested_at: new Date().toISOString(), group_id: "test-group-id" } as Record<
      string,
      unknown
    >,
    add: mockAdd,
    query: mockQuery,
    count: mockCount,
    peek: mockPeek,
    get: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    modify: vi.fn(),
  };

  const mockGetOrCreateCollection = vi.fn().mockResolvedValue(mockCollection);
  const mockGetCollection = vi.fn().mockResolvedValue(mockCollection);
  const mockListCollections = vi.fn().mockResolvedValue(["meshimize_fly-docs"]);
  const mockDeleteCollection = vi.fn().mockResolvedValue(undefined);

  return {
    mockEmbedDocuments,
    mockEmbedQuery,
    mockAdd,
    mockQuery,
    mockCount,
    mockPeek,
    mockCollection,
    mockGetOrCreateCollection,
    mockGetCollection,
    mockListCollections,
    mockDeleteCollection,
  };
});

// ─── Mock @langchain/openai ───

vi.mock("@langchain/openai", () => {
  return {
    OpenAIEmbeddings: vi.fn().mockImplementation(() => ({
      embedDocuments: mockEmbedDocuments,
      embedQuery: mockEmbedQuery,
    })),
  };
});

// ─── Mock chromadb ───

vi.mock("chromadb", () => {
  return {
    ChromaClient: vi.fn().mockImplementation(() => ({
      getOrCreateCollection: mockGetOrCreateCollection,
      getCollection: mockGetCollection,
      listCollections: mockListCollections,
      deleteCollection: mockDeleteCollection,
    })),
  };
});

// ─── Import after mocks ───

const { RagPipeline, stripErbTags } = await import("../src/rag-pipeline.js");
import type { RagPipelineOptions } from "../src/rag-pipeline.js";

// ─── Helpers ───

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "meshimize-rag-test-"));
}

function createTestLogger(): pino.Logger {
  return pino({ level: "silent" });
}

function createTestOptions(overrides?: Partial<RagPipelineOptions>): RagPipelineOptions {
  return {
    persistDirectory: "http://localhost:8000",
    collectionPrefix: "meshimize",
    distanceMetric: "cosine",
    staleDays: 7,
    embeddingApiKey: "test-key",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
    batchSize: 500,
    requestsPerMinute: 3000,
    logger: createTestLogger(),
    ...overrides,
  };
}

function createTestGroup(tempDir: string, overrides?: Partial<GroupConfig>): GroupConfig {
  return {
    group_id: "550e8400-e29b-41d4-a716-446655440000",
    group_name: "Test Group",
    slug: "fly-docs",
    docs_path: tempDir,
    chunk_size: 1000,
    chunk_overlap: 200,
    top_k: 5,
    max_concurrency: 2,
    ...overrides,
  };
}

// ─── Tests ───

describe("rag-pipeline", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vi.clearAllMocks();

    // Reset mock implementations after clearAllMocks
    mockEmbedDocuments.mockImplementation((texts: string[]) =>
      Promise.resolve(
        texts.map(() =>
          Array(1536)
            .fill(0)
            .map((_, i) => i / 1536),
        ),
      ),
    );
    mockEmbedQuery.mockImplementation(() =>
      Promise.resolve(
        Array(1536)
          .fill(0)
          .map((_, i) => i / 1536),
      ),
    );
    mockAdd.mockResolvedValue(undefined);
    mockCount.mockResolvedValue(10);
    mockCollection.metadata = {
      ingested_at: new Date().toISOString(),
      group_id: "test-group-id",
    };
    mockGetOrCreateCollection.mockResolvedValue(mockCollection);
    mockGetCollection.mockResolvedValue(mockCollection);
    mockListCollections.mockResolvedValue(["meshimize_fly-docs"]);
    mockDeleteCollection.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({
      ids: [["chunk_0", "chunk_1"]],
      documents: [["Document content 1", "Document content 2"]],
      metadatas: [[{ source: "file1.md" }, { source: "file2.md" }]],
      distances: [[0.1, 0.3]],
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── Document Loading ───

  it("should load .md files from directory", () => {
    writeFileSync(join(tempDir, "guide.md"), "# Guide\nSome content here.");
    writeFileSync(join(tempDir, "readme.md"), "# README\nMore content.");

    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir);
    const docs = pipeline.loadDocuments(group);

    expect(docs).toHaveLength(2);
    expect(docs.some((d) => d.source === "guide.md")).toBe(true);
    expect(docs.some((d) => d.source === "readme.md")).toBe(true);
  });

  it("should load .html.md files", () => {
    writeFileSync(join(tempDir, "page.html.md"), "# Page\nHTML markdown content.");

    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir);
    const docs = pipeline.loadDocuments(group);

    expect(docs).toHaveLength(1);
    expect(docs[0].source).toBe("page.html.md");
    expect(docs[0].content).toBe("# Page\nHTML markdown content.");
  });

  it("should strip ERB tags from .html.markerb files", () => {
    const erbContent = '<%= render "shared/header" %>\n# Title\n<% if true %>\nContent\n<% end %>';
    writeFileSync(join(tempDir, "template.html.markerb"), erbContent);

    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir);
    const docs = pipeline.loadDocuments(group);

    expect(docs).toHaveLength(1);
    expect(docs[0].source).toBe("template.html.markerb");
    expect(docs[0].content).not.toContain("<%");
    expect(docs[0].content).not.toContain("%>");
    expect(docs[0].content).toContain("# Title");
    expect(docs[0].content).toContain("Content");
  });

  it("should skip node_modules and .git directories", () => {
    writeFileSync(join(tempDir, "root.md"), "# Root doc");

    mkdirSync(join(tempDir, "node_modules"), { recursive: true });
    writeFileSync(join(tempDir, "node_modules", "lib.md"), "# Library");

    mkdirSync(join(tempDir, ".git"), { recursive: true });
    writeFileSync(join(tempDir, ".git", "config.md"), "# Git config");

    mkdirSync(join(tempDir, "vendor"), { recursive: true });
    writeFileSync(join(tempDir, "vendor", "dep.md"), "# Vendor dep");

    mkdirSync(join(tempDir, "_build"), { recursive: true });
    writeFileSync(join(tempDir, "_build", "output.md"), "# Build output");

    mkdirSync(join(tempDir, "subdir"), { recursive: true });
    writeFileSync(join(tempDir, "subdir", "nested.md"), "# Nested doc");

    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir);
    const docs = pipeline.loadDocuments(group);

    expect(docs).toHaveLength(2);
    const sources = docs.map((d) => d.source);
    expect(sources).toContain("root.md");
    expect(sources).toContain(join("subdir", "nested.md"));
    expect(sources).not.toContain(join("node_modules", "lib.md"));
    expect(sources).not.toContain(join(".git", "config.md"));
    expect(sources).not.toContain(join("vendor", "dep.md"));
    expect(sources).not.toContain(join("_build", "output.md"));
  });

  // ─── Chunking ───

  it("should produce chunks with correct size/overlap", async () => {
    // Create a large enough document to require chunking
    const longContent = Array(20)
      .fill("This is a paragraph with enough text to test chunking behavior.\n\n")
      .join("");
    writeFileSync(join(tempDir, "long.md"), longContent);

    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir, { chunk_size: 200, chunk_overlap: 50 });

    // Use ingest which will chunk and embed
    const result = await pipeline.ingest(group);

    expect(result.docCount).toBe(1);
    expect(result.chunkCount).toBeGreaterThan(1);
    expect(result.groupId).toBe(group.group_id);
    expect(result.groupName).toBe(group.group_name);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ─── ChromaDB Collection Naming ───

  it("should create ChromaDB collection with correct name ({prefix}_{slug})", async () => {
    writeFileSync(join(tempDir, "doc.md"), "# Test doc\nSome content.");

    const pipeline = new RagPipeline(createTestOptions({ collectionPrefix: "meshimize" }));
    const group = createTestGroup(tempDir, { slug: "fly-docs" });

    await pipeline.ingest(group);

    expect(mockGetOrCreateCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "meshimize_fly-docs",
      }),
    );
  });

  // ─── Retrieve ───

  it("should retrieve scored chunks", async () => {
    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir);

    const chunks = await pipeline.retrieve(group, "How do I deploy?");

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe("Document content 1");
    expect(chunks[0].source).toBe("file1.md");
    // Raw distance value from ChromaDB (lower = more similar)
    expect(chunks[0].score).toBeCloseTo(0.1, 5);
    expect(chunks[1].content).toBe("Document content 2");
    expect(chunks[1].source).toBe("file2.md");
    expect(chunks[1].score).toBeCloseTo(0.3, 5);
  });

  it("should default to Infinity score when distances are missing", async () => {
    mockQuery.mockResolvedValue({
      ids: [["chunk_0"]],
      documents: [["Some content"]],
      metadatas: [[{ source: "file.md" }]],
      distances: [[undefined]],
    });

    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir);

    const chunks = await pipeline.retrieve(group, "test query");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("Some content");
    expect(chunks[0].source).toBe("file.md");
    expect(chunks[0].score).toBe(Infinity);
  });

  // ─── needsIngestion ───

  it("should return true for missing collection", async () => {
    mockListCollections.mockResolvedValue([]);

    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir);

    const needs = await pipeline.needsIngestion(group);
    expect(needs).toBe(true);
  });

  it("should return false for fresh corpus", async () => {
    mockListCollections.mockResolvedValue(["meshimize_fly-docs"]);
    mockCount.mockResolvedValue(100);
    mockCollection.metadata = {
      ingested_at: new Date().toISOString(),
      group_id: "550e8400-e29b-41d4-a716-446655440000",
    };

    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir);

    const needs = await pipeline.needsIngestion(group);
    expect(needs).toBe(false);
  });

  it("should return true when ingested_at is an invalid date string", async () => {
    mockListCollections.mockResolvedValue(["meshimize_fly-docs"]);
    mockCount.mockResolvedValue(100);
    mockCollection.metadata = {
      ingested_at: "not-a-valid-date",
      group_id: "test-group-id",
    };

    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir);

    const needs = await pipeline.needsIngestion(group);
    expect(needs).toBe(true);
  });

  // ─── deleteCollection error handling ───

  it("should rethrow non-not-found errors from deleteCollection during ingest", async () => {
    writeFileSync(join(tempDir, "doc.md"), "# Test doc\nSome content.");
    mockDeleteCollection.mockRejectedValue(new Error("network timeout"));

    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir);

    await expect(pipeline.ingest(group)).rejects.toThrow("network timeout");
  });

  it("should ignore collection-not-found errors from deleteCollection during ingest", async () => {
    writeFileSync(join(tempDir, "doc.md"), "# Test doc\nSome content.");
    mockDeleteCollection.mockRejectedValue(new Error("collection does not exist"));

    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir);

    const result = await pipeline.ingest(group);
    expect(result.docCount).toBe(1);
  });

  // ─── group_id mismatch ───

  it("should return true from needsIngestion when group_id mismatches", async () => {
    mockListCollections.mockResolvedValue(["meshimize_fly-docs"]);
    mockCount.mockResolvedValue(100);
    mockCollection.metadata = {
      ingested_at: new Date().toISOString(),
      group_id: "old-group-id-that-does-not-match",
    };

    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir);

    const needs = await pipeline.needsIngestion(group);
    expect(needs).toBe(true);
  });

  // ─── Empty directory ───

  it("should produce zero chunks for empty directory", async () => {
    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir);

    const result = await pipeline.ingest(group);

    expect(result.docCount).toBe(0);
    expect(result.chunkCount).toBe(0);
  });

  // ─── ingest result ───

  it("should return correct IngestResult", async () => {
    writeFileSync(join(tempDir, "doc1.md"), "# Doc 1\nContent for document one.");
    writeFileSync(join(tempDir, "doc2.md"), "# Doc 2\nContent for document two.");

    const pipeline = new RagPipeline(createTestOptions());
    const group = createTestGroup(tempDir);

    const result = await pipeline.ingest(group);

    expect(result.groupId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result.groupName).toBe("Test Group");
    expect(result.docCount).toBe(2);
    expect(result.chunkCount).toBeGreaterThanOrEqual(2);
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ─── Batch rate limiting ───

  it("should respect rate limits between embedding batches", async () => {
    // Create enough content to require multiple batches (batchSize=1)
    writeFileSync(join(tempDir, "doc1.md"), "# Doc 1\n\nParagraph one content.");
    writeFileSync(join(tempDir, "doc2.md"), "# Doc 2\n\nParagraph two content.");
    writeFileSync(join(tempDir, "doc3.md"), "# Doc 3\n\nParagraph three content.");

    // Track sleep calls to verify rate limiting without real delays
    const sleepCalls: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((fn: TimerHandler, ms?: number) => {
        if (typeof fn === "function" && ms && ms > 0) {
          sleepCalls.push(ms);
        }
        // Resolve immediately to keep the test fast
        return originalSetTimeout(fn as () => void, 0);
      });

    try {
      const pipeline = new RagPipeline(
        createTestOptions({
          batchSize: 1,
          requestsPerMinute: 60, // 1 per second = 1000ms between batches
        }),
      );
      const group = createTestGroup(tempDir, {
        chunk_size: 5000,
        chunk_overlap: 0,
      });

      await pipeline.ingest(group);

      // With batchSize=1 and 3 docs, at least 3 embedding calls
      const callCount = mockEmbedDocuments.mock.calls.length;
      expect(callCount).toBeGreaterThanOrEqual(3);

      // Rate-limit sleeps should have been called between batches (not after the last one)
      expect(sleepCalls.length).toBeGreaterThanOrEqual(2);
      // Each sleep should be ~1000ms (60_000 / 60 rpm)
      for (const ms of sleepCalls) {
        expect(ms).toBeGreaterThanOrEqual(900);
        expect(ms).toBeLessThanOrEqual(1100);
      }
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  // ─── stripErbTags ───

  it("should strip various ERB tag formats", () => {
    expect(stripErbTags("<%= expression %>")).toBe("");
    expect(stripErbTags("<% code %>")).toBe("");
    expect(stripErbTags("<%# comment %>")).toBe("");
    expect(stripErbTags("<%- code -%>")).toBe("");
    expect(stripErbTags("Hello <%= name %> world")).toBe("Hello  world");
    expect(stripErbTags("No ERB here")).toBe("No ERB here");
  });
});
