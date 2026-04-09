import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
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

export interface RetrieveResult {
  chunks: RetrievedChunk[];
  timingMs: {
    embeddingsInit: number;
    chromadbQuery: number;
  };
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
 * Recursively collect file entries as "relative_path:content_hash" strings.
 * Uses SHA-256 of file content (not mtime) so the fingerprint is stable across
 * deploys, volume remounts, and file copies that preserve content but change mtime.
 * Returns false when a non-ENOENT filesystem error (e.g., EACCES on a partially
 * mounted volume) prevents full traversal, so callers can treat the result as
 * unreliable and skip fingerprint-based decisions. Missing directories (ENOENT)
 * are treated as a successful no-op and return true.
 */
function collectFileEntries(dir: string, basePath: string, entries: string[]): boolean {
  if (!existsSync(dir)) return true;

  let dirEntries: string[];
  try {
    dirEntries = readdirSync(dir);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "ENOENT"
    ) {
      return true; // directory vanished between existsSync and readdirSync
    }
    return false; // unrecoverable — signal caller to skip fingerprint
  }

  for (const entry of dirEntries) {
    const fullPath = join(dir, entry);

    let stat;
    try {
      stat = statSync(fullPath);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "ENOENT"
      ) {
        continue; // file vanished between readdir and stat — skip it
      }
      return false; // unrecoverable — signal caller to skip fingerprint
    }

    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      if (!collectFileEntries(fullPath, basePath, entries)) return false;
    } else if (stat.isFile() && isIncludedFile(entry)) {
      const relPath = relative(basePath, fullPath);
      let fileHash: string;
      try {
        const content = readFileSync(fullPath);
        fileHash = createHash("sha256").update(content).digest("hex");
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code: string }).code === "ENOENT"
        ) {
          continue;
        }
        return false;
      }
      entries.push(`${relPath}:${fileHash}`);
    }
  }

  return true;
}

/**
 * Compute a deterministic fingerprint of source files for change detection.
 * Uses sorted (relative_path, content_hash) tuples hashed with SHA-256.
 * Content hashing (rather than mtime) ensures the fingerprint is stable across
 * deploys/copies that don't change file contents.
 * Returns null when the directory does not exist, contains no matching files,
 * or cannot be fully traversed due to a filesystem error.
 */
