// ─── Connection Manager — Phoenix Channels WebSocket Client ───
//
// Decision: Custom minimal Phoenix Channels client using Node.js built-in WebSocket
// instead of the `phoenix-channels` npm package. Reasons:
// 1. phoenix-channels is CJS-only (module.exports), causing ESM interop friction
// 2. No TypeScript types available
// 3. Depends on `websocket` npm package (w3cwebsocket) — another CJS dep
// 4. Difficult to mock in tests due to deep require() chains
// 5. Custom client is ~200 lines, uses Phoenix wire format: [join_ref, ref, topic, event, payload]
//
// Phoenix wire protocol v2.0.0:
//   Messages are JSON arrays: [join_ref, ref, topic, event, payload]
//   Events: phx_join, phx_reply, phx_leave, phx_close, phx_error, heartbeat
//   Join: [join_ref, ref, "group:ID", "phx_join", {api_key: "..."}]
//   Reply: [join_ref, ref, topic, "phx_reply", {status: "ok"|"error", response: {...}}]

import type pino from "pino";
import type { Config, GroupConfig } from "./config.js";
import type { IncomingQuestion, ConnectionState } from "./types.js";

// ─── Phoenix Wire Protocol Types ───

/** Phoenix v2 wire format: [join_ref, ref, topic, event, payload] */
type PhoenixMessage = [string | null, string | null, string, string, unknown];

interface PhoenixReplyPayload {
  status: "ok" | "error";
  response: Record<string, unknown>;
}

// ─── Auth Types ───

interface AuthResponse {
  data: {
    token: string;
    account: {
      id: string;
      display_name: string;
    };
  };
}

interface MemberInfo {
  account_id: string;
  role: string;
}

interface MembersResponse {
  data: MemberInfo[];
}

// ─── WebSocket Abstraction (for testability) ───

/** Minimal WebSocket interface matching the subset we use from the global WebSocket */
export interface WebSocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

// ─── Exported Helpers ───

/**
 * Calculate reconnect delay using exponential backoff from config array.
 * Returns the delay at `attempt` index, clamped to the last element.
 */
export function getReconnectDelay(attempt: number, delays: number[]): number {
  if (delays.length === 0) return 1000;
  return delays[Math.min(attempt, delays.length - 1)];
}

// ─── Channel Tracker ───

interface ChannelState {
  topic: string;
  joinRef: string;
  joined: boolean;
  groupConfig: GroupConfig;
}

// ─── Connection Manager ───

export interface ConnectionManagerOptions {
  config: Config;
  logger: pino.Logger;
  onQuestion: (question: IncomingQuestion, groupConfig: GroupConfig) => void;
  onConnectionStateChange: (state: ConnectionState) => void;
  /** Override WebSocket constructor for testing */
  webSocketFactory?: WebSocketFactory;
  /** Override fetch for testing */
  fetchFn?: typeof globalThis.fetch;
}

export class ConnectionManager {
  private state: ConnectionState = "disconnected";
  private reconnectAttempt: number = 0;
  private socket: WebSocketLike | null = null;
  private channels: Map<string, ChannelState> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private refCounter: number = 0;
  private pendingHeartbeatRef: string | null = null;
  private token: string | null = null;
  private accountId: string | null = null;
  private explicitDisconnect: boolean = false;

  private readonly config: Config;
  private readonly logger: pino.Logger;
  private readonly onQuestion: ConnectionManagerOptions["onQuestion"];
  private readonly onConnectionStateChange: ConnectionManagerOptions["onConnectionStateChange"];
  private readonly webSocketFactory: WebSocketFactory;
  private readonly fetchFn: typeof globalThis.fetch;

  // Pending join resolve/reject callbacks keyed by ref
  private pendingJoins: Map<string, { resolve: () => void; reject: (err: Error) => void }> =
    new Map();

