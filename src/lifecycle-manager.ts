// ─── Lifecycle Manager — Full Startup Orchestration ───

import type pino from "pino";
import type { Config } from "./config.js";
import type { ConnectionState } from "./types.js";
import { ChromaClient } from "chromadb";
import { ConnectionManager } from "./connection-manager.js";
import type { ConnectionManagerOptions } from "./connection-manager.js";
import { RagPipeline } from "./rag-pipeline.js";
import { QuestionRouter } from "./question-router.js";
import { AnswerGenerator } from "./answer-generator.js";
import { AnswerPoster } from "./answer-poster.js";

export interface LifecycleManagerOptions {
  config: Config;
  logger: pino.Logger;
  version: string;
  chromaDbMaxRetries?: number;
  chromaDbInitialDelayMs?: number;
}

export class LifecycleManager {
  private connectionManager: ConnectionManager | null = null;
  private ragPipeline: RagPipeline | null = null;
  private questionRouter: QuestionRouter | null = null;
  private answerGenerator: AnswerGenerator | null = null;
  private answerPoster: AnswerPoster | null = null;
  private connectionState: ConnectionState = "disconnected";
  private _started: boolean = false;
  private healthSummaryTimer: ReturnType<typeof setInterval> | null = null;

  private readonly config: Config;
  private readonly logger: pino.Logger;
  private readonly version: string;
  private readonly chromaDbMaxRetries: number;
  private readonly chromaDbInitialDelayMs: number;

  constructor(options: LifecycleManagerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.version = options.version;
    const maxRetries = options.chromaDbMaxRetries ?? 10;
    const initialDelayMs = options.chromaDbInitialDelayMs ?? 1000;
    this.chromaDbMaxRetries = Math.max(1, maxRetries);
    this.chromaDbInitialDelayMs = Math.max(1, initialDelayMs);
  }