function computeSourceFingerprint(docsPath: string): string | null {
  if (!existsSync(docsPath)) return null;
  const entries: string[] = [];
  if (!collectFileEntries(docsPath, docsPath, entries)) return null;
  if (entries.length === 0) return null;
  entries.sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
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
  private embeddingsPromise: Promise<{
    embedDocuments: (texts: string[]) => Promise<number[][]>;
    embedQuery: (text: string) => Promise<number[]>;
  }> | null = null;

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
   * Get or lazily create the cached OpenAIEmbeddings instance.
   */
  private getOrCreateEmbeddingsInstance(): Promise<{
    embedDocuments: (texts: string[]) => Promise<number[][]>;
    embedQuery: (text: string) => Promise<number[]>;
  }> {
    if (!this.embeddingsPromise) {
      this.embeddingsPromise = this.createEmbeddingsInstance();
    }
    return this.embeddingsPromise;
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
      let isNotFound = false;
      if (typeof error === "object" && error !== null) {
        const errObj = error as { name?: string; message?: string };
        isNotFound =
          errObj.name === "ChromaNotFoundError" ||
          (typeof errObj.message === "string" &&
            (errObj.message.includes("does not exist") || errObj.message.includes("not found")));
      }
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

    // Compute fingerprint from raw file bytes via computeSourceFingerprint().
    // This re-walks the docs directory after loadDocuments() already did so. We
    // intentionally keep the same raw-byte hashing algorithm used in needsIngestion()
    // so the stored fingerprint matches what needsIngestion() computes on the next
    // restart — using post-processed content here would cause a mismatch for
    // .html.markerb files (ERB stripped) and trigger unnecessary re-ingestion.
    const sourceFingerprint = computeSourceFingerprint(group.docs_path);

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
    const embeddingsInstance = await this.getOrCreateEmbeddingsInstance();

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

    const collectionMetadata: Record<string, string> = {
      ingested_at: new Date().toISOString(),
      group_id: group.group_id,
      "hnsw:space": this.options.distanceMetric,
    };
    // Only store source_fingerprint when it was successfully computed.
    // ChromaDB metadata values must be scalar (string/number/boolean) — null
    // is invalid and would make the presence check in needsIngestion() ambiguous.
    if (sourceFingerprint !== null) {
      collectionMetadata.source_fingerprint = sourceFingerprint;
    }

    const collection = await this.client.getOrCreateCollection({
      name: collectionName,
      metadata: collectionMetadata,
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
   *
   * Decision order:
   * 1. Missing collection or empty → needs ingestion
   * 2. Missing/invalid ingested_at or group_id mismatch → needs ingestion,
   *    BUT only when source docs are actually available. If docs_path is
   *    missing/empty/unreadable, returning true would cause ingest() to
   *    delete the existing collection and leave the group with no data.
   * 3. Source fingerprint (if stored): matching fingerprint means corpus is current
   *    even if ingested_at is past the staleness window — fingerprint is authoritative
   *    because it proves the source files have not changed.
   * 4. Staleness fallback (no fingerprint stored): rely on ingested_at age.
   */
  async needsIngestion(group: GroupConfig): Promise<boolean> {
    const collectionName = this.getCollectionName(group);

    try {
      const collections = await this.client.listCollections();
      if (!collections.includes(collectionName)) {
        return true;
      }

      const embeddingsInstance = await this.getOrCreateEmbeddingsInstance();
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

      // Require valid ingested_at metadata.
      // Guard: if metadata is invalid but docs are unavailable, returning true
      // would cause ingest() to delete the existing collection (data loss).
      const hasInvalidMetadata =
        !collection.metadata?.ingested_at ||
        isNaN(new Date(collection.metadata.ingested_at as string).getTime()) ||
        !collection.metadata?.group_id ||
        collection.metadata.group_id !== group.group_id;

      if (hasInvalidMetadata) {
        const currentFingerprint = computeSourceFingerprint(group.docs_path);
        if (currentFingerprint === null) {
          this.options.logger.warn(
            { groupId: group.group_id, groupName: group.group_name },
            "Invalid collection metadata but docs_path missing or empty — skipping re-ingestion to protect existing data",
          );
          return false;
        }
        return true;
      }

      // Safe: hasInvalidMetadata is false here, which guarantees collection.metadata
      // and ingested_at are present and parseable (checked above).
      const metadata = collection.metadata!;
      const ingestedAt = new Date(metadata.ingested_at as string);

      // Fingerprint check — authoritative when available.
      // If the stored fingerprint matches the current source files, the corpus is
      // up-to-date regardless of how old ingested_at is. This prevents unnecessary
      // re-ingestion when docs haven't changed but the stale window has elapsed.
      // Guard: only compare when docs_path exists and contains files. A missing/
      // unmounted docs_path must NOT trigger re-ingestion (data-loss prevention).
      if (metadata.source_fingerprint) {
        const currentFingerprint = computeSourceFingerprint(group.docs_path);
        if (currentFingerprint === null) {
          // docs_path missing, empty, or unreadable — refuse to re-ingest to protect
          // existing data. Returning false prevents the staleness fallback from
          // triggering ingest(), which would delete the collection and leave the
          // group with no data.
          this.options.logger.warn(
            { groupId: group.group_id, groupName: group.group_name },
            "docs_path missing or empty — skipping re-ingestion to protect existing data",
          );
          return false;
        } else if (currentFingerprint === metadata.source_fingerprint) {
          // Fingerprint matches — corpus is current, no re-ingestion needed
          return false;
        } else {
          // Fingerprint differs — source files changed
          this.options.logger.info(
            { groupId: group.group_id, groupName: group.group_name },
            "Source files changed — re-ingestion needed",
          );
          return true;
        }
      }

      // Staleness fallback (no stored fingerprint in collection metadata).
      // Use ingested_at age as a best-effort freshness signal, but only when
      // source documents are actually available. Missing/empty/unreadable docs
      // must not trigger re-ingestion because ingest() deletes the collection.
      const staleDays = this.options.staleDays;
      const now = new Date();
      const diffDays = (now.getTime() - ingestedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays >= staleDays) {
        const currentFingerprint = computeSourceFingerprint(group.docs_path);
        if (currentFingerprint === null) {
          this.options.logger.warn(
            { groupId: group.group_id, groupName: group.group_name },
            "docs_path missing or empty — skipping staleness-based re-ingestion to protect existing data",
          );
          return false;
        }
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
  async retrieve(group: GroupConfig, query: string): Promise<RetrieveResult> {
    const collectionName = this.getCollectionName(group);

    const t0 = Date.now();
    const embeddingsInstance = await this.getOrCreateEmbeddingsInstance();
    const embeddingFunction = createEmbeddingFunction(
      embeddingsInstance.embedDocuments.bind(embeddingsInstance),
      embeddingsInstance.embedQuery.bind(embeddingsInstance),
    );

    const collection = await this.client.getCollection({
      name: collectionName,
      embeddingFunction,
    });
    const embeddingsInitMs = Date.now() - t0;

    const t1 = Date.now();
    const results = await collection.query({
      queryTexts: query,
      nResults: group.top_k,
    });
    const chromadbQueryMs = Date.now() - t1;

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

    return {
      chunks,
      timingMs: {
        embeddingsInit: embeddingsInitMs,
        chromadbQuery: chromadbQueryMs,
      },
    };
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

      const embeddingsInstance = await this.getOrCreateEmbeddingsInstance();
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
