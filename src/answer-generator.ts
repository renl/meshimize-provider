// ─── Answer Generator — LLM prompt assembly + invocation ───

import type pino from "pino";
import type { Config, GroupConfig } from "./config.js";
import type { RetrievedChunk } from "./types.js";

export interface AnswerGeneratorOptions {
  config: Config;
  logger: pino.Logger;
}

export interface GeneratedAnswer {
  content: string;
  answerType: "llm_answer" | "no_context" | "error_fallback" | "missed_content";
  promptTokens: number;
  completionTokens: number;
  llmMs: number;
}

// ─── Templates (Architecture §3.4.3) ───

const NO_CONTEXT_TEMPLATE =
  "I don't have enough information to answer that question based on the available documentation.";

const ERROR_FALLBACK_TEMPLATE =
  "I'm sorry, I encountered an error while processing your question. Please try again later.";

const MISSED_CONTENT_TEMPLATE =
  "I'm sorry, I was offline when your question was posted and the message content is no longer available. " +
  "Could you please re-post your question?";

// ─── Token Budget (Architecture §3.4.2) ───

const MAX_CONTEXT_TOKENS = 4000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Default System Prompt ───

const DEFAULT_SYSTEM_PROMPT_TEMPLATE =
  'You are an expert assistant for {group_name}. Answer questions using ONLY the provided context. If the context does not contain enough information to answer the question, say "I don\'t have enough information to answer that question based on the available documentation."\n\nAlways cite your sources by referencing the document name.';

export class AnswerGenerator {
  private llmClient: {
    invoke: (messages: unknown[]) => Promise<{
      content: unknown;
      usage_metadata?: { input_tokens?: number; output_tokens?: number };
    }>;
  } | null = null;
  private llmProvider: string | null = null;

  constructor(private readonly options: AnswerGeneratorOptions) {}

  async generate(
    question: string,
    chunks: RetrievedChunk[],
    groupConfig: GroupConfig,
  ): Promise<GeneratedAnswer> {
    // 1. If no chunks → return NO_CONTEXT_TEMPLATE (no LLM call)
    if (chunks.length === 0) {
      return {
        content: NO_CONTEXT_TEMPLATE,
        answerType: "no_context",
        promptTokens: 0,
        completionTokens: 0,
        llmMs: 0,
      };
    }

    // 2. Build context string from chunks, respecting token budget
    const contextParts: string[] = [];
    let totalTokens = 0;

    for (const chunk of chunks) {
      const part = `[Source: ${chunk.source}]\n${chunk.content}`;
      const partTokens = estimateTokens(part);

      if (totalTokens + partTokens > MAX_CONTEXT_TOKENS && contextParts.length > 0) {
        break;
      }

      // Truncate oversized first chunk to fit within token budget
      if (partTokens > MAX_CONTEXT_TOKENS && contextParts.length === 0) {
        const maxChars = MAX_CONTEXT_TOKENS * 4; // Reverse the token estimate heuristic
        const truncatedPart = part.slice(0, maxChars);
        contextParts.push(truncatedPart);
        totalTokens += MAX_CONTEXT_TOKENS;
        break;
      }

      contextParts.push(part);
      totalTokens += partTokens;
    }

    const context = contextParts.join("\n---\n");

    // 3. Build system prompt
    const systemPrompt = groupConfig.system_prompt
      ? groupConfig.system_prompt
      : DEFAULT_SYSTEM_PROMPT_TEMPLATE.replace("{group_name}", groupConfig.group_name);

    // 4. Build user message
    const userMessage = `Context:\n---\n${context}\n---\n\nQuestion: ${question}`;

    // 5. Call LLM with retry
    const { provider, model, api_key, max_tokens, temperature } = this.options.config.llm;

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const startMs = Date.now();

        // Lazy-initialize LLM client (reuse across generate() calls)
        if (!this.llmClient || this.llmProvider !== provider) {
          if (provider === "openai") {
            const { ChatOpenAI } = await import("@langchain/openai");
            this.llmClient = new ChatOpenAI({
              openAIApiKey: api_key,
              modelName: model,
              maxTokens: max_tokens,
              temperature,
            }) as unknown as typeof this.llmClient;
          } else {
            const { ChatAnthropic } = await import("@langchain/anthropic");
            this.llmClient = new ChatAnthropic({
              anthropicApiKey: api_key,
              modelName: model,
              maxTokens: max_tokens,
              temperature,
            }) as unknown as typeof this.llmClient;
          }
          this.llmProvider = provider;
        }

        const result = await this.llmClient!.invoke([
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ]);
        const tokenUsage = result.usage_metadata;
        const llmResponse = {
          content: typeof result.content === "string" ? result.content : String(result.content),
          promptTokens: tokenUsage?.input_tokens ?? estimateTokens(systemPrompt + userMessage),
          completionTokens:
            tokenUsage?.output_tokens ??
            estimateTokens(
              typeof result.content === "string" ? result.content : String(result.content),
            ),
        };

        const llmMs = Date.now() - startMs;

        this.options.logger.info(
          {
            provider,
            model,
            promptTokens: llmResponse.promptTokens,
            completionTokens: llmResponse.completionTokens,
            llmMs,
          },
          "LLM response generated",
        );

        return {
          content: llmResponse.content,
          answerType: "llm_answer",
          promptTokens: llmResponse.promptTokens,
          completionTokens: llmResponse.completionTokens,
          llmMs,
        };
      } catch (err) {
        lastError = err;
        this.options.logger.warn(
          { err, attempt: attempt + 1, provider, model },
          "LLM invocation failed",
        );
      }
    }

    // Both attempts failed — return error fallback
    this.options.logger.error(
      { err: lastError, provider, model },
      "LLM invocation failed after retry — returning error fallback",
    );

    return {
      content: ERROR_FALLBACK_TEMPLATE,
      answerType: "error_fallback",
      promptTokens: 0,
      completionTokens: 0,
      llmMs: 0,
    };
  }
}

// Export templates for testing
export {
  NO_CONTEXT_TEMPLATE,
  ERROR_FALLBACK_TEMPLATE,
  MISSED_CONTENT_TEMPLATE,
  MAX_CONTEXT_TOKENS,
  estimateTokens,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
};
