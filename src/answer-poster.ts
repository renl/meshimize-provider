// ─── Answer Poster — REST API POST with retry + dead-letter logging ───

import type pino from "pino";
import type { OutgoingAnswer } from "./types.js";

export interface AnswerPosterOptions {
  serverUrl: string;
  token: string;
  logger: pino.Logger;
  fetchFn?: typeof globalThis.fetch;
}

export interface PostResult {
  success: boolean;
  httpStatus: number;
  deadLettered: boolean;
}

export class AnswerPoster {
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(private readonly options: AnswerPosterOptions) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async post(groupId: string, answer: OutgoingAnswer): Promise<PostResult> {
    const url = `${this.options.serverUrl.replace(/\/$/, "")}/api/v1/groups/${groupId}/messages`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.options.token}`,
    };
    const body = JSON.stringify({
      message: {
        content: answer.content,
        message_type: answer.message_type,
        parent_message_id: answer.parent_message_id,
      },
    });

    let failureCount = 0;
    let rateLimitRetries = 0;
    const MAX_RATE_LIMIT_RETRIES = 3;
    let lastStatus = 0;
    let lastErrorText = "";

    while (true) {
      try {
        const response = await this.fetchFn(url, {
          method: "POST",
          headers,
          body,
        });

        lastStatus = response.status;

        if (response.ok) {
          return { success: true, httpStatus: response.status, deadLettered: false };
        }

        // HTTP 429 — rate limited; read Retry-After, wait, retry (NOT counted as failure)
        if (response.status === 429) {
          rateLimitRetries++;
          if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
            // Exceeded max 429 retries — dead letter
            this.options.logger.error(
              {
                deadLetter: true,
                questionId: answer.parent_message_id,
                groupId,
                messageType: answer.message_type,
                answerContentLength: answer.content.length,
                httpStatus: 429,
                errorMessage: "Rate limit retries exhausted",
              },
              "DEAD_LETTER: Rate limit retries exhausted",
            );
            return { success: false, httpStatus: 429, deadLettered: true };
          }

          const retryAfterRaw = response.headers.get("Retry-After");
          const parsedMs = retryAfterRaw ? parseInt(retryAfterRaw, 10) * 1000 : NaN;
          const MAX_RETRY_WAIT_MS = 30_000;
          const waitMs =
            Number.isFinite(parsedMs) && parsedMs > 0
              ? Math.min(parsedMs, MAX_RETRY_WAIT_MS)
              : 2000;
          this.options.logger.warn(
            { groupId, status: 429, retryAfterMs: waitMs, rateLimitRetry: rateLimitRetries },
            "Rate limited — waiting before retry",
          );
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
          continue; // Retry without incrementing failure count
        }

        // Other error
        lastErrorText = await response.text();
        failureCount++;

        if (failureCount >= 2) {
          // Dead letter
          this.options.logger.error(
            {
              deadLetter: true,
              questionId: answer.parent_message_id,
              groupId,
              messageType: answer.message_type,
              answerContentLength: answer.content.length,
              httpStatus: lastStatus,
              errorMessage: lastErrorText,
            },
            "DEAD_LETTER: Answer post failed after retry",
          );
          return { success: false, httpStatus: lastStatus, deadLettered: true };
        }

        // Wait 2s before retry
        this.options.logger.warn(
          { groupId, status: lastStatus, attempt: failureCount },
          "Answer post failed — retrying in 2s",
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      } catch (err) {
        lastErrorText = err instanceof Error ? err.message : String(err);
        lastStatus = 0;
        failureCount++;

        if (failureCount >= 2) {
          this.options.logger.error(
            {
              deadLetter: true,
              questionId: answer.parent_message_id,
              groupId,
              messageType: answer.message_type,
              answerContentLength: answer.content.length,
              httpStatus: lastStatus,
              errorMessage: lastErrorText,
            },
            "DEAD_LETTER: Answer post failed after retry",
          );
          return { success: false, httpStatus: lastStatus, deadLettered: true };
        }

        this.options.logger.warn(
          { err, groupId, attempt: failureCount },
          "Answer post failed — retrying in 2s",
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
}
