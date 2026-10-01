import { pino, type DestinationStream, type LevelWithSilent, type Logger } from 'pino';

// pino paths cannot glob a key suffix, so each `*_SECRET_KEY` env name is listed.
export const REDACT_PATHS: readonly string[] = Object.freeze([
  'req.headers.authorization',
  'err.headers',
  '*.apiKey',
  '*.apiKeyEnc',
  'MASTER_KEY',
  'JWT_SECRET',
  'ADMIN_TOKEN',
  'KEEPER_SECRET_KEY',
  'TREASURY_SECRET_KEY',
  'err.headers.authorization',
  'headers.authorization',
  '*.headers.authorization',
  'err.config.headers.authorization',
]);

export interface CreateLoggerOptions {
  level: LevelWithSilent;
  name: string;
  /** Appended to `REDACT_PATHS`. */
  redact?: readonly string[];
}

export function createLogger(
  { level, name, redact = [] }: CreateLoggerOptions,
  destination?: DestinationStream,
): Logger {
  return pino({ level, name, redact: [...REDACT_PATHS, ...redact] }, destination);
}
