// ─── SSE Connection Manager — Server-Sent Events Client ───
//
// One SSE HTTP connection per configured group. Receives `new_message` and
// `close` events via standard SSE (W3C). Routes incoming questions to the
// QuestionRouter via the `onQuestion` callback.
//
// Uses native `fetch` with streaming ReadableStream — zero external dependencies.
// Node.js 20+ supports `fetch` and `ReadableStream` natively.

import type pino from "pino";
import type { Config, GroupConfig } from "./config.js";
import type { IncomingMessage, IncomingQuestion, ConnectionState } from "./types.js";
import { getReconnectDelay } from "./connection-manager.js";

// ─── Types ───

export interface SseConnectionManagerOptions {
  config: Config;
  logger: pino.Logger;
  onQuestion: (question: IncomingQuestion, groupConfig: GroupConfig) => void;
  onConnectionStateChange: (state: ConnectionState) => void;
  /** Override fetch for testing */
  fetchFn?: typeof fetch;
}

/** Per-group connection state tracking */
interface GroupConnectionState {
  groupConfig: GroupConfig;
  state: "disconnected" | "connecting" | "connected";
  abortController: AbortController | null;
  lastEventId: string | null;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  keepaliveTimer: ReturnType<typeof setTimeout> | null;
}

// ─── SSE Connection Manager ───

export class SseConnectionManager {
  private readonly config: Config;
  private readonly logger: pino.Logger;
  private readonly onQuestion: SseConnectionManagerOptions["onQuestion"];
  private readonly onConnectionStateChange: SseConnectionManagerOptions["onConnectionStateChange"];
  private readonly fetchFn: typeof fetch;

  private groupConnections: Map<string, GroupConnectionState> = new Map();
  private explicitDisconnect: boolean = false;
  private initialConnect: boolean = false;
  private aggregateState: ConnectionState = "disconnected";

  constructor(options: SseConnectionManagerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.onQuestion = options.onQuestion;
    this.onConnectionStateChange = options.onConnectionStateChange;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** Opens SSE connections for all configured groups concurrently */
  async connect(): Promise<void> {
    this.explicitDisconnect = false;

    const groupCount = this.config.groups.length;
    this.logger.info(
      { transport: "sse", groupCount },
      `SSE transport: opening connections to ${groupCount} groups`,
    );

    // Initialize group connection states
    for (const group of this.config.groups) {
      this.groupConnections.set(group.group_id, {
        groupConfig: group,
        state: "disconnected",
        abortController: null,
        lastEventId: null,
        reconnectAttempt: 0,
        reconnectTimer: null,
        keepaliveTimer: null,
      });
    }

    // Open all connections concurrently
    this.initialConnect = true;
    try {
      const connectPromises = this.config.groups.map((group) => this.connectGroup(group.group_id));
      await Promise.all(connectPromises);
    } finally {
      this.initialConnect = false;
    }
  }

  /** Closes all SSE connections and cleans up */
  async disconnect(): Promise<void> {
    this.explicitDisconnect = true;

    for (const [groupId, conn] of this.groupConnections) {
      // Clear reconnect timer
      if (conn.reconnectTimer !== null) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
      }

      // Clear keepalive timer
      if (conn.keepaliveTimer !== null) {
        clearTimeout(conn.keepaliveTimer);
        conn.keepaliveTimer = null;
      }

      // Abort the HTTP request
      if (conn.abortController) {
        conn.abortController.abort();
        conn.abortController = null;
      }

      conn.state = "disconnected";
      this.logger.debug({ transport: "sse", groupId }, "SSE connection closed for group");
    }

    this.updateAggregateState();
  }

  /** Returns the aggregate connection state */
  getState(): ConnectionState {
    return this.aggregateState;
  }

  // ─── Private Methods ───