  /** Wait for ChromaDB to become reachable before proceeding with ingestion. */
  private async waitForChromaDb(maxRetries = 10, initialDelayMs = 1000): Promise<boolean> {
    const client = new ChromaClient({ path: this.config.vector_store.persist_directory });
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await client.heartbeat();
        this.logger.info({ attempt }, "ChromaDB is ready");
        return true;
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          const delayMs = initialDelayMs * attempt; // linear backoff: 1s, 2s, 3s, ...
          this.logger.info(
            {
              attempt,
              maxRetries,
              nextRetryMs: delayMs,
              error: error instanceof Error ? { message: error.message, name: error.name } : error,
            },
            "Waiting for ChromaDB...",
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    this.logger.error(
      {
        maxRetries,
        lastError:
          lastError instanceof Error
            ? { message: lastError.message, name: lastError.name }
            : lastError,
      },
      "ChromaDB failed to become ready after all retries",
    );
    return false;
  }

  /** Start: ingest if needed, connect to server, join all groups, wire pipeline */
  async start(): Promise<void> {
    this.logger.info({ version: this.version }, "LifecycleManager starting");

    // 0. Wait for ChromaDB to become reachable
    const chromaReady = await this.waitForChromaDb(
      this.chromaDbMaxRetries,
      this.chromaDbInitialDelayMs,
    );

    // Track groups that failed ingestion
    const ingestionFailedGroupIds = new Set<string>();

    // 1. Create RagPipeline
    this.ragPipeline = new RagPipeline({
      persistDirectory: this.config.vector_store.persist_directory,
      collectionPrefix: this.config.vector_store.collection_prefix,
      distanceMetric: this.config.vector_store.distance_metric,
      staleDays: this.config.vector_store.stale_days,
      embeddingApiKey: this.config.embedding.api_key,
      embeddingModel: this.config.embedding.model,
      embeddingDimensions: this.config.embedding.dimensions,
      embeddingBaseUrl: this.config.embedding.base_url,
      batchSize: this.config.embedding.batch_size,
      requestsPerMinute: this.config.embedding.requests_per_minute,
      logger: this.logger,
    });

    // 2. For each group: check needsIngestion() → ingest if needed
    if (chromaReady) {
      for (const group of this.config.groups) {
        try {
          const needs = await this.ragPipeline.needsIngestion(group);
          if (needs) {
            this.logger.info(
              { groupId: group.group_id, groupName: group.group_name },
              "Ingesting documents for group",
            );
            const result = await this.ragPipeline.ingest(group);
            this.logger.info(
              {
                groupId: group.group_id,
                docCount: result.docCount,
                chunkCount: result.chunkCount,
                durationMs: result.durationMs,
              },
              "Ingestion complete",
            );
          } else {
            this.logger.info(
              { groupId: group.group_id, groupName: group.group_name },
              "Corpus is fresh — skipping ingestion",
            );
          }
        } catch (err) {
          ingestionFailedGroupIds.add(group.group_id);
          this.logger.error(
            { err, groupId: group.group_id, groupName: group.group_name },
            "Ingestion failed for group",
          );
        }
      }
    } else {
      this.logger.warn("ChromaDB not ready — skipping ingestion for all groups");
      for (const group of this.config.groups) {
        ingestionFailedGroupIds.add(group.group_id);
      }
    }

    // 3. Create AnswerGenerator
    this.answerGenerator = new AnswerGenerator({
      config: this.config,
      logger: this.logger,
    });

    // 4. Create AnswerPoster
    // Auth: POST /groups/:id/messages uses the api_key_auth pipeline (APIKeyPlug),
    // which authenticates via Authorization: Bearer <api_key>. This is correct —
    // the server treats the Bearer token as an API key, not a session token.
    // See Architecture Contract §6.1 (APIKeyPlug) and §4.5 Router (api_key_auth scope).
    this.answerPoster = new AnswerPoster({
      serverUrl: this.config.meshimize.server_url,
      token: this.config.meshimize.api_key,
      logger: this.logger,
    });

    // 5. Create QuestionRouter with processQuestion callback
    const ragPipeline = this.ragPipeline;
    const answerGenerator = this.answerGenerator;
    const answerPoster = this.answerPoster;

    this.questionRouter = new QuestionRouter({
      maxQueueDepth: this.config.agent.queue_max_depth,
      logger: this.logger,
      processQuestion: async (question, groupConfig) => {
        const chunks = await ragPipeline.retrieve(groupConfig, question.content);
        const answer = await answerGenerator.generate(question.content, chunks, groupConfig);
        const postResult = await answerPoster.post(question.group_id, {
          content: answer.content,
          message_type: "answer",
          parent_message_id: question.message_id,
        });
        if (!postResult.success) {
          throw new Error(
            `Answer post failed for group_id=${question.group_id}, message_id=${question.message_id} (httpStatus=${postResult.httpStatus}, deadLettered=${postResult.deadLettered})`,
          );
        }
      },
    });

    // 6. Register all groups with router
    for (const group of this.config.groups) {
      this.questionRouter.registerGroup(group);
    }

    // Mark groups with failed ingestion as degraded
    for (const groupId of ingestionFailedGroupIds) {
      this.questionRouter.updateGroupStatus(groupId, "degraded");
      this.logger.warn({ groupId }, "Group marked as degraded due to ingestion failure");
    }

    // 7. Create ConnectionManager with onQuestion wired to router.enqueue
    const router = this.questionRouter;
    const cmOptions: ConnectionManagerOptions = {
      config: this.config,
      logger: this.logger,
      onQuestion: (question, _groupConfig) => {
        router.enqueue(question);
      },
      onConnectionStateChange: (state) => {
        this.connectionState = state;
        this.logger.info({ connectionState: state }, "Connection state changed");
      },
    };

    this.connectionManager = new ConnectionManager(cmOptions);

    // 8. Connect to server (REST auth + WebSocket)
    await this.connectionManager.connect();

    // 9. Join all groups from config
    let joinedCount = 0;
    let failedCount = 0;
    for (const group of this.config.groups) {
      try {
        await this.connectionManager.joinGroup(group);
        joinedCount++;
        // Only set "ready" if not already degraded from ingestion failure
        if (!ingestionFailedGroupIds.has(group.group_id)) {
          this.questionRouter.updateGroupStatus(group.group_id, "ready");
        }
        this.logger.info({ groupId: group.group_id, groupName: group.group_name }, "Joined group");
      } catch (err) {
        failedCount++;
        this.questionRouter.updateGroupStatus(group.group_id, "degraded");
        this.logger.error(
          { err, groupId: group.group_id, groupName: group.group_name },
          "Failed to join group",
        );
      }
    }

    this._started = true;

    // 10. Start health summary timer (clamp to minimum 10s to prevent tight loops)
    const rawIntervalS = this.config.agent.health_summary_interval_s;
    const clampedIntervalS = rawIntervalS > 0 ? Math.max(rawIntervalS, 10) : 60;
    if (rawIntervalS !== clampedIntervalS) {
      this.logger.warn(
        { configured: rawIntervalS, using: clampedIntervalS },
        "health_summary_interval_s clamped to safe minimum",
      );
    }
    const summaryIntervalMs = clampedIntervalS * 1000;
    this.healthSummaryTimer = setInterval(() => {
      const stats = this.questionRouter?.getStats() ?? [];
      const totalAnswered = stats.reduce((sum, s) => sum + s.answeredCount, 0);
      const totalQueued = stats.reduce((sum, s) => sum + s.queue.length, 0);
      this.logger.info(
        { totalAnswered, totalQueued, groups: stats.length, connectionState: this.connectionState },
        "Health summary",
      );
    }, summaryIntervalMs);

    // 11. Log ready state
    if (failedCount > 0) {
      this.logger.warn(
        {
          version: this.version,
          joinedCount,
          failedCount,
          totalGroups: this.config.groups.length,
        },
        "Agent ready with failures",
      );
    } else {
      this.logger.info(
        { version: this.version, joinedCount, totalGroups: this.config.groups.length },
        "Agent ready",
      );
    }
  }

  /** Shutdown: stop router, drain, disconnect */
  async shutdown(): Promise<void> {
    this.logger.info("LifecycleManager shutting down");
    this._started = false;

    // Clear health summary timer
    if (this.healthSummaryTimer !== null) {
      clearInterval(this.healthSummaryTimer);
      this.healthSummaryTimer = null;
    }

    // 1. Stop router (stop accepting new questions, clear queues)
    if (this.questionRouter) {
      this.questionRouter.stop();

      // 2. Drain in-flight work
      const drainResult = await this.questionRouter.drain(this.config.agent.shutdown_timeout_ms);
      this.logger.info(
        { completed: drainResult.completed, abandoned: drainResult.abandoned },
        "Drain complete",
      );
    }

    // 3. Disconnect ConnectionManager
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

  getQuestionRouter(): QuestionRouter | null {
    return this.questionRouter;
  }
}
