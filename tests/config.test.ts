import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";

// ─── Helpers ───

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "meshimize-config-test-"));
}

function writeYamlConfig(dir: string, config: Record<string, unknown>): string {
  const filePath = join(dir, "test-config.yaml");
  writeFileSync(filePath, stringifyYaml(config), "utf-8");
  return filePath;
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
        group_name: "Test Group",
        slug: "test-group",
        docs_path: "./test-docs",
      },
    ],
  };
}

// ─── Tests ───

describe("config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should parse a valid config successfully", () => {
    const configPath = writeYamlConfig(tempDir, validConfig());
    const config = loadConfig(configPath);

    expect(config.meshimize.server_url).toBe("https://api.test.com");
    expect(config.meshimize.api_key).toBe("test-key-123");
    expect(config.llm.provider).toBe("openai");
    expect(config.groups).toHaveLength(1);
    expect(config.groups[0].group_id).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("should throw ZodError when meshimize.api_key is missing", () => {
    const cfg = validConfig();
    (cfg.meshimize as Record<string, unknown>).api_key = undefined;
    delete (cfg.meshimize as Record<string, unknown>).api_key;
    const configPath = writeYamlConfig(tempDir, cfg);

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("should throw ZodError when meshimize.server_url is missing", () => {
    const cfg = validConfig();
    delete (cfg.meshimize as Record<string, unknown>).server_url;
    const configPath = writeYamlConfig(tempDir, cfg);

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("should throw ZodError when groups array is missing", () => {
    const cfg = validConfig();
    delete cfg.groups;
    const configPath = writeYamlConfig(tempDir, cfg);

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("should throw ZodError when groups array is empty", () => {
    const cfg = validConfig();
    cfg.groups = [];
    const configPath = writeYamlConfig(tempDir, cfg);

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("should reject non-UUID group_id", () => {
    const cfg = validConfig();
    (cfg.groups as Record<string, unknown>[])[0].group_id = "not-a-uuid";
    const configPath = writeYamlConfig(tempDir, cfg);

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("should reject slug with uppercase characters", () => {
    const cfg = validConfig();
    (cfg.groups as Record<string, unknown>[])[0].slug = "Invalid-Slug";
    const configPath = writeYamlConfig(tempDir, cfg);

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("should apply default values when optional fields are omitted", () => {
    const configPath = writeYamlConfig(tempDir, validConfig());
    const config = loadConfig(configPath);

    // Agent defaults
    expect(config.agent.log_level).toBe("info");
    expect(config.agent.health_port).toBe(8080);
    expect(config.agent.queue_max_depth).toBe(50);
    expect(config.agent.shutdown_timeout_ms).toBe(10000);

    // Vector store defaults
    expect(config.vector_store.provider).toBe("chromadb");
    expect(config.vector_store.persist_directory).toBe("./data/chromadb");
    expect(config.vector_store.distance_metric).toBe("cosine");

    // Group defaults
    expect(config.groups[0].chunk_size).toBe(1000);
    expect(config.groups[0].chunk_overlap).toBe(200);
    expect(config.groups[0].top_k).toBe(5);

    // Embedding defaults
    expect(config.embedding.model).toBe("text-embedding-3-small");
    expect(config.embedding.dimensions).toBe(1536);
  });

  it("should override meshimize.api_key from MESHIMIZE_API_KEY env var", () => {
    const originalEnv = process.env.MESHIMIZE_API_KEY;
    try {
      process.env.MESHIMIZE_API_KEY = "env-override-key";
      const configPath = writeYamlConfig(tempDir, validConfig());
      const config = loadConfig(configPath);

      expect(config.meshimize.api_key).toBe("env-override-key");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.MESHIMIZE_API_KEY;
      } else {
        process.env.MESHIMIZE_API_KEY = originalEnv;
      }
    }
  });

  it("should override agent.health_port from HEALTH_PORT env var as number", () => {
    const originalEnv = process.env.HEALTH_PORT;
    try {
      process.env.HEALTH_PORT = "9090";
      const configPath = writeYamlConfig(tempDir, validConfig());
      const config = loadConfig(configPath);

      expect(config.agent.health_port).toBe(9090);
      expect(typeof config.agent.health_port).toBe("number");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.HEALTH_PORT;
      } else {
        process.env.HEALTH_PORT = originalEnv;
      }
    }
  });

  it("should override agent.log_level from LOG_LEVEL env var", () => {
    const originalEnv = process.env.LOG_LEVEL;
    try {
      process.env.LOG_LEVEL = "debug";
      const configPath = writeYamlConfig(tempDir, validConfig());
      const config = loadConfig(configPath);

      expect(config.agent.log_level).toBe("debug");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = originalEnv;
      }
    }
  });

  it("should reject invalid llm.provider value", () => {
    const cfg = validConfig();
    (cfg.llm as Record<string, unknown>).provider = "invalid-provider";
    const configPath = writeYamlConfig(tempDir, cfg);

    expect(() => loadConfig(configPath)).toThrow();
  });
});