  constructor(options: ConnectionManagerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.onQuestion = options.onQuestion;
    this.onConnectionStateChange = options.onConnectionStateChange;
    this.webSocketFactory =
      options.webSocketFactory ?? ((url: string) => new WebSocket(url) as WebSocketLike);
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /** Authenticate via REST API, then connect WebSocket */
  async connect(): Promise<void> {
    this.explicitDisconnect = false;
    this.setState("connecting");

    try {
      // 1. REST authentication
      const serverUrl = this.config.meshimize.server_url.replace(/\/$/, "");
      const authUrl = `${serverUrl}/api/v1/auth/login`;

      this.logger.info({ url: authUrl }, "Authenticating with Meshimize server");

      const authResponse = await this.fetchFn(authUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.meshimize.api_key,
        },
        body: JSON.stringify({}),
      });

      if (!authResponse.ok) {
        const errorText = await authResponse.text();
        throw new Error(`Authentication failed (${authResponse.status}): ${errorText}`);
      }

      const authData = (await authResponse.json()) as AuthResponse;
      this.token = authData.data.token;
      this.accountId = authData.data.account.id;

      this.logger.info(
        { accountId: this.accountId, displayName: authData.data.account.display_name },
        "Authenticated successfully",
      );

      // 2. Build WebSocket URL
      const wsProtocol = serverUrl.startsWith("https://") ? "wss://" : "ws://";
      const hostAndPath = serverUrl.replace(/^https?:\/\//, "");
      const wsPath = this.config.meshimize.ws_path;
      const wsUrl = `${wsProtocol}${hostAndPath}${wsPath}?token=${this.token}&vsn=2.0.0`;

      this.logger.debug(
        { wsUrl: wsUrl.replace(/token=[^&]+/, "token=[REDACTED]") },
        "Connecting WebSocket",
      );

      // 3. Create and connect WebSocket
      await this.connectWebSocket(wsUrl);
    } catch (err) {
      this.setState("disconnected");
      throw err;
    }
  }

