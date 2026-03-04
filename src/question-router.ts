// ─── Question Router — Per-group FIFO queues with concurrency control ───

import type pino from "pino";
import type { GroupConfig } from "./config.js";
import type { IncomingQuestion, GroupState } from "./types.js";

export interface QuestionRouterOptions {
  maxQueueDepth: number;
  logger: pino.Logger;
  processQuestion: (question: IncomingQuestion, groupConfig: GroupConfig) => Promise<void>;
}

export class QuestionRouter {
  private groups: Map<string, GroupState> = new Map();
  private groupConfigs: Map<string, GroupConfig> = new Map();
  private stopped: boolean = false;

  constructor(private readonly options: QuestionRouterOptions) {}

  /** Register a group for question processing */
  registerGroup(group: GroupConfig): void {
    const state: GroupState = {
      groupId: group.group_id,
      groupName: group.group_name,
      slug: group.slug,
      channelTopic: `group:${group.group_id}`,
      status: "ready",
      queue: [],
      activeWorkers: 0,
      maxConcurrency: group.max_concurrency,
      answeredCount: 0,
      totalLatencyMs: 0,
    };
    this.groups.set(group.group_id, state);
    this.groupConfigs.set(group.group_id, group);
  }

  /**
   * Enqueue a question for processing.
   * If queue is full (>= maxQueueDepth), drop and log WARN.
   * If concurrency slots available, start processing immediately.
   */
  enqueue(question: IncomingQuestion): void {
    const group = this.groups.get(question.group_id);
    if (!group) {
      this.options.logger.warn(
        { groupId: question.group_id, messageId: question.message_id },
        "Question for unknown group",
      );
      return;
    }

    if (group.queue.length >= this.options.maxQueueDepth) {
      this.options.logger.warn(
        {
          groupId: question.group_id,
          messageId: question.message_id,
          queueLength: group.queue.length,
          maxQueueDepth: this.options.maxQueueDepth,
        },
        `Question dropped for group ${question.group_id} — queue full (${group.queue.length}/${this.options.maxQueueDepth})`,
      );
      return;
    }

    group.queue.push(question);
    // Fire-and-forget — do NOT await
    this.processNext(question.group_id);
  }

  /** Get stats for all groups (for health endpoint) */
  getStats(): GroupState[] {
    return Array.from(this.groups.values());
  }

  /** Drain: wait for in-flight work to complete (for shutdown) */
  async drain(timeoutMs: number): Promise<{ completed: number; abandoned: number }> {
    const startCounts = new Map<string, number>();
    for (const [id, group] of this.groups) {
      startCounts.set(id, group.answeredCount);
    }

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      let totalActive = 0;
      for (const group of this.groups.values()) {
        totalActive += group.activeWorkers;
      }
      if (totalActive === 0) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }

    let completed = 0;
    let abandoned = 0;
    for (const [id, group] of this.groups) {
      const startCount = startCounts.get(id) ?? 0;
      completed += group.answeredCount - startCount;
      abandoned += group.activeWorkers;
    }

    return { completed, abandoned };
  }

  /** Stop accepting new questions and clear queues */
  stop(): void {
    this.stopped = true;
    for (const group of this.groups.values()) {
      group.queue.length = 0;
    }
  }

  private processNext(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    if (this.stopped) return;
    if (group.activeWorkers >= group.maxConcurrency) return;
    if (group.queue.length === 0) return;

    const question = group.queue.shift()!;
    group.activeWorkers++;

    const startTime = Date.now();
    const groupConfig = this.groupConfigs.get(groupId);
    if (!groupConfig) {
      group.activeWorkers--;
      return;
    }

    this.options.logger.info(
      { messageId: question.message_id, groupId, queueDepth: group.queue.length },
      "Processing question",
    );

    this.options
      .processQuestion(question, groupConfig)
      .then(() => {
        const durationMs = Date.now() - startTime;
        group.answeredCount++;
        group.totalLatencyMs += durationMs;
        this.options.logger.info(
          { messageId: question.message_id, groupId, durationMs },
          "Question processed",
        );
      })
      .catch((err) => {
        this.options.logger.error(
          { err, messageId: question.message_id, groupId },
          "Question processing failed",
        );
      })
      .finally(() => {
        group.activeWorkers--;
        this.processNext(groupId); // Process next in queue
      });
  }
}
