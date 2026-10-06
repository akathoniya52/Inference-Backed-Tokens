import { once } from 'node:events';

import {
  Users,
  capture,
  markCaptureDue,
  release,
  type RequestRecord,
  type RequestStatus,
} from '@ibt/db';
import { AppError, type ChatCompletionResponse } from '@ibt/shared';
import type { Response } from 'express';
import { request, type Dispatcher } from 'undici';

import type { AppContext } from '../../app.js';
import { chatCompletionsUrl, isUpstreamTimeout, upstreamTimeouts } from '../../lib/upstream.js';
import {
  BilledCallError,
  billedCost,
  billingHeaders,
  openHold,
  releaseAbandoned,
  upstreamBody,
  upstreamHeaders,
  type CompletionInput,
  type OpenHold,
  type UsageCount,
} from './completions.js';
import { SseCompletionParser } from './sse.js';
import { count, countPrompt } from './tokenCount.js';

/**
 * How a streamed call ended, for the idempotency record (GW-05): `completed`
 * can be replayed; `billed` was charged (or its capture is pending) but cut
 * short, so it must never run again under the same key; `unbilled` released
 * its hold and the key may be retried.
 */
export type StreamOutcome =
  | {
      kind: 'completed';
      completion: ChatCompletionResponse;
      /** Final billing headers; the streamed response carried the hold estimate. */
      headers: Record<string, string>;
    }
  | { kind: 'billed'; headers: Record<string, string> }
  | { kind: 'unbilled' };

type StopReason = 'client' | 'timeout' | 'upstream';

/**
 * GW-12: capture attempts after a delivered stream before the cost is left due
 * on the hold; the waits double from `CAPTURE_RETRY_MS`, about 3 s in total.
 */
export const CAPTURE_ATTEMPTS = 5;
const CAPTURE_RETRY_MS = 200;

async function estimateBalance(userId: string, estimate: bigint): Promise<bigint> {
  const user = await Users.findById(userId).select({ balanceMicroUsdc: 1 }).lean();
  return (user?.balanceMicroUsdc ?? 0n) - estimate;
}

function usageOf(parser: SseCompletionParser, input: CompletionInput): UsageCount {
  if (parser.usage) {
    return {
      promptTokens: parser.usage.prompt_tokens,
      completionTokens: parser.usage.completion_tokens,
      usageEstimated: false,
    };
  }
  return {
    promptTokens: countPrompt(input.body),
    completionTokens: count(parser.completionText()),
    usageEstimated: true,
  };
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/** Best effort: when even this write fails, hold expiry releases the hold as before. */
async function recordCaptureDue(
  ctx: AppContext,
  requestId: string,
  held: OpenHold,
  billed: bigint,
  record: RequestRecord,
): Promise<boolean> {
  try {
    return await markCaptureDue(held.holdId, billed, record);
  } catch (err) {
    ctx.logger.error({ requestId, errName: errName(err) }, 'could not record a due capture');
    return false;
  }
}

/**
 * GW-12: the client already has the output, so a failed capture is retried
 * with backoff and, if it still fails, the cost is recorded on the open hold,
 * which hold expiry then captures instead of releasing it as free, with an alert.
 */
async function captureDelivered(
  ctx: AppContext,
  requestId: string,
  held: OpenHold,
  billed: bigint,
  record: RequestRecord,
): Promise<{ balanceMicro: bigint } | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await capture(held.holdId, billed, record);
    } catch (err) {
      if (attempt >= CAPTURE_ATTEMPTS) {
        const holdId = held.holdId.toHexString();
        const due = await recordCaptureDue(ctx, requestId, held, billed, record);
        ctx.logger.error(
          { requestId, holdId, captureDue: due, errName: errName(err) },
          'capture failed after the stream was delivered; hold left open for hold expiry',
        );
        ctx.alerter
          .alert('error', 'streamed call delivered but not captured', {
            requestId,
            holdId,
            costMicro: billed.toString(),
            captureDue: due,
          })
          .catch((alertErr: unknown) => {
            ctx.logger.error({ errName: errName(alertErr) }, 'alert failed');
          });
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_RETRY_MS * 2 ** (attempt - 1)));
    }
  }
}

function failureStatus(reason: StopReason | null): RequestStatus {
  return reason === 'client' ? 'client_abort' : reason === 'timeout' ? 'timeout' : 'upstream_error';
}

function isEventStream(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'text/event-stream';
}

/**
 * Streamed gateway call (L238, L415). The upstream's bytes go to the client
 * unchanged, with back-pressure, while a parser watches for usage and
 * `[DONE]`. Errors before the response headers are thrown as usual; once the
 * headers are out, a failure ends the stream and resolves its outcome. A stream
 * that ends early is still billed for what the client received (A1); only a
 * stream that delivered nothing releases the hold.
 */
export async function streamChat(
  ctx: AppContext,
  input: CompletionInput,
  res: Response,
): Promise<StreamOutcome> {
  const held = await openHold(ctx, input);
  try {
    return await forwardStream(ctx, input, held, res);
  } catch (err) {
    const billed = await releaseAbandoned(ctx, input.requestId, held);
    // Before the headers the error handler still answers with the error status.
    if (res.headersSent) endResponse(res);
    throw billed ? new BilledCallError(err) : err;
  }
}

