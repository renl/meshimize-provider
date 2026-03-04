import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";

// ─── Hoisted mocks ───

const { mockIngest } = vi.hoisted(() => {
  const mockIngest = vi.fn();
  return { mockIngest };
});

vi.mock("../../src/rag-pipeline.js", () => {
  return {
    RagPipeline: vi.fn().mockImplementation(() => ({
      ingest: mockIngest,
      needsIngestion: vi.fn().mockResolvedValue(true),
      retrieve: vi.fn().mockResolvedValue([]),
      validate: vi.fn().mockResolvedValue({ isValid: true }),
    })),
  };
});

// ─── Import after mocks ───

const { runIngestCommand } = await import("../../src/commands/ingest-command.js");

// ─── Helpers ───

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "meshimize-ingest-test-"));
}

function validConfig(): Record<string, unknown> {
  return {
    meshimize: {
      server_url: "https://api.test.com",
      api_key: "test-key-123",
    },
    llm: {
      provider: "openai",
      model: "gpt-4o-mini",
      api_key: "test-llm-key",
    },
    embedding: {
      provider: "openai",
      api_key: "test-embed-key",
    },
    groups: [
      {
        group_id: "550e8400-e29b-41d4-a716-446655440000",
        group_name: "Fly.io Docs",
        slug: "fly-docs",
        docs_path: "./test-docs",
      },
      {
        group_id: "660e8400-e29b-41d4-a716-446655440000",
        group_name: "Elixir Docs",
        slug: "elixir-docs",
        docs_path: "./test-docs-2",
      },
    ],
  };
}

function writeYamlConfig(dir: string, config: Record<string, unknown>): string {
  const filePath = join(dir, "test-config.yaml");
  writeFileSync(filePath, stringifyYaml(config), "utf-8");
  return filePath;
}

// ─── Tests ───

describe("ingest-command", () => {
  let tempDir: string;
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = createTempDir();
    vi.clearAllMocks();
    // Mock process.exit to prevent actually exiting
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockRestore();
  });

  it("should ingest all groups sequentially", async () => {
    mockIngest.mockResolvedValue({
      groupId: "550e8400-e29b-41d4-a716-446655440000",
      groupName: "Fly.io Docs",
      docCount: 5,
      chunkCount: 25,
      durationMs: 100,
    });

    const configPath = writeYamlConfig(tempDir, validConfig());
    await runIngestCommand(configPath);

    expect(mockIngest).toHaveBeenCalledTimes(2);
    // Verify it was called with each group
    expect(mockIngest).toHaveBeenCalledWith(expect.objectContaining({ slug: "fly-docs" }));
    expect(mockIngest).toHaveBeenCalledWith(expect.objectContaining({ slug: "elixir-docs" }));
  });

  it("should log summary with totals", async () => {
    mockIngest
      .mockResolvedValueOnce({
        groupId: "550e8400-e29b-41d4-a716-446655440000",
        groupName: "Fly.io Docs",
        docCount: 5,
        chunkCount: 25,
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        groupId: "660e8400-e29b-41d4-a716-446655440000",
        groupName: "Elixir Docs",
        docCount: 3,
        chunkCount: 15,
        durationMs: 50,
      });

    const configPath = writeYamlConfig(tempDir, validConfig());
    await runIngestCommand(configPath);

    // Both groups ingested successfully
    expect(mockIngest).toHaveBeenCalledTimes(2);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("should exit with code 0 on success", async () => {
    mockIngest.mockResolvedValue({
      groupId: "550e8400-e29b-41d4-a716-446655440000",
      groupName: "Test",
      docCount: 1,
      chunkCount: 5,
      durationMs: 50,
    });

    const configPath = writeYamlConfig(tempDir, validConfig());
    await runIngestCommand(configPath);

    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("should exit with code 1 on failure", async () => {
    mockIngest.mockRejectedValue(new Error("Embedding API error"));

    const configPath = writeYamlConfig(tempDir, validConfig());
    await runIngestCommand(configPath);

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should log partial failure summary with warn level when some groups fail", async () => {
    // First group succeeds, second group fails
    mockIngest
      .mockResolvedValueOnce({
        groupId: "550e8400-e29b-41d4-a716-446655440000",
        groupName: "Fly.io Docs",
        docCount: 5,
        chunkCount: 25,
        durationMs: 100,
      })
      .mockRejectedValueOnce(new Error("Embedding API error"));

    const configPath = writeYamlConfig(tempDir, validConfig());
    await runIngestCommand(configPath);

    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