  private async connectGroup(groupId: string): Promise<void> {
    const conn = this.groupConnections.get(groupId);
    if (!conn) return;

    if (this.explicitDisconnect) return;

    conn.state = "connecting";
    this.updateAggregateState();

    const serverUrl = this.config.meshimize.server_url.replace(/\/$/, "");
    const url = `${serverUrl}/api/v1/groups/${groupId}/stream`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.meshimize.api_key}`,
      Accept: "text/event-stream",
    };

    if (conn.lastEventId) {
      headers["Last-Event-ID"] = conn.lastEventId;
    }

    this.logger.info(
      {
        transport: "sse",
        groupId,
        connectionState: "connecting",
        lastEventId: conn.lastEventId,
      },
      "Opening SSE connection for group",
    );

    const abortController = new AbortController();
    conn.abortController = abortController;

    try {
      const response = await this.fetchFn(url, {
        method: "GET",
        headers,
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("SSE connection failed: no response body");
      }

      // Connection established
      conn.state = "connected";
      conn.reconnectAttempt = 0;
      this.updateAggregateState();

      this.logger.info(
        { transport: "sse", groupId, connectionState: "connected" },
        "SSE connection established for group",
      );

      // Start keepalive timer
      this.resetKeepaliveTimer(groupId);

      // Process the stream in the background (fire-and-forget)
      // Stream processing continues after connect() resolves
      this.processStream(groupId, response.body).catch((err) => {
        if (this.explicitDisconnect) return;
        if (err instanceof Error && err.name === "AbortError") return;
        this.logger.error(
          {
            transport: "sse",
            groupId,
            err: err instanceof Error ? err.message : String(err),
          },
          "SSE stream processing error",
        );
      });
    } catch (err) {
      if (this.explicitDisconnect) return;

      // AbortError is expected when we call abort() ourselves
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }

      this.logger.error(
        {
          transport: "sse",
          groupId,
          err: err instanceof Error ? err.message : String(err),
        },
        "SSE connection error for group",
      );

      conn.state = "disconnected";
      conn.abortController = null;
      this.updateAggregateState();

      // On initial connect, propagate the error to the caller
      if (this.initialConnect) {
        throw err;
      }

      // Schedule reconnection
      this.scheduleReconnect(groupId);
    }
  }

  private async processStream(groupId: string, body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();

    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        if (this.explicitDisconnect) {
          reader.cancel().catch(() => {});
          return;
        }

        // Reset keepalive timer on any chunk received
        this.resetKeepaliveTimer(groupId);

        buffer += decoder.decode(value, { stream: true });

        // Process complete events from the buffer
        buffer = this.processBuffer(groupId, buffer);
      }
    } catch (err) {
      if (this.explicitDisconnect) return;

      if (err instanceof Error && err.name === "AbortError") {
        return;
      }

      this.logger.error(
        {
          transport: "sse",
          groupId,
          err: err instanceof Error ? err.message : String(err),
        },
        "SSE stream read error",
      );
    }

    // Stream ended — if not explicit disconnect, reconnect
    const conn = this.groupConnections.get(groupId);
    if (conn && !this.explicitDisconnect) {
      conn.state = "disconnected";
      conn.abortController = null;

      // Clear keepalive timer
      if (conn.keepaliveTimer !== null) {
        clearTimeout(conn.keepaliveTimer);
        conn.keepaliveTimer = null;
      }

      this.updateAggregateState();
      this.scheduleReconnect(groupId);
    }
  }

  /**
   * Process the buffer for complete SSE events.
   * Returns the remaining unprocessed buffer.
   *
   * SSE format (W3C spec):
   *   event: <type>\n
   *   id: <id>\n
   *   data: <payload>\n
   *   \n  (empty line terminates an event)
   *
   * Lines starting with `:` are comments (e.g., `: ping`).
   */
  private processBuffer(groupId: string, buffer: string): string {
    // Split on double newlines (event boundary)
    const parts = buffer.split("\n\n");

    // Last part may be incomplete — keep it as the new buffer
    const remaining = parts.pop() ?? "";

    for (const block of parts) {
      if (block.trim() === "") continue;

      const lines = block.split("\n");

      // Check if this is purely a comment block (e.g., `: ping`)
      const isOnlyComments = lines.every((line) => line.startsWith(":") || line.trim() === "");
      if (isOnlyComments) {
        // Comment-only block (keepalive ping) — timer already reset on chunk receive
        continue;
      }

      let eventType = "";
      let eventId = "";
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith(":")) {
          // SSE comment — ignore
          continue;
        }

        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("id:")) {
          eventId = line.slice(3).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
        }
      }

      const eventData = dataLines.join("\n");

      // Track last event ID
      if (eventId) {
        const conn = this.groupConnections.get(groupId);
        if (conn) {
          conn.lastEventId = eventId;
        }
      }

      // Dispatch based on event type
      if (eventType === "new_message") {
        this.handleNewMessage(groupId, eventData);
      } else if (eventType === "close") {
        this.handleCloseEvent(groupId, eventData);
      }
    }

    return remaining;
  }

  private handleNewMessage(groupId: string, rawData: string): void {
    let message: IncomingMessage;
    try {
      message = JSON.parse(rawData) as IncomingMessage;
    } catch {
      this.logger.warn(
        { transport: "sse", groupId, rawData },
        "Failed to parse SSE new_message event data",
      );
      return;
    }

    // Validate required fields
    if (
      !message.id ||
      !message.group_id ||
      !message.content ||
      !message.message_type ||
      !message.sender ||
      message.parent_message_id === undefined ||
      !message.inserted_at
    ) {
      this.logger.warn(
        { transport: "sse", groupId, messageId: message.id },
        "SSE new_message missing required fields — skipping",
      );
      return;
    }

    // Defense-in-depth: only process questions
    if (message.message_type !== "question") {
      this.logger.debug(
        {
          transport: "sse",
          groupId,
          messageId: message.id,
          messageType: message.message_type,
        },
        "Ignoring non-question message (SSE defense-in-depth)",
      );
      return;
    }

    // Look up GroupConfig
    const conn = this.groupConnections.get(groupId);
    if (!conn) return;

    this.logger.info(
      {
        transport: "sse",
        groupId,
        messageId: message.id,
        senderName: message.sender.display_name,
      },
      "Received question via SSE",
    );

    this.onQuestion(message as IncomingQuestion, conn.groupConfig);
  }

  private handleCloseEvent(groupId: string, rawData: string): void {
    let data: { reason: string };
    try {
      data = JSON.parse(rawData) as { reason: string };
    } catch {
      this.logger.warn(
        { transport: "sse", groupId, rawData },
        "Failed to parse SSE close event data",
      );
      return;
    }

    const conn = this.groupConnections.get(groupId);
    if (!conn) return;

    this.logger.info(
      { transport: "sse", groupId, closeReason: data.reason },
      "SSE close event received",
    );

    // Abort the current connection
    if (conn.abortController) {
      conn.abortController.abort();
      conn.abortController = null;
    }

    // Clear keepalive timer
    if (conn.keepaliveTimer !== null) {
      clearTimeout(conn.keepaliveTimer);
      conn.keepaliveTimer = null;
    }

    conn.state = "disconnected";
    this.updateAggregateState();

    if (data.reason === "superseded") {
      // Do NOT reconnect — another connection has taken over
      this.logger.info(
        { transport: "sse", groupId, closeReason: "superseded" },
        "SSE connection superseded — not reconnecting",
      );
      return;
    }

    if (data.reason === "server_shutdown") {
      // Reconnect immediately (attempt 0, no backoff)
      this.logger.info(
        { transport: "sse", groupId, closeReason: "server_shutdown" },
        "Server shutdown — reconnecting immediately",
      );
      conn.reconnectAttempt = 0;
      this.connectGroup(groupId);
      return;
    }

    // Unknown reason — treat as error, reconnect with backoff
    this.scheduleReconnect(groupId);
  }

  private scheduleReconnect(groupId: string): void {
    if (this.explicitDisconnect) return;

    const conn = this.groupConnections.get(groupId);
    if (!conn) return;

    const currentAttempt = conn.reconnectAttempt;
    const delay = getReconnectDelay(currentAttempt, this.config.agent.reconnect_delays_ms);

    this.logger.info(
      {
        transport: "sse",
        groupId,
        reconnectAttempt: currentAttempt,
        reconnectDelayMs: delay,
        lastEventId: conn.lastEventId,
      },
      "Scheduling SSE reconnection",
    );

    conn.reconnectAttempt = currentAttempt + 1;

    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      if (!this.explicitDisconnect) {
        this.connectGroup(groupId);
      }
    }, delay);
  }

  private resetKeepaliveTimer(groupId: string): void {
    const conn = this.groupConnections.get(groupId);
    if (!conn) return;

    // Clear existing timer
    if (conn.keepaliveTimer !== null) {
      clearTimeout(conn.keepaliveTimer);
    }

    // Set new timer
    const timeoutMs = this.config.agent.sse_keepalive_timeout_ms;
    conn.keepaliveTimer = setTimeout(() => {
      if (this.explicitDisconnect) return;

      this.logger.warn(
        { transport: "sse", groupId },
        "SSE keepalive timeout — treating connection as dead",
      );

      // Abort the connection
      if (conn.abortController) {
        conn.abortController.abort();
        conn.abortController = null;
      }

      conn.keepaliveTimer = null;
      conn.state = "disconnected";
      this.updateAggregateState();

      // Reconnect
      this.scheduleReconnect(groupId);
    }, timeoutMs);
  }

  private updateAggregateState(): void {
    const states = Array.from(this.groupConnections.values()).map((c) => c.state);

    let newState: ConnectionState;

    if (states.length === 0) {
      newState = "disconnected";
    } else if (states.every((s) => s === "connected")) {
      newState = "connected";
    } else if (states.every((s) => s === "disconnected")) {
      newState = "disconnected";
    } else {
      newState = "connecting";
    }

    if (newState !== this.aggregateState) {
      this.logger.debug(
        { transport: "sse", from: this.aggregateState, to: newState },
        "SSE aggregate state change",
      );
      this.aggregateState = newState;
      this.onConnectionStateChange(newState);
    }
  }
}
