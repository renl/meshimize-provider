// ─── Core shared types for meshimize-provider ───

/** Meshimize server message payload received via WebSocket */
export interface IncomingQuestion {
  message_id: string;
  group_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  message_type: "question";
  inserted_at: string;
  parent_message_id: string | null;
}

/** Answer to be posted back via REST API */
export interface OutgoingAnswer {
  content: string;
  message_type: "answer";
  parent_message_id: string;
}

/** RAG retrieval result */
export interface RetrievedChunk {
  content: string;
  source: string;
  /** Raw distance from ChromaDB query (lower = more similar). Metric depends on collection config (cosine, l2, ip). */
  score: number;
}

/** Per-group runtime state */
export interface GroupState {
  groupId: string;
  groupName: string;
  slug: string;
  channelTopic: string;
  status: "initializing" | "ready" | "degraded";
  queue: IncomingQuestion[];
  activeWorkers: number;
  maxConcurrency: number;
  answeredCount: number;
  totalLatencyMs: number;
}

/** Health endpoint response */
export interface HealthResponse {
  status: "healthy" | "degraded" | "starting";
  version: string;
  uptime_seconds: number;
  groups: {
    group_id: string;
    group_name: string;
    status: string;
    queue_depth: number;
    answered_count: number;
  }[];
  connection: "connected" | "disconnected" | "connecting";
}

/** Connection state for the WebSocket manager */
export type ConnectionState = "disconnected" | "connecting" | "connected";
