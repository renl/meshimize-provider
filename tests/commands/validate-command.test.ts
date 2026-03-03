import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";

// ─── Hoisted mocks ───

const { mockValidate } = vi.hoisted(() => {
  const mockValidate = vi.fn();
  return { mockValidate };
});

vi.mock("../../src/rag-pipeline.js", () => {
  return {
    RagPipeline: vi.fn().mockImplementation(() => ({
      ingest: vi.fn().mockResolvedValue({
        groupId: "test",
        groupName: "Test",
        docCount: 0,
        chunkCount: 0,
        durationMs: 0,
      }),
      needsIngestion: vi.fn().mockResolvedValue(true),
      retrieve: vi.fn().mockResolvedValue([]),
      validate: mockValidate,
    })),
  };
});

// ─── Import after mocks ───

const { runValidateCommand } = await import("../../src/commands/validate-command.js");

// ─── Helpers ───

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "meshimize-validate-test-"));
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

describe("validate-command", () => {
  let tempDir: string;
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = createTempDir();
    vi.clearAllMocks();
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockRestore();
  });

  it("should validate existing corpus correctly", async () => {
    mockValidate.mockResolvedValue({
      groupId: "550e8400-e29b-41d4-a716-446655440000",
      groupName: "Fly.io Docs",
      collectionExists: true,
      chunkCount: 100,
      sampleQuery: "How do I deploy?",
      sampleResults: 5,
      isValid: true,
    });

    const configPath = writeYamlConfig(tempDir, validConfig());
    await runValidateCommand(configPath);

    expect(mockValidate).toHaveBeenCalledTimes(2);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("should report missing/invalid corpus", async () => {
    mockValidate.mockResolvedValue({
      groupId: "550e8400-e29b-41d4-a716-446655440000",
      groupName: "Fly.io Docs",
      collectionExists: false,
      chunkCount: 0,
      sampleQuery: "How do I deploy?",
      sampleResults: 0,
      isValid: false,
    });

    const configPath = writeYamlConfig(tempDir, validConfig());
    await runValidateCommand(configPath);

    expect(mockValidate).toHaveBeenCalledTimes(2);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should run sample query for each group", async () => {
    mockValidate.mockResolvedValue({
      groupId: "test-id",
      groupName: "Test",
      collectionExists: true,
      chunkCount: 50,
      sampleQuery: "How do I deploy?",
      sampleResults: 3,
      isValid: true,
    });

    const configPath = writeYamlConfig(tempDir, validConfig());
    await runValidateCommand(configPath);

    // Validate called for each of the 2 groups
    expect(mockValidate).toHaveBeenCalledTimes(2);
    expect(mockValidate).toHaveBeenCalledWith(expect.objectContaining({ slug: "fly-docs" }));
    expect(mockValidate).toHaveBeenCalledWith(expect.objectContaining({ slug: "elixir-docs" }));
  });

  it("should exit with correct codes (0 for all valid, 1 for any invalid)", async () => {
    // First group valid, second group invalid
    mockValidate
      .mockResolvedValueOnce({
        groupId: "550e8400-e29b-41d4-a716-446655440000",
        groupName: "Fly.io Docs",
        collectionExists: true,
        chunkCount: 100,
        sampleQuery: "How do I deploy?",
        sampleResults: 5,
        isValid: true,
      })
      .mockResolvedValueOnce({
        groupId: "660e8400-e29b-41d4-a716-446655440000",
        groupName: "Elixir Docs",
        collectionExists: false,
        chunkCount: 0,
        sampleQuery: "How do I deploy?",
        sampleResults: 0,
        isValid: false,
      });

    const configPath = writeYamlConfig(tempDir, validConfig());
    await runValidateCommand(configPath);

    // One invalid → exit code 1
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
