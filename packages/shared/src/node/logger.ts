import {
  pino,
  stdSerializers,
  type DestinationStream,
  type LevelWithSilent,
  type Logger,
} from 'pino';

/**
 * Env names whose values are secrets or embed one (an RPC URL carries the Helius
 * key, a Mongo URI its password). pino paths cannot glob a key suffix, so each is listed.
 */
export const SECRET_ENV_NAMES: readonly string[] = Object.freeze([
  'MASTER_KEY',
  'JWT_SECRET',
  'ADMIN_TOKEN',
  'KEEPER_SECRET_KEY',
  'TREASURY_SECRET_KEY',
  'TELEGRAM_BOT_TOKEN',
  'RPC_URL',
  'RPC_URL_FALLBACK',
  'MONGODB_URI',
  'JUPITER_API_KEY',
  'DEVNET_FUNDER_SECRET_KEY',
]);

const SECRET_FIELDS: readonly string[] = ['apiKey', 'apiKeyEnc', ...SECRET_ENV_NAMES];
/** pino wildcards match one level each, so secret fields are listed down to this depth. */
const REDACT_DEPTH = 4;

const atDepths = (field: string, from: number): string[] =>
  Array.from({ length: REDACT_DEPTH - from + 1 }, (_, i) => '*.'.repeat(from + i) + field);

export const REDACT_PATHS: readonly string[] = Object.freeze([
  'req.headers.authorization',
  'req.headers.cookie',
  'err.headers',
  'err.headers.authorization',
  'headers.authorization',
  'err.config.headers.authorization',
  ...atDepths('headers.authorization', 1),
  ...SECRET_FIELDS.flatMap((field) => atDepths(field, 0)),
]);

const URL_PATTERN = /\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>`]+/gi;
const URL_PARTS = /^([a-z][a-z\d+.-]*:\/\/)([^/?#]*)([^?#]*)([?#].*)?$/i;
// Long mixed letter+digit path segments are key-shaped (Alchemy `/v2/<key>`, QuickNode `/<token>/`).
const KEY_LIKE_SEGMENT = /^(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{24,}$/i;
const SECRET_PARAM = /\b(api[-_]?key|access[-_]?token|token|secret|password)=[^&\s"'<>`]+/gi;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[\w.~+/=-]+/g;

function redactUrl(url: string): string {
  const parts = URL_PARTS.exec(url);
  if (!parts) return url;
  const [, scheme = '', authority = '', path = '', rest = ''] = parts;
  const at = authority.lastIndexOf('@');
  const host = at === -1 ? authority : `***@${authority.slice(at + 1)}`;
  const safePath = path
    .split('/')
    .map((segment) => (KEY_LIKE_SEGMENT.test(segment) ? '***' : segment))
    .join('/');
  const tail = rest.startsWith('?') ? '?***' : rest;
  return `${scheme}${host}${safePath}${tail}`;
}

/**
 * Scrubs credentials from free-form text such as an error message bound for an alert:
 * URL userinfo, query strings and key-shaped path segments, `api-key=`-style
 * parameters and `Bearer`/`Basic` credentials.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(URL_PATTERN, redactUrl)
    .replace(SECRET_PARAM, '$1=***')
    .replace(AUTH_SCHEME, '$1 ***');
}

function errSerializer(err: Error): ReturnType<typeof stdSerializers.err> {
  const serialized = stdSerializers.err(err);
  if (typeof serialized.message === 'string') {
    serialized.message = redactSecrets(serialized.message);
  }
  if (typeof serialized.stack === 'string') serialized.stack = redactSecrets(serialized.stack);
  return serialized;
}

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
  return pino(
    { level, name, redact: [...REDACT_PATHS, ...redact], serializers: { err: errSerializer } },
    destination,
  );
}
