import { describe, expect, it } from 'vitest';

import {
  AppError,
  ERROR_CATALOG,
  ErrorEnvelopeSchema,
  isAppError,
  type ErrorCode,
} from '../src/index.js';

describe('ERROR_CATALOG', () => {
  it('matches the spec gateway table (L417–426)', () => {
    const spec: Record<string, number> = {
      invalid_request: 400,
      invalid_api_key: 401,
      insufficient_credits: 402,
      model_not_found: 404,
      rate_limited: 429,
      upstream_error: 502,
      model_paused: 503,
      upstream_timeout: 504,
    };
    for (const [code, status] of Object.entries(spec)) {
      expect(ERROR_CATALOG[code as ErrorCode].httpStatus, code).toBe(status);
    }
  });

  it('matches the platform examples (L436–446) and plan additions', () => {
    const extra: Record<string, number> = {
      deposit_already_credited: 409,
      deposit_invalid: 422,
      pool_mismatch: 422,
      daily_cap_exceeded: 429,
      deposit_pending: 202,
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      settlement_not_retryable: 409,
      idempotency_in_progress: 409,
      chain_send_failed: 502,
      internal: 500,
    };
    for (const [code, status] of Object.entries(extra)) {
      expect(ERROR_CATALOG[code as ErrorCode].httpStatus, code).toBe(status);
    }
  });

  it('marks only transient outcomes retryable', () => {
    const retryable = Object.entries(ERROR_CATALOG)
      .filter(([, entry]) => entry.retryable)
      .map(([code]) => code)
      .sort();
    expect(retryable).toEqual([
      'chain_send_failed',
      'deposit_pending',
      'idempotency_in_progress',
      'rate_limited',
      'upstream_error',
      'upstream_timeout',
    ]);
  });

  it('is frozen and every entry has a non-empty default message', () => {
    expect(Object.isFrozen(ERROR_CATALOG)).toBe(true);
    for (const entry of Object.values(ERROR_CATALOG)) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(entry.message.length).toBeGreaterThan(0);
    }
  });
});

describe('AppError', () => {
  it('takes status and default message from the catalog', () => {
    const err = new AppError('model_not_found');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AppError');
    expect(err.code).toBe('model_not_found');
    expect(err.httpStatus).toBe(404);
    expect(err.publicMessage).toBe(ERROR_CATALOG.model_not_found.message);
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual({});
    expect(isAppError(err)).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });

  it('serializes to the spec envelope with details inside error', () => {
    const err = new AppError('insufficient_credits', {
      details: { shortfallUsdc: '0.120000' },
      requestId: 'req_1',
    });
    const body: unknown = JSON.parse(JSON.stringify(err));
    expect(body).toEqual({
      error: {
        code: 'insufficient_credits',
        message: ERROR_CATALOG.insufficient_credits.message,
        requestId: 'req_1',
        shortfallUsdc: '0.120000',
      },
    });
    expect(ErrorEnvelopeSchema.safeParse(body).success).toBe(true);
  });

  it('uses a custom public message and keeps the internal cause out of the envelope', () => {
    const cause = new Error('RPC 429 from https://secret-rpc?api-key=abc');
    const err = new AppError('deposit_invalid', {
      message: 'memo does not match depositRef',
      cause,
    });
    expect(err.cause).toBe(cause);
    expect(err.toEnvelope('req_2')).toEqual({
      error: {
        code: 'deposit_invalid',
        message: 'memo does not match depositRef',
        requestId: 'req_2',
      },
    });
    expect(JSON.stringify(err)).not.toContain('secret-rpc');
    expect(JSON.stringify(err)).not.toContain('stack');
  });

  it('details cannot override code, message or requestId', () => {
    const err = new AppError('forbidden', {
      details: { code: 'internal', message: 'x', requestId: 'spoof' },
      requestId: 'real',
    });
    expect(err.toEnvelope().error).toMatchObject({
      code: 'forbidden',
      message: ERROR_CATALOG.forbidden.message,
      requestId: 'real',
    });
  });

  it('serializes only the catalog message for 5xx codes and keeps the detail for logs (API-15)', () => {
    const err = new AppError('internal', { message: 'hold 6650aa is expired' });
    expect(err.message).toBe('hold 6650aa is expired');
    expect(err.publicMessage).toBe(ERROR_CATALOG.internal.message);
    expect(err.toEnvelope('req_3').error.message).toBe(ERROR_CATALOG.internal.message);
    expect(JSON.stringify(err)).not.toContain('6650aa');
    const upstream = new AppError('upstream_error', { message: 'upstream said 500 at 10.0.0.7' });
    expect(upstream.toEnvelope().error.message).toBe(ERROR_CATALOG.upstream_error.message);
  });

  it('toEnvelope without a requestId omits it', () => {
    expect(new AppError('internal').toEnvelope()).toEqual({
      error: { code: 'internal', message: ERROR_CATALOG.internal.message },
    });
  });
});
