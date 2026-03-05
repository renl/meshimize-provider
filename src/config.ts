import { z } from "zod";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// ─── Zod Schema ───

const GroupConfigSchema = z.object({
  group_id: z.string().uuid(),
  group_name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  docs_path: z.string().min(1),
  chunk_size: z.number().int().min(100).max(4000).default(1000),
  chunk_overlap: z.number().int().min(0).max(500).default(200),
  top_k: z.number().int().min(1).max(20).default(5),
  max_concurrency: z.number().int().min(1).max(5).default(2),
  system_prompt: z.string().optional(),
});

const MeshimizeServerSchema = z.object({
  server_url: z.string().url(),
  api_key: z.string().min(1),
  ws_path: z.string().default("/socket/websocket"),
});

const LLMSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().min(1),
  api_key: z.string().min(1),
  base_url: z.string().url().optional(),
  max_tokens: z.number().int().min(100).max(4000).default(1000),
  temperature: z.number().min(0).max(2).default(0.3),
});

const EmbeddingSchema = z.object({
  provider: z.literal("openai"),
  model: z.string().default("text-embedding-v4"),
  api_key: z.string().min(1),
  base_url: z.string().url().optional(),
  dimensions: z.number().int().default(1024),
  batch_size: z.number().int().min(1).max(2048).default(10),
  requests_per_minute: z.number().int().min(1).default(3000),
});

const VectorStoreSchema = z.object({
  provider: z.literal("chromadb").default("chromadb"),
  /** ChromaDB server URL (e.g., http://localhost:8000). Must be a valid HTTP(S) URL. */
  persist_directory: z
    .string()
    .url()
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
      message: "persist_directory must be an HTTP or HTTPS URL",
    })
    .default("http://localhost:8000"),
  collection_prefix: z.string().default("meshimize"),
  distance_metric: z.enum(["cosine", "l2", "ip"]).default("cosine"),
  stale_days: z.number().int().min(1).default(7),
});

const AgentSchema = z.object({
  queue_max_depth: z.number().int().min(10).max(200).default(50),
  reconnect_delays_ms: z.array(z.number().int()).default([1000, 2000, 5000, 10000, 30000]),
  health_port: z.number().int().default(8080),
  health_summary_interval_s: z.number().int().default(300),
  shutdown_timeout_ms: z.number().int().default(10000),
  log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const ConfigSchema = z.object({
  meshimize: MeshimizeServerSchema,
  llm: LLMSchema,
  embedding: EmbeddingSchema,
  vector_store: VectorStoreSchema.default({}),
  agent: AgentSchema.default({}),
  groups: z.array(GroupConfigSchema).min(1).max(8),
});

export type Config = z.infer<typeof ConfigSchema>;
export type GroupConfig = z.infer<typeof GroupConfigSchema>;

// ─── Env Override Mapping ───

interface EnvMapping {
  envKey: string;
  configPath: string;
  type: "string" | "number";
}

const ENV_MAPPINGS: EnvMapping[] = [
  { envKey: "MESHIMIZE_SERVER_URL", configPath: "meshimize.server_url", type: "string" },
  { envKey: "MESHIMIZE_API_KEY", configPath: "meshimize.api_key", type: "string" },
  { envKey: "LLM_PROVIDER", configPath: "llm.provider", type: "string" },
  { envKey: "LLM_MODEL", configPath: "llm.model", type: "string" },
  { envKey: "LLM_API_KEY", configPath: "llm.api_key", type: "string" },
  { envKey: "LLM_BASE_URL", configPath: "llm.base_url", type: "string" },
  { envKey: "EMBEDDING_API_KEY", configPath: "embedding.api_key", type: "string" },
  { envKey: "EMBEDDING_MODEL", configPath: "embedding.model", type: "string" },
  { envKey: "EMBEDDING_BASE_URL", configPath: "embedding.base_url", type: "string" },
  { envKey: "EMBEDDING_BATCH_SIZE", configPath: "embedding.batch_size", type: "number" },
  { envKey: "LOG_LEVEL", configPath: "agent.log_level", type: "string" },
  { envKey: "HEALTH_PORT", configPath: "agent.health_port", type: "number" },
];

function applyEnvOverrides(config: Record<string, unknown>): void {
  for (const mapping of ENV_MAPPINGS) {
    const val = process.env[mapping.envKey];
    if (val === undefined) continue;

    const parts = mapping.configPath.split(".");
    let current: Record<string, unknown> = config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (
        !(parts[i] in current) ||
        typeof current[parts[i]] !== "object" ||
        current[parts[i]] === null
      ) {
        current[parts[i]] = {};
      }
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = mapping.type === "number" ? Number(val) : val;
  }
}

function applyGroupEnvOverrides(config: Record<string, unknown>): void {
  const groups = config.groups;
  if (!Array.isArray(groups) || groups.length === 0) return;
  const first = groups[0] as Record<string, unknown>;

  const groupId = process.env.GROUP_ID;
  if (groupId !== undefined) {
    first.group_id = groupId;
  }

  const groupName = process.env.GROUP_NAME;
  if (groupName !== undefined) {
    first.group_name = groupName;
  }
}

export function loadConfig(configPath: string): Config {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid configuration file: root YAML value must be a mapping/object.");
  }
  const configObject = parsed as Record<string, unknown>;

  // Apply env var overrides (highest priority)
  applyEnvOverrides(configObject);
  applyGroupEnvOverrides(configObject);

  // Validate with Zod
  return ConfigSchema.parse(configObject);
}
