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

function writeRawYaml(dir: string, content: string): string {
  const filePath = join(dir, "test-config.yaml");
  writeFileSync(filePath, content, "utf-8");
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
      model: "qwen3.5-flash",
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
    expect(config.vector_store.persist_directory).toBe("http://localhost:8000");
    expect(config.vector_store.distance_metric).toBe("cosine");

    // Group defaults
    expect(config.groups[0].chunk_size).toBe(1000);
    expect(config.groups[0].chunk_overlap).toBe(200);
    expect(config.groups[0].top_k).toBe(5);

    // Embedding defaults
    expect(config.embedding.model).toBe("text-embedding-v4");
    expect(config.embedding.dimensions).toBe(1024);
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

  it("should override llm.base_url from LLM_BASE_URL env var", () => {
    const originalEnv = process.env.LLM_BASE_URL;
    try {
      process.env.LLM_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
      const configPath = writeYamlConfig(tempDir, validConfig());
      const config = loadConfig(configPath);

      expect(config.llm.base_url).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.LLM_BASE_URL;
      } else {
        process.env.LLM_BASE_URL = originalEnv;
      }
    }
  });

  it("should override embedding.base_url from EMBEDDING_BASE_URL env var", () => {
    const originalEnv = process.env.EMBEDDING_BASE_URL;
    try {
      process.env.EMBEDDING_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
      const configPath = writeYamlConfig(tempDir, validConfig());
      const config = loadConfig(configPath);

      expect(config.embedding.base_url).toBe(
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.EMBEDDING_BASE_URL;
      } else {
        process.env.EMBEDDING_BASE_URL = originalEnv;
      }
    }
  });

  it("should override embedding.model from EMBEDDING_MODEL env var", () => {
    const originalEnv = process.env.EMBEDDING_MODEL;
    try {
      process.env.EMBEDDING_MODEL = "text-embedding-v3";
      const configPath = writeYamlConfig(tempDir, validConfig());
      const config = loadConfig(configPath);

      expect(config.embedding.model).toBe("text-embedding-v3");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.EMBEDDING_MODEL;
      } else {
        process.env.EMBEDDING_MODEL = originalEnv;
      }
    }
  });

  it("should override groups[0].group_id from GROUP_ID env var", () => {
    const originalEnv = process.env.GROUP_ID;
    try {
      process.env.GROUP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const configPath = writeYamlConfig(tempDir, validConfig());
      const config = loadConfig(configPath);

      expect(config.groups[0].group_id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GROUP_ID;
      } else {
        process.env.GROUP_ID = originalEnv;
      }
    }
  });

  it("should override groups[0].group_name from GROUP_NAME env var", () => {
    const originalEnv = process.env.GROUP_NAME;
    try {
      process.env.GROUP_NAME = "Overridden Group";
      const configPath = writeYamlConfig(tempDir, validConfig());
      const config = loadConfig(configPath);

      expect(config.groups[0].group_name).toBe("Overridden Group");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GROUP_NAME;
      } else {
        process.env.GROUP_NAME = originalEnv;
      }
    }
  });

  it("should override embedding.batch_size from EMBEDDING_BATCH_SIZE env var", () => {
    const originalEnv = process.env.EMBEDDING_BATCH_SIZE;
    try {
      process.env.EMBEDDING_BATCH_SIZE = "256";
      const configPath = writeYamlConfig(tempDir, validConfig());
      const config = loadConfig(configPath);

      expect(config.embedding.batch_size).toBe(256);
      expect(typeof config.embedding.batch_size).toBe("number");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.EMBEDDING_BATCH_SIZE;
      } else {
        process.env.EMBEDDING_BATCH_SIZE = originalEnv;
      }
    }
  });

  it("should override groups[1].group_id from GROUP_2_ID env var", () => {
    const originalEnv = process.env.GROUP_2_ID;
    try {
      const cfg = validConfig();
      (cfg.groups as Record<string, unknown>[]).push({
        group_id: "660e8400-e29b-41d4-a716-446655440000",
        group_name: "Second Group",
        slug: "second-group",
        docs_path: "./second-docs",
      });
      process.env.GROUP_2_ID = "11111111-2222-3333-4444-555555555555";
      const configPath = writeYamlConfig(tempDir, cfg);
      const config = loadConfig(configPath);

      expect(config.groups[1].group_id).toBe("11111111-2222-3333-4444-555555555555");
      // Ensure group 1 is not affected
      expect(config.groups[0].group_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GROUP_2_ID;
      } else {
        process.env.GROUP_2_ID = originalEnv;
      }
    }
  });

  it("should override groups[1].group_name from GROUP_2_NAME env var", () => {
    const originalEnv = process.env.GROUP_2_NAME;
    try {
      const cfg = validConfig();
      (cfg.groups as Record<string, unknown>[]).push({
        group_id: "660e8400-e29b-41d4-a716-446655440000",
        group_name: "Second Group",
        slug: "second-group",
        docs_path: "./second-docs",
      });
      process.env.GROUP_2_NAME = "Overridden Second Group";
      const configPath = writeYamlConfig(tempDir, cfg);
      const config = loadConfig(configPath);

      expect(config.groups[1].group_name).toBe("Overridden Second Group");
      // Ensure group 1 is not affected
      expect(config.groups[0].group_name).toBe("Test Group");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GROUP_2_NAME;
      } else {
        process.env.GROUP_2_NAME = originalEnv;
      }
    }
  });

  it("should not apply GROUP_2 overrides when only one group exists", () => {
    const origId = process.env.GROUP_2_ID;
    const origName = process.env.GROUP_2_NAME;
    try {
      process.env.GROUP_2_ID = "11111111-2222-3333-4444-555555555555";
      process.env.GROUP_2_NAME = "Should Not Appear";
      const configPath = writeYamlConfig(tempDir, validConfig());
      const config = loadConfig(configPath);

      expect(config.groups).toHaveLength(1);
      expect(config.groups[0].group_id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(config.groups[0].group_name).toBe("Test Group");
    } finally {
      if (origId === undefined) {
        delete process.env.GROUP_2_ID;
      } else {
        process.env.GROUP_2_ID = origId;
      }
      if (origName === undefined) {
        delete process.env.GROUP_2_NAME;
      } else {
        process.env.GROUP_2_NAME = origName;
      }
    }
  });

  it("should override groups[2].group_id from GROUP_3_ID env var", () => {
    const originalEnv = process.env.GROUP_3_ID;
    try {
      const cfg = validConfig();
      (cfg.groups as Record<string, unknown>[]).push(
        {
          group_id: "660e8400-e29b-41d4-a716-446655440000",
          group_name: "Second Group",
          slug: "second-group",
          docs_path: "./second-docs",
        },
        {
          group_id: "770e8400-e29b-41d4-a716-446655440000",
          group_name: "Third Group",
          slug: "third-group",
          docs_path: "./third-docs",
        },
      );
      process.env.GROUP_3_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const configPath = writeYamlConfig(tempDir, cfg);
      const config = loadConfig(configPath);

      expect(config.groups[2].group_id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      // Ensure groups 1 and 2 are not affected
      expect(config.groups[0].group_id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(config.groups[1].group_id).toBe("660e8400-e29b-41d4-a716-446655440000");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GROUP_3_ID;
      } else {
        process.env.GROUP_3_ID = originalEnv;
      }
    }
  });

  it("should override groups[2].group_name from GROUP_3_NAME env var", () => {
    const originalEnv = process.env.GROUP_3_NAME;
    try {
      const cfg = validConfig();
      (cfg.groups as Record<string, unknown>[]).push(
        {
          group_id: "660e8400-e29b-41d4-a716-446655440000",
          group_name: "Second Group",
          slug: "second-group",
          docs_path: "./second-docs",
        },
        {
          group_id: "770e8400-e29b-41d4-a716-446655440000",
          group_name: "Third Group",
          slug: "third-group",
          docs_path: "./third-docs",
        },
      );
      process.env.GROUP_3_NAME = "Overridden Third Group";
      const configPath = writeYamlConfig(tempDir, cfg);
      const config = loadConfig(configPath);

      expect(config.groups[2].group_name).toBe("Overridden Third Group");
      // Ensure groups 1 and 2 are not affected
      expect(config.groups[0].group_name).toBe("Test Group");
      expect(config.groups[1].group_name).toBe("Second Group");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GROUP_3_NAME;
      } else {
        process.env.GROUP_3_NAME = originalEnv;
      }
    }
  });

  it("should not apply GROUP_3 overrides when only two groups exist", () => {
    const origId = process.env.GROUP_3_ID;
    const origName = process.env.GROUP_3_NAME;
    try {
      const cfg = validConfig();
      (cfg.groups as Record<string, unknown>[]).push({
        group_id: "660e8400-e29b-41d4-a716-446655440000",
        group_name: "Second Group",
        slug: "second-group",
        docs_path: "./second-docs",
      });
      process.env.GROUP_3_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      process.env.GROUP_3_NAME = "Should Not Appear";
      const configPath = writeYamlConfig(tempDir, cfg);
      const config = loadConfig(configPath);

      expect(config.groups).toHaveLength(2);
      expect(config.groups[0].group_id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(config.groups[1].group_id).toBe("660e8400-e29b-41d4-a716-446655440000");
    } finally {
      if (origId === undefined) {
        delete process.env.GROUP_3_ID;
      } else {
        process.env.GROUP_3_ID = origId;
      }
      if (origName === undefined) {
        delete process.env.GROUP_3_NAME;
      } else {
        process.env.GROUP_3_NAME = origName;
      }
    }
  });

  it("should reject invalid llm.provider value", () => {
    const cfg = validConfig();
    (cfg.llm as Record<string, unknown>).provider = "invalid-provider";
    const configPath = writeYamlConfig(tempDir, cfg);

    expect(() => loadConfig(configPath)).toThrow();
  });

  // ─── YAML guard tests (Fix #3) ───

  it("should throw when YAML file is empty (null root)", () => {
    const configPath = writeRawYaml(tempDir, "");
    expect(() => loadConfig(configPath)).toThrow(
      "Invalid configuration file: root YAML value must be a mapping/object.",
    );
  });

  it("should throw when YAML root is a scalar string", () => {
    const configPath = writeRawYaml(tempDir, "just a string\n");
    expect(() => loadConfig(configPath)).toThrow(
      "Invalid configuration file: root YAML value must be a mapping/object.",
    );
  });

  it("should throw when YAML root is an array", () => {
    const configPath = writeRawYaml(tempDir, "- item1\n- item2\n");
    expect(() => loadConfig(configPath)).toThrow(
      "Invalid configuration file: root YAML value must be a mapping/object.",
    );
  });

  it("should throw when YAML root is a number", () => {
    const configPath = writeRawYaml(tempDir, "42\n");
    expect(() => loadConfig(configPath)).toThrow(
      "Invalid configuration file: root YAML value must be a mapping/object.",
    );
  });

  // ─── persist_directory URL scheme validation ───

  it("should reject ftp:// URL for persist_directory", () => {
    const cfg = validConfig();
    cfg.vector_store = { persist_directory: "ftp://example.com:8000" };
    const configPath = writeYamlConfig(tempDir, cfg);

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("should reject file:// URL for persist_directory", () => {
    const cfg = validConfig();
    cfg.vector_store = { persist_directory: "file:///local/path" };
    const configPath = writeYamlConfig(tempDir, cfg);

    expect(() => loadConfig(configPath)).toThrow();
  });
});
