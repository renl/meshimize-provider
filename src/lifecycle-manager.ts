// ─── Lifecycle Manager — Startup Orchestration (Partial) ───

import type pino from "pino";
import type { Config } from "./config.js";
import type { ConnectionState } from "./types.js";
import { ConnectionManager } from "./connection-manager.js";
import type { ConnectionManagerOptions } from "./connection-manager.js";

export interface LifecycleManagerOptions {
  config: Config;
  logger: pino.Logger;
  version: string;
}

export class LifecycleManager {
  private connectionManager: ConnectionManager | null = null;
  private connectionState: ConnectionState = "disconnected";
  private _started: boolean = false;

  private readonly config: Config;
  private readonly logger: pino.Logger;
  private readonly version: string;

  constructor(options: LifecycleManagerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.version = options.version;
  }

  /** Start: connect to server, join all groups */
  async start(): Promise<void> {
    this.logger.info({ version: this.version }, "LifecycleManager starting");

    // 1. Create ConnectionManager with config, logger, callbacks
    const cmOptions: ConnectionManagerOptions = {
      config: this.config,
      logger: this.logger,
      onQuestion: (question, groupConfig) => {
        // Placeholder: will be wired to RAG pipeline in future slices
        this.logger.info(
          {
            messageId: question.message_id,
            groupId: question.group_id,
            groupName: groupConfig.group_name,
          },
          "Question received (handler not yet implemented)",
        );
      },
      onConnectionStateChange: (state) => {
        this.connectionState = state;
        this.logger.info({ connectionState: state }, "Connection state changed");
      },
    };

    this.connectionManager = new ConnectionManager(cmOptions);

    // 2. Connect to server (REST auth + WebSocket)
    await this.connectionManager.connect();

    // 3. Join all groups from config
    let joinedCount = 0;
    let failedCount = 0;
    for (const group of this.config.groups) {
      try {
        await this.connectionManager.joinGroup(group);
        joinedCount++;
        this.logger.info({ groupId: group.group_id, groupName: group.group_name }, "Joined group");
      } catch (err) {
        failedCount++;
        this.logger.error(
          { err, groupId: group.group_id, groupName: group.group_name },
          "Failed to join group",
        );
      }
    }

    this._started = true;

    // 4. Log ready state
    if (failedCount > 0) {
      this.logger.warn(
        {
          version: this.version,
          joinedCount,
          failedCount,
          totalGroups: this.config.groups.length,
        },
        "LifecycleManager ready with failures",
      );
    } else {
      this.logger.info(
        { version: this.version, joinedCount, totalGroups: this.config.groups.length },
        "LifecycleManager ready",
      );
    }
  }

  /** Shutdown: disconnect, drain */
  async shutdown(): Promise<void> {
    this.logger.info("LifecycleManager shutting down");
    this._started = false;

    if (this.connectionManager) {
      await this.connectionManager.disconnect();
      this.connectionManager = null;
    }

    this.connectionState = "disconnected";
    this.logger.info("LifecycleManager shutdown complete");
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  isStarted(): boolean {
    return this._started;
  }
}
