import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { ChromaClient, type IEmbeddingFunction } from "chromadb";
import type pino from "pino";
import type { GroupConfig } from "./config.js";
import type { RetrievedChunk } from "./types.js";

// ─── Interfaces ───

export interface RagPipelineOptions {
  persistDirectory: string;
  collectionPrefix: string;
  distanceMetric: "cosine" | "l2" | "ip";
  staleDays: number;
  embeddingApiKey: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingBaseUrl?: string;
  batchSize: number;
  requestsPerMinute: number;
  logger: pino.Logger;
}

export interface IngestResult {
  groupId: string;
  groupName: string;
  docCount: number;
  chunkCount: number;
  durationMs: number;
}

export interface ValidationResult {
  groupId: string;
  groupName: string;
  collectionExists: boolean;
  chunkCount: number;
  sampleQuery: string;
  sampleResults: number;
  isValid: boolean;
}

/** A loaded document with content and source path */
export interface LoadedDocument {
  content: string;
  source: string;
}

// ─── Constants ───

const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "_build"]);
const ERB_TAG_REGEX = /<%[=#-]?.*?-?%>/gs;
const CHROMADB_ADD_BATCH_SIZE = 500;

// ─── Helpers ───

/**
 * Check if a file should be included based on its extension.
 * Includes: *.md, *.html.md, *.html.markerb
 */
function isIncludedFile(filename: string): boolean {
  if (filename.endsWith(".html.markerb")) return true;
  if (filename.endsWith(".html.md")) return true;
  if (filename.endsWith(".md")) return true;
  return false;
}

/**
 * Strip ERB tags from content (for .html.markerb files).
 */
export function stripErbTags(content: string): string {
  return content.replace(ERB_TAG_REGEX, "");
}

/**
 * Recursively walk a directory, collecting files that match our criteria.
 */
function walkDirectory(dir: string, basePath: string): LoadedDocument[] {
  const docs: LoadedDocument[] = [];

  if (!existsSync(dir)) return docs;

  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      docs.push(...walkDirectory(fullPath, basePath));
    } else if (stat.isFile() && isIncludedFile(entry)) {
      let content = readFileSync(fullPath, "utf-8");
      const relPath = relative(basePath, fullPath);

      // Strip ERB tags from .html.markerb files
      if (entry.endsWith(".html.markerb")) {
        content = stripErbTags(content);
      }

      docs.push({ content, source: relPath });
    }
  }

  return docs;
}

/**
 * Create an embedding function that wraps our batch embedding logic
 * for use with ChromaDB.
 */
function createEmbeddingFunction(
  embedDocsFn: (texts: string[]) => Promise<number[][]>,
  embedQueryFn: (text: string) => Promise<number[]>,
): IEmbeddingFunction {
  return {
    generate: async (texts: string[]): Promise<number[][]> => {
      if (texts.length === 1) {
        const result = await embedQueryFn(texts[0]);
        return [result];
      }
      return embedDocsFn(texts);
    },
  };
}

