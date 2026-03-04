import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { RagPipeline, type IngestResult } from "../rag-pipeline.js";

/**
 * --ingest-only: Load config, ingest all groups sequentially, exit.
 * No WebSocket connection. No question listening.
 * Exit code: 0 if all groups ingested, 1 if any failed.
 */
export async function runIngestCommand(configPath: string): Promise<void> {
  // 1. Load config
  const config = loadConfig(configPath);

  // 2. Create logger
  const logger = createLogger(config.agent.log_level);
  logger.info({ configPath }, "Starting ingestion (--ingest-only)");

  // 3. Create RagPipeline
  const pipeline = new RagPipeline({
    persistDirectory: config.vector_store.persist_directory,
    collectionPrefix: config.vector_store.collection_prefix,
    distanceMetric: config.vector_store.distance_metric,
    staleDays: config.vector_store.stale_days,
    embeddingApiKey: config.embedding.api_key,
    embeddingModel: config.embedding.model,
    embeddingDimensions: config.embedding.dimensions,
    batchSize: config.embedding.batch_size,
    requestsPerMinute: config.embedding.requests_per_minute,
    logger,
  });

  // 4. Ingest all groups sequentially
  const results: IngestResult[] = [];
  let hasFailure = false;

  for (const group of config.groups) {
    try {
      logger.info({ groupId: group.group_id, groupName: group.group_name }, "Ingesting group");
      const result = await pipeline.ingest(group);
      results.push(result);
      logger.info(
        {
          groupId: result.groupId,
          groupName: result.groupName,
          docCount: result.docCount,
          chunkCount: result.chunkCount,
          durationMs: result.durationMs,
        },
        "Group ingestion complete",
      );
    } catch (err) {
      hasFailure = true;
      logger.error(
        { err, groupId: group.group_id, groupName: group.group_name },
        "Group ingestion failed",
      );
    }
  }

  // 5. Log summary
  const totalDocs = results.reduce((sum, r) => sum + r.docCount, 0);
  const totalChunks = results.reduce((sum, r) => sum + r.chunkCount, 0);
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);
  const failedCount = config.groups.length - results.length;

  if (hasFailure) {
    logger.warn(
      { totalDocs, totalChunks, totalDuration, groupCount: config.groups.length, failedCount },
      `Ingestion partially complete: ${totalDocs} files → ${totalChunks} chunks in ${totalDuration}ms (${results.length}/${config.groups.length} groups succeeded, ${failedCount} failed)`,
    );
  } else {
    logger.info(
      { totalDocs, totalChunks, totalDuration, groupCount: config.groups.length },
      `Ingestion complete: ${totalDocs} files → ${totalChunks} chunks in ${totalDuration}ms`,
    );
  }

  // 6. Exit
  process.exit(hasFailure ? 1 : 0);
}
