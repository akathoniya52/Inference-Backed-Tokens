import { FIRST_BYTE_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from '@ibt/shared';

import type { AppContext } from '../app.js';

/** `baseUrl + /chat/completions` (L238), tolerating a trailing slash on the base. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/** First-byte and total upstream timeouts, injectable through `createApp` (P4-T4). */
export function upstreamTimeouts(ctx: AppContext): { firstByteMs: number; totalMs: number } {
  return {
    firstByteMs: ctx.timeouts.firstByteMs ?? FIRST_BYTE_TIMEOUT_MS,
    totalMs: ctx.timeouts.totalMs ?? TOTAL_TIMEOUT_MS,
  };
}

/** undici header/body timeouts and the overall `AbortSignal.timeout`. */
export function isUpstreamTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'TimeoutError' ||
    err.name === 'AbortError' ||
    ('code' in err &&
      (err.code === 'UND_ERR_HEADERS_TIMEOUT' || err.code === 'UND_ERR_BODY_TIMEOUT'))
  );
}