  private connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.socket = this.webSocketFactory(wsUrl);
      } catch (err) {
        this.setState("disconnected");
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.socket.onopen = () => {
        this.logger.info("WebSocket connected");
        this.reconnectAttempt = 0;
        this.setState("connected");
        this.startHeartbeat();
        resolve();
      };

      this.socket.onclose = () => {
        this.logger.info("WebSocket closed");
        if (this.state === "connecting") {
          this.setState("disconnected");
          reject(new Error("WebSocket closed before connection established"));
          return;
        }
        this.handleDisconnect();
      };

      this.socket.onerror = (err) => {
        this.logger.error({ err }, "WebSocket error");
        // If we haven't connected yet, reject the promise
        if (this.state === "connecting") {
          this.setState("disconnected");
          reject(new Error("WebSocket connection failed"));
          return;
        }
        // Otherwise, the onclose handler will deal with reconnection
      };

      this.socket.onmessage = (event: { data: string }) => {
        this.handleMessage(event.data);
      };
    });
  }

  /** Join a group channel and listen for questions */
  async joinGroup(group: GroupConfig): Promise<void> {
    if (!this.socket || this.state !== "connected") {
      throw new Error("Cannot join group: not connected");
    }

    const topic = `group:${group.group_id}`;
    const joinRef = this.makeRef();
    const ref = this.makeRef();

    const channelState: ChannelState = {
      topic,
      joinRef,
      joined: false,
      groupConfig: group,
    };
    this.channels.set(topic, channelState);

    this.logger.info({ topic, groupName: group.group_name }, "Joining channel");

    // Send join message: [join_ref, ref, topic, "phx_join", payload]
    const joinPayload = { api_key: this.config.meshimize.api_key };
    this.sendMessage([joinRef, ref, topic, "phx_join", joinPayload]);

    // Wait for join reply — clean up channel entry on failure
    try {
      await new Promise<void>((resolve, reject) => {
        this.pendingJoins.set(ref, { resolve, reject });

        // Timeout after 10 seconds
        const timeout = setTimeout(() => {
          this.pendingJoins.delete(ref);
          reject(new Error(`Join timeout for channel ${topic}`));
        }, 10000);

        // Store the timeout so we can clear it on success/error
        const original = this.pendingJoins.get(ref);
        if (original) {
          this.pendingJoins.set(ref, {
            resolve: () => {
              clearTimeout(timeout);
              original.resolve();
            },
            reject: (err: Error) => {
              clearTimeout(timeout);
              original.reject(err);
            },
          });
        }
      });

      channelState.joined = true;
      this.logger.info({ topic, groupName: group.group_name }, "Channel joined successfully");

      // Role verification (non-blocking)
      this.verifyRole(group).catch((err) => {
        this.logger.warn(
          { err, groupId: group.group_id },
          "Role verification failed (non-blocking)",
        );
      });
    } catch (err) {
      // Remove stale channel entry on join failure
      this.channels.delete(topic);
      throw err;
    }
  }

  /** Leave all channels and disconnect */
  async disconnect(): Promise<void> {
    this.explicitDisconnect = true;

    // Clear timers
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Leave all channels
    for (const [topic, channel] of this.channels) {
      if (channel.joined && this.socket && this.socket.readyState === 1) {
        const ref = this.makeRef();
        this.sendMessage([channel.joinRef, ref, topic, "phx_leave", {}]);
      }
    }
    this.channels.clear();
    this.pendingJoins.clear();

    // Close socket
    if (this.socket) {
      // Prevent reconnect callbacks from firing
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.onopen = null;
      this.socket.close(1000, "client disconnect");
      this.socket = null;
    }

    this.token = null;
    this.accountId = null;
    this.setState("disconnected");
    this.logger.info("Disconnected from Meshimize server");
  }

  /** Get current connection state */
  getState(): ConnectionState {
    return this.state;
  }

  // ─── Private Methods ───

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.logger.debug({ from: this.state, to: newState }, "Connection state change");
      this.state = newState;
      this.onConnectionStateChange(newState);
    }
  }

  private makeRef(): string {
    this.refCounter += 1;
    return this.refCounter.toString();
  }

  private sendMessage(msg: PhoenixMessage): void {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  private handleMessage(raw: string): void {
    let msg: PhoenixMessage;
    try {
      msg = JSON.parse(raw) as PhoenixMessage;
    } catch {
      this.logger.warn({ raw }, "Failed to parse WebSocket message");
      return;
    }

    const [joinRef, ref, topic, event, payload] = msg;

    this.logger.debug({ joinRef, ref, topic, event }, "Received message");

    // Handle heartbeat replies
    if (topic === "phoenix" && event === "phx_reply") {
      if (ref === this.pendingHeartbeatRef) {
        this.pendingHeartbeatRef = null;
      }
      return;
    }

    // Handle join replies
    if (event === "phx_reply" && ref) {
      const pending = this.pendingJoins.get(ref);
      if (pending) {
        const replyPayload = payload as PhoenixReplyPayload;
        if (replyPayload.status === "ok") {
          pending.resolve();
        } else {
          pending.reject(
            new Error(`Channel join failed: ${JSON.stringify(replyPayload.response)}`),
          );
        }
        this.pendingJoins.delete(ref);
        return;
      }
    }

    // Handle channel error
    if (event === "phx_error") {
      const channel = this.channels.get(topic);
      if (channel) {
        this.logger.error({ topic, joinRef }, "Channel error");
      }
      // Also check if there's a pending join for this
      if (ref) {
        const pending = this.pendingJoins.get(ref);
        if (pending) {
          pending.reject(new Error(`Channel error on ${topic}`));
          this.pendingJoins.delete(ref);
        }
      }
      return;
    }

    // Handle channel close
    if (event === "phx_close") {
      this.channels.delete(topic);
      this.logger.info({ topic }, "Channel closed by server");
      return;
    }

    // Handle application events (e.g., "new_message")
    if (event === "new_message") {
      const channel = this.channels.get(topic);
      if (channel && channel.joined) {
        const question = payload as IncomingQuestion;
        this.logger.info(
          {
            messageId: question.message_id,
            groupId: question.group_id,
            senderName: question.sender_name,
          },
          "Received question",
        );
        this.onQuestion(question, channel.groupConfig);
      }
    }
  }

  private startHeartbeat(): void {
    // Send heartbeat every 30 seconds
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== 1) return;

      if (this.pendingHeartbeatRef !== null) {
        // Missed heartbeat — connection is likely dead
        this.logger.warn("Heartbeat timeout — closing connection");
        this.pendingHeartbeatRef = null;
        if (this.socket) {
          this.socket.close(1000, "heartbeat timeout");
        }
        return;
      }

      this.pendingHeartbeatRef = this.makeRef();
      this.sendMessage([null, this.pendingHeartbeatRef, "phoenix", "heartbeat", {}]);
    }, 30000);
  }

  private handleDisconnect(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.pendingHeartbeatRef = null;

    // Mark all channels as not joined
    for (const channel of this.channels.values()) {
      channel.joined = false;
    }

    // Reject all pending joins so callers don't hang
    for (const pending of this.pendingJoins.values()) {
      pending.reject(new Error("Socket disconnected"));
    }
    this.pendingJoins.clear();

    this.setState("disconnected");

    // Don't reconnect if explicit disconnect was called
    if (this.explicitDisconnect) {
      return;
    }

    // Schedule reconnection with exponential backoff
    const delay = getReconnectDelay(this.reconnectAttempt, this.config.agent.reconnect_delays_ms);
    this.reconnectAttempt += 1;

    this.logger.info({ attempt: this.reconnectAttempt, delayMs: delay }, "Scheduling reconnection");

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect()
        .then(() => this.rejoinChannels())
        .catch((err) => {
          this.logger.error({ err }, "Reconnection failed");
          // handleDisconnect will be called again by the socket close handler
          // or we need to schedule another attempt
          this.handleDisconnect();
        });
    }, delay);
  }

  /** Re-join all previously joined channels after reconnect */
  private async rejoinChannels(): Promise<void> {
    for (const [topic, channel] of this.channels) {
      try {
        const joinRef = this.makeRef();
        const ref = this.makeRef();
        channel.joinRef = joinRef;

        this.logger.info(
          { topic, groupName: channel.groupConfig.group_name },
          "Re-joining channel after reconnect",
        );

        const joinPayload = { api_key: this.config.meshimize.api_key };
        this.sendMessage([joinRef, ref, topic, "phx_join", joinPayload]);

        // Wait for join reply with timeout
        await new Promise<void>((resolve, reject) => {
          this.pendingJoins.set(ref, { resolve, reject });

          const timeout = setTimeout(() => {
            this.pendingJoins.delete(ref);
            reject(new Error(`Rejoin timeout for channel ${topic}`));
          }, 10000);

          const original = this.pendingJoins.get(ref);
          if (original) {
            this.pendingJoins.set(ref, {
              resolve: () => {
                clearTimeout(timeout);
                original.resolve();
              },
              reject: (err: Error) => {
                clearTimeout(timeout);
                original.reject(err);
              },
            });
          }
        });

        channel.joined = true;
        this.logger.info(
          { topic, groupName: channel.groupConfig.group_name },
          "Channel re-joined successfully",
        );
      } catch (err) {
        this.logger.error(
          { err, topic, groupName: channel.groupConfig.group_name },
          "Failed to re-join channel after reconnect",
        );
      }
    }
  }

  /** Verify the agent has responder/owner role in the group (non-blocking) */
  private async verifyRole(group: GroupConfig): Promise<void> {
    if (!this.token || !this.accountId) return;

    const serverUrl = this.config.meshimize.server_url.replace(/\/$/, "");
    const membersUrl = `${serverUrl}/api/v1/groups/${group.group_id}/members`;

    const response = await this.fetchFn(membersUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      this.logger.warn(
        { groupId: group.group_id, status: response.status },
        "Failed to fetch group members for role verification",
      );
      return;
    }

    const membersData = (await response.json()) as MembersResponse;
    const agentMember = membersData.data.find((m) => m.account_id === this.accountId);

    if (!agentMember) {
      this.logger.warn(
        { groupId: group.group_id, accountId: this.accountId },
        "Agent not found in group members list",
      );
      return;
    }

    if (agentMember.role !== "responder" && agentMember.role !== "owner") {
      this.logger.warn(
        { groupId: group.group_id, role: agentMember.role, accountId: this.accountId },
        "Agent does not have responder or owner role in group",
      );
    } else {
      this.logger.debug(
        { groupId: group.group_id, role: agentMember.role },
        "Role verification passed",
      );
    }
  }
}
