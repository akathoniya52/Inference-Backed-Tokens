import type { ErrorEnvelope } from './schemas/common.js';

export interface ErrorCatalogEntry {
  readonly httpStatus: number;
  readonly message: string;
  /** The client may retry the same request later and expect a different outcome. */
  readonly retryable: boolean;
}

function entry(httpStatus: number, message: string, retryable = false): ErrorCatalogEntry {
  return Object.freeze({ httpStatus, message, retryable });
}

// Gateway table L417–426, platform examples L436–446, plus plan additions
// (G21, P3-T7, P4-T7, P2-T3, P5-T4).
export const ERROR_CATALOG = Object.freeze({
  invalid_request: entry(400, 'request body or query is invalid'),
  invalid_api_key: entry(401, 'API key is missing, unknown or revoked'),
  unauthorized: entry(401, 'authentication required'),
  insufficient_credits: entry(402, 'balance is below the hold estimate'),
  forbidden: entry(403, 'not allowed'),
  model_not_found: entry(404, 'model not found'),
  not_found: entry(404, 'not found'),
  deposit_already_credited: entry(409, 'deposit already credited'),
  settlement_not_retryable: entry(409, 'settlement is not in a retryable state'),
  idempotency_in_progress: entry(409, 'a request with this Idempotency-Key is in flight', true),
  deposit_invalid: entry(422, 'deposit transaction is invalid'),
  pool_mismatch: entry(422, 'on-chain pool does not match the model'),
  rate_limited: entry(429, 'too many requests', true),
  daily_cap_exceeded: entry(429, 'daily spend cap for this API key reached'),
  internal: entry(500, 'internal error'),
  upstream_error: entry(502, 'upstream returned an error or malformed body', true),
  chain_send_failed: entry(502, 'transaction could not be confirmed', true),
  model_paused: entry(503, 'model is paused'),
  upstream_timeout: entry(504, 'upstream timed out', true),
  deposit_pending: entry(202, 'deposit not finalized yet; retry shortly', true),
} satisfies Record<string, ErrorCatalogEntry>);

export type ErrorCode = keyof typeof ERROR_CATALOG;
export type ErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

export interface AppErrorOptions {
  /** Public message; defaults to the catalog message. Never put secrets here. */
  message?: string;
  /** Extra public fields placed inside `error`, e.g. `shortfallUsdc`. */
  details?: ErrorDetails;
  requestId?: string;
  /** Internal cause for logs; never serialized. */
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly publicMessage: string;
  readonly retryable: boolean;
  readonly details: ErrorDetails;
  requestId: string | undefined;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const catalog = ERROR_CATALOG[code];
    const publicMessage = options.message ?? catalog.message;
    super(publicMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = catalog.httpStatus;
    this.publicMessage = publicMessage;
    this.retryable = catalog.retryable;
    this.details = options.details ?? {};
    this.requestId = options.requestId;
  }

  toEnvelope(requestId: string | undefined = this.requestId): ErrorEnvelope {
    return {
      error: {
        ...this.details,
        code: this.code,
        message: this.publicMessage,
        ...(requestId === undefined ? {} : { requestId }),
      },
    };
  }

  toJSON(): ErrorEnvelope {
    return this.toEnvelope();
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