/**
 * Sleep for the specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── RagPipeline ───

export class RagPipeline {
  private client: ChromaClient;

  constructor(private readonly options: RagPipelineOptions) {
    // Validate persistDirectory is an HTTP(S) URL (ChromaDB JS client requires a server URL)
    try {
      const url = new URL(options.persistDirectory);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("not HTTP(S)");
      }
    } catch {
      throw new Error(
        `persistDirectory must be a valid HTTP(S) URL (e.g., http://localhost:8000), got: "${options.persistDirectory}"`,
      );
    }
    this.client = new ChromaClient({
      path: options.persistDirectory,
    });
  }

  /**
   * Get the collection name for a group.
   */
  private getCollectionName(group: GroupConfig): string {
    return `${this.options.collectionPrefix}_${group.slug}`;
  }

  /**
   * Load documents from a group's docs_path.
   */
  loadDocuments(group: GroupConfig): LoadedDocument[] {
    return walkDirectory(group.docs_path, group.docs_path);
  }

  /**
   * Create a text splitter configured for a group.
   */
  private createSplitter(group: GroupConfig): RecursiveCharacterTextSplitter {
    return new RecursiveCharacterTextSplitter({
      chunkSize: group.chunk_size,
      chunkOverlap: group.chunk_overlap,
      separators: ["\n## ", "\n### ", "\n#### ", "\n\n", "\n", " ", ""],
    });
  }

  /**
   * Create the OpenAI embeddings instance.
   * Uses dynamic import to allow mocking in tests.
   */
  private async createEmbeddingsInstance(): Promise<{
    embedDocuments: (texts: string[]) => Promise<number[][]>;
    embedQuery: (text: string) => Promise<number[]>;
  }> {
    const { OpenAIEmbeddings } = await import("@langchain/openai");
    return new OpenAIEmbeddings({
      openAIApiKey: this.options.embeddingApiKey,
      modelName: this.options.embeddingModel,
      dimensions: this.options.embeddingDimensions,
      ...(this.options.embeddingBaseUrl
        ? { configuration: { baseURL: this.options.embeddingBaseUrl } }
        : {}),
    });
  }

  /**
   * Embed texts in batches with rate limiting.
   */
  private async embedInBatches(
    texts: string[],
    embedDocsFn: (texts: string[]) => Promise<number[][]>,
  ): Promise<number[][]> {
    const allEmbeddings: number[][] = [];
    const batchSize = this.options.batchSize;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const startTime = Date.now();

      const batchEmbeddings = await embedDocsFn(batch);
      allEmbeddings.push(...batchEmbeddings);

      // Rate limiting between batches (only if there are more batches)
      if (i + batchSize < texts.length) {
        const elapsed = Date.now() - startTime;
        const minInterval = 60_000 / this.options.requestsPerMinute;
        const sleepTime = Math.max(0, minInterval - elapsed);
        if (sleepTime > 0) {
          await sleep(sleepTime);
        }
      }
    }

    return allEmbeddings;
  }

  /**
   * Ingest documents for a group: load files → chunk → embed → store in ChromaDB.
   */
  async ingest(group: GroupConfig): Promise<IngestResult> {
    const startTime = Date.now();
    const collectionName = this.getCollectionName(group);
    this.options.logger.info(
      { groupId: group.group_id, collection: collectionName },
      "Starting ingestion",
    );

    // Load documents
    const docs = this.loadDocuments(group);
    this.options.logger.info({ docCount: docs.length }, "Documents loaded");

    // Delete existing collection if present, then create fresh
    try {
      await this.client.deleteCollection({ name: collectionName });
    } catch (error: unknown) {
      // ChromaDB may throw ChromaNotFoundError which may not pass instanceof Error, so duck-type by name/message
      const errObj = error as { name?: string; message?: string };
      const isNotFound =
        errObj.name === "ChromaNotFoundError" ||
        (typeof errObj.message === "string" &&
          (errObj.message.includes("does not exist") || errObj.message.includes("not found")));
      if (!isNotFound) {
        this.options.logger.warn(
          { err: error, collectionName },
          "Unexpected error deleting collection",
        );
        throw error;
      }
    }

    if (docs.length === 0) {
      return {
        groupId: group.group_id,
        groupName: group.group_name,
        docCount: 0,
        chunkCount: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // Chunk documents
    const splitter = this.createSplitter(group);
    const allChunks: { text: string; source: string }[] = [];

    for (const doc of docs) {
      const chunks = await splitter.splitText(doc.content);
      for (const chunk of chunks) {
        allChunks.push({ text: chunk, source: doc.source });
      }
    }

    this.options.logger.info({ chunkCount: allChunks.length }, "Documents chunked");

    if (allChunks.length === 0) {
      return {
        groupId: group.group_id,
        groupName: group.group_name,
        docCount: docs.length,
        chunkCount: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // Create embeddings
    const embeddingsInstance = await this.createEmbeddingsInstance();

    const texts = allChunks.map((c) => c.text);
    const embeddings = await this.embedInBatches(
      texts,
      embeddingsInstance.embedDocuments.bind(embeddingsInstance),
    );

    // Store in ChromaDB
    const embeddingFunction = createEmbeddingFunction(
      embeddingsInstance.embedDocuments.bind(embeddingsInstance),
      embeddingsInstance.embedQuery.bind(embeddingsInstance),
    );

    const collection = await this.client.getOrCreateCollection({
      name: collectionName,
      metadata: {
        ingested_at: new Date().toISOString(),
        group_id: group.group_id,
        "hnsw:space": this.options.distanceMetric,
      },
      embeddingFunction,
    });

    // Add chunks in batches to ChromaDB
    const ids = allChunks.map((_, idx) => `chunk_${idx}`);
    const metadatas = allChunks.map((c) => ({ source: c.source }));
    const documents = allChunks.map((c) => c.text);

    for (let i = 0; i < ids.length; i += CHROMADB_ADD_BATCH_SIZE) {
      const end = Math.min(i + CHROMADB_ADD_BATCH_SIZE, ids.length);
      await collection.add({
        ids: ids.slice(i, end),
        embeddings: embeddings.slice(i, end),
        metadatas: metadatas.slice(i, end),
        documents: documents.slice(i, end),
      });
      this.options.logger.debug(
        { batch: Math.floor(i / CHROMADB_ADD_BATCH_SIZE) + 1, chunks: end - i },
        "Added batch to ChromaDB",
      );
    }

    const durationMs = Date.now() - startTime;
    this.options.logger.info(
      { groupId: group.group_id, docCount: docs.length, chunkCount: allChunks.length, durationMs },
      "Ingestion complete",
    );

    return {
      groupId: group.group_id,
      groupName: group.group_name,
      docCount: docs.length,
      chunkCount: allChunks.length,
      durationMs,
    };
  }

  /**
   * Check if corpus exists and is fresh enough (< staleDays old).
   * Returns true if re-ingestion is needed.
   */
  async needsIngestion(group: GroupConfig): Promise<boolean> {
    const collectionName = this.getCollectionName(group);

    try {
      const collections = await this.client.listCollections();
      if (!collections.includes(collectionName)) {
        return true;
      }

      const embeddingsInstance = await this.createEmbeddingsInstance();
      const embeddingFunction = createEmbeddingFunction(
        embeddingsInstance.embedDocuments.bind(embeddingsInstance),
        embeddingsInstance.embedQuery.bind(embeddingsInstance),
      );

      const collection = await this.client.getCollection({
        name: collectionName,
        embeddingFunction,
      });

      const count = await collection.count();
      if (count === 0) {
        return true;
      }

      // Check staleness via collection metadata
      if (collection.metadata?.ingested_at) {
        const ingestedAt = new Date(collection.metadata.ingested_at as string);
        if (isNaN(ingestedAt.getTime())) {
          return true;
        }
        const staleDays = this.options.staleDays;
        const now = new Date();
        const diffDays = (now.getTime() - ingestedAt.getTime()) / (1000 * 60 * 60 * 24);
        if (diffDays >= staleDays) {
          return true;
        }
      } else {
        // No ingested_at metadata — needs ingestion
        return true;
      }

      // Validate group_id matches (missing group_id also triggers re-ingestion)
      if (!collection.metadata?.group_id || collection.metadata.group_id !== group.group_id) {
        return true;
      }

      return false;
    } catch {
      // Any error means we need ingestion
      return true;
    }
  }

  /**
   * Retrieve top-K relevant chunks for a query.
   */
  async retrieve(group: GroupConfig, query: string): Promise<RetrievedChunk[]> {
    const collectionName = this.getCollectionName(group);

    const embeddingsInstance = await this.createEmbeddingsInstance();
    const embeddingFunction = createEmbeddingFunction(
      embeddingsInstance.embedDocuments.bind(embeddingsInstance),
      embeddingsInstance.embedQuery.bind(embeddingsInstance),
    );

    const collection = await this.client.getCollection({
      name: collectionName,
      embeddingFunction,
    });

    const results = await collection.query({
      queryTexts: query,
      nResults: group.top_k,
    });

    const chunks: RetrievedChunk[] = [];

    if (results.ids && results.ids[0]) {
      const ids = results.ids[0];
      const documents = results.documents?.[0] ?? [];
      const metadatas = results.metadatas?.[0] ?? [];
      const distances = results.distances?.[0] ?? [];

      for (let i = 0; i < ids.length; i++) {
        chunks.push({
          content: documents[i] ?? "",
          source: (metadatas[i]?.source as string) ?? "unknown",
          score: distances[i] != null ? (distances[i] as number) : Number.POSITIVE_INFINITY,
        });
      }
    }

    return chunks;
  }

  /**
   * Validate that a group's corpus exists and has data.
   */
  async validate(group: GroupConfig): Promise<ValidationResult> {
    const collectionName = this.getCollectionName(group);
    const sampleQuery = "How do I deploy?";

    try {
      const collections = await this.client.listCollections();
      const collectionExists = collections.includes(collectionName);

      if (!collectionExists) {
        return {
          groupId: group.group_id,
          groupName: group.group_name,
          collectionExists: false,
          chunkCount: 0,
          sampleQuery,
          sampleResults: 0,
          isValid: false,
        };
      }

      const embeddingsInstance = await this.createEmbeddingsInstance();
      const embeddingFunction = createEmbeddingFunction(
        embeddingsInstance.embedDocuments.bind(embeddingsInstance),
        embeddingsInstance.embedQuery.bind(embeddingsInstance),
      );

      const collection = await this.client.getCollection({
        name: collectionName,
        embeddingFunction,
      });

      const chunkCount = await collection.count();

      // Run sample query
      let sampleResults = 0;
      if (chunkCount > 0) {
        const queryResults = await collection.query({
          queryTexts: sampleQuery,
          nResults: Math.min(group.top_k, chunkCount),
        });
        sampleResults = queryResults.ids?.[0]?.length ?? 0;
      }

      const isValid = chunkCount > 0 && sampleResults > 0;

      return {
        groupId: group.group_id,
        groupName: group.group_name,
        collectionExists,
        chunkCount,
        sampleQuery,
        sampleResults,
        isValid,
      };
    } catch (err) {
      this.options.logger.error({ err, groupId: group.group_id }, "Validation failed");
      return {
        groupId: group.group_id,
        groupName: group.group_name,
        collectionExists: false,
        chunkCount: 0,
        sampleQuery,
        sampleResults: 0,
        isValid: false,
      };
    }
  }
}
