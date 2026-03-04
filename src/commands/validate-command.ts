import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { RagPipeline, type ValidationResult } from "../rag-pipeline.js";

/**
 * --validate: Load config, check each group's ChromaDB collection, exit.
 * Runs a sample query per group to verify retrieval works.
 * Exit code: 0 if all valid, 1 if any invalid.
 */
export async function runValidateCommand(configPath: string): Promise<void> {
  // 1. Load config
  const config = loadConfig(configPath);

  // 2. Create logger
  const logger = createLogger(config.agent.log_level);
  logger.info({ configPath }, "Starting validation (--validate)");

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

  // 4. Validate each group
  const results: ValidationResult[] = [];

  for (const group of config.groups) {
    try {
      logger.info({ groupId: group.group_id, groupName: group.group_name }, "Validating group");
      const result = await pipeline.validate(group);
      results.push(result);
      logger.info(
        {
          groupId: result.groupId,
          groupName: result.groupName,
          collectionExists: result.collectionExists,
          chunkCount: result.chunkCount,
          sampleResults: result.sampleResults,
          isValid: result.isValid,
        },
        `Group validation: ${result.isValid ? "VALID" : "INVALID"}`,
      );
    } catch (err) {
      logger.error(
        { err, groupId: group.group_id, groupName: group.group_name },
        "Group validation failed",
      );
      results.push({
        groupId: group.group_id,
        groupName: group.group_name,
        collectionExists: false,
        chunkCount: 0,
        sampleQuery: "How do I deploy?",
        sampleResults: 0,
        isValid: false,
      });
    }
  }

  // 5. Log summary
  const allValid = results.every((r) => r.isValid);

  logger.info(
    { groupCount: config.groups.length, allValid },
    `Validation complete: ${config.groups.length} groups, all valid: ${allValid}`,
  );

  // 6. Exit
  process.exit(allValid ? 0 : 1);
}
