import pino from "pino";
import type { LevelWithSilent, DestinationStream } from "pino";

export function createLogger(level: LevelWithSilent, destination?: DestinationStream): pino.Logger {
  const opts: pino.LoggerOptions = {
    level,
    redact: {
      paths: [
        "config.meshimize.api_key",
        "config.meshimize.apiKey",
        "config.llm.api_key",
        "config.llm.apiKey",
        "config.embedding.api_key",
        "config.embedding.apiKey",
        "apiKey",
        "api_key",
        "token",
        "authorization",
      ],
      censor: "[REDACTED]",
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(opts, destination) : pino(opts);
}