async function forwardStream(
  ctx: AppContext,
  input: CompletionInput,
  held: OpenHold,
  res: Response,
): Promise<StreamOutcome> {
  const { requestId, key, model, body } = input;
  const { firstByteMs, totalMs } = upstreamTimeouts(ctx);

  const upstreamAbort = new AbortController();
  let stopReason: StopReason | null = null;
  const stop = (reason: StopReason): void => {
    stopReason ??= reason;
    upstreamAbort.abort();
  };
  // A getter, because TS narrows `stopReason` to `null` across the awaits.
  const currentReason = (): StopReason | null => stopReason;
  // `res` closes before `end` only when the client went away; abort the
  // upstream at once so the provider stops generating for nobody.
  const onClose = (): void => {
    if (!res.writableEnded) stop('client');
  };
  res.on('close', onClose);
  // GW-03: a client that left during the hold or discount lookup never emits
  // `close` again, and a write to it would wait for a `drain` that never comes.
  if (res.destroyed || res.req.socket.destroyed) stop('client');
  const firstByteTimer = setTimeout(() => {
    stop('timeout');
  }, firstByteMs);
  const totalTimer = setTimeout(() => {
    stop('timeout');
  }, totalMs);

  const started = performance.now();
  let upstreamStatus: number | null = null;
  const parser = new SseCompletionParser();

  const record = (status: RequestStatus, usage?: UsageCount): RequestRecord => ({
    requestId,
    apiKeyId: key.apiKeyId,
    modelId: model._id,
    latencyMs: Math.round(performance.now() - started),
    streamed: true,
    upstreamStatus,
    discountBps: held.discountBps,
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    status,
    ...(usage ?? { promptTokens: 0, completionTokens: 0 }),
  });

  try {
    let upstream: Dispatcher.ResponseData;
    try {
      upstream = await request(chatCompletionsUrl(model.upstream.baseUrl), {
        method: 'POST',
        headers: upstreamHeaders(ctx, model),
        body: upstreamBody(model, body, true, input.maxTokens),
        headersTimeout: firstByteMs,
        bodyTimeout: totalMs,
        signal: upstreamAbort.signal,
        dispatcher: ctx.upstreamAgent,
      });
    } catch (err) {
      return await failBeforeHeaders(ctx, input, held, record, currentReason(), err);
    } finally {
      clearTimeout(firstByteTimer);
    }
    upstreamStatus = upstream.statusCode;
    // A 2xx that is not an event stream (an error JSON, say) is never forwarded.
    if (
      upstream.statusCode < 200 ||
      upstream.statusCode >= 300 ||
      !isEventStream(headerOf(upstream.headers['content-type']))
    ) {
      await upstream.body.dump();
      await release(held.holdId, record('upstream_error'));
      throw new AppError('upstream_error');
    }

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...billingHeaders(
        held.estimate,
        await estimateBalance(key.userId, held.estimate),
        held.discountBps,
      ),
    });
    res.flushHeaders();

    try {
      for await (const chunk of upstream.body) {
        const bytes = chunk as Buffer;
        parser.push(bytes);
        if (res.destroyed || res.writableEnded) {
          stop('client');
          break;
        }
        if (!res.write(bytes)) {
          // A destroyed response returns false without ever emitting `drain`.
          if (res.destroyed) {
            stop('client');
            break;
          }
          await once(res, 'drain', { signal: upstreamAbort.signal });
        }
        // GW-04 caps and GW-12 `event: error` frames end the stream as an upstream error.
        if (parser.failure) {
          stop('upstream');
          break;
        }
      }
      if (currentReason() === null) parser.end();
    } catch (err) {
      if (stopReason === null && !isUpstreamTimeout(err)) {
        ctx.logger.warn({ requestId, errName: errName(err) }, 'upstream stream failed');
      }
    }

    if (parser.failure) {
      ctx.logger.warn({ requestId, failure: parser.failure }, 'upstream stream rejected');
    }
    const reason = currentReason() ?? (parser.failure ? 'upstream' : null);
    const finished = reason === null && parser.done;
    // API-12: a stream that failed after its 200 still counts toward the 5xx alert.
    if (!finished && reason !== 'client') ctx.alerts.markFailed(res);
    if (!finished && !parser.hasOutput()) {
      await release(held.holdId, record(failureStatus(reason)));
      endResponse(res);
      return { kind: 'unbilled' };
    }

    // Billed even when the client left or the stream was cut: the client has
    // what was forwarded. `billedCost` still caps the bill at the hold.
    const usage = usageOf(parser, input);
    const billed = billedCost(ctx, requestId, held, usage);
    const status = finished ? 'success' : failureStatus(reason);
    const captured = await captureDelivered(ctx, requestId, held, billed, record(status, usage));
    endResponse(res);
    const headers = captured ? billingHeaders(billed, captured.balanceMicro, held.discountBps) : {};
    if (!finished) return { kind: 'billed', headers };
    return {
      kind: 'completed',
      completion: parser.assemble({
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.promptTokens + usage.completionTokens,
      }),
      headers,
    };
  } finally {
    clearTimeout(firstByteTimer);
    clearTimeout(totalTimer);
    res.off('close', onClose);
  }
}

function headerOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function endResponse(res: Response): void {
  if (!res.writableEnded && !res.destroyed) res.end();
}

/** Releases the hold; a client that already left gets no response at all. */
async function failBeforeHeaders(
  ctx: AppContext,
  input: CompletionInput,
  held: OpenHold,
  record: (status: RequestStatus) => RequestRecord,
  reason: StopReason | null,
  err: unknown,
): Promise<StreamOutcome> {
  if (reason === 'client') {
    await release(held.holdId, record('client_abort'));
    return { kind: 'unbilled' };
  }
  if (reason === 'timeout' || isUpstreamTimeout(err)) {
    await release(held.holdId, record('timeout'));
    throw new AppError('upstream_timeout');
  }
  // Never log the error object: undici errors can carry the request headers.
  ctx.logger.warn(
    {
      modelId: input.model._id.toHexString(),
      errName: errName(err),
    },
    'upstream request failed',
  );
  await release(held.holdId, record('upstream_error'));
  throw new AppError('upstream_error');
}
