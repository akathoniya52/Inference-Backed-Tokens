import { once } from 'node:events';

import { Users, capture, release, type RequestRecord, type RequestStatus } from '@ibt/db';
import { AppError, type ChatCompletionResponse } from '@ibt/shared';
import type { Response } from 'express';
import { request, type Dispatcher } from 'undici';

import type { AppContext } from '../../app.js';
import { chatCompletionsUrl, isUpstreamTimeout, upstreamTimeouts } from '../../lib/upstream.js';
import {
  billedCost,
  billingHeaders,
  openHold,
  upstreamBody,
  upstreamHeaders,
  type CompletionInput,
  type OpenHold,
  type UsageCount,
} from './completions.js';
import { SseCompletionParser } from './sse.js';
import { count, countMessages } from './tokenCount.js';

export interface StreamResult {
  completion: ChatCompletionResponse;
  /** Final billing headers; the streamed response carried the hold estimate. */
  headers: Record<string, string>;
}

type StopReason = 'client' | 'timeout';

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
    promptTokens: countMessages(input.body.messages),
    completionTokens: count(parser.completionText()),
    usageEstimated: true,
  };
}

/**
 * Streamed gateway call (L238, L415). The upstream's bytes go to the client
 * unchanged, with back-pressure, while a parser watches for usage and
 * `[DONE]`. Errors before the response headers are thrown as usual; once the
 * headers are out, a failure ends the stream, releases the hold and resolves
 * `null`.
 */
export async function streamChat(
  ctx: AppContext,
  input: CompletionInput,
  res: Response,
): Promise<StreamResult | null> {
  const { requestId, key, model, body } = input;
  const held = await openHold(ctx, input);
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
    status,
    ...(usage ?? { promptTokens: 0, completionTokens: 0 }),
  });

  try {
    let upstream: Dispatcher.ResponseData;
    try {
      upstream = await request(chatCompletionsUrl(model.upstream.baseUrl), {
        method: 'POST',
        headers: upstreamHeaders(ctx, model),
        body: upstreamBody(model, body, true),
        headersTimeout: firstByteMs,
        bodyTimeout: totalMs,
        signal: upstreamAbort.signal,
      });
    } catch (err) {
      return await failBeforeHeaders(ctx, input, held, record, currentReason(), err);
    } finally {
      clearTimeout(firstByteTimer);
    }
    upstreamStatus = upstream.statusCode;
    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      await upstream.body.dump();
      await release(held.holdId, record('upstream_error'));
      throw new AppError('upstream_error');
    }

    res.status(200);
    res.set({
      'Content-Type': headerOf(upstream.headers['content-type']) ?? 'text/event-stream',
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
        if (!res.write(bytes)) await once(res, 'drain', { signal: upstreamAbort.signal });
      }
      parser.end();
    } catch (err) {
      if (stopReason === null && !isUpstreamTimeout(err)) {
        ctx.logger.warn(
          { requestId, errName: err instanceof Error ? err.name : 'unknown' },
          'upstream stream failed',
        );
      }
    }

    const reason = currentReason();
    if (reason !== null || !parser.done) {
      const status: RequestStatus =
        reason === 'client' ? 'client_abort' : reason === 'timeout' ? 'timeout' : 'upstream_error';
      await release(held.holdId, record(status));
      endResponse(res);
      return null;
    }

    const usage = usageOf(parser, input);
    const billed = billedCost(ctx, requestId, held, usage);
    const { balanceMicro } = await capture(held.holdId, billed, record('success', usage));
    endResponse(res);
    return {
      completion: parser.assemble({
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.promptTokens + usage.completionTokens,
      }),
      headers: billingHeaders(billed, balanceMicro, held.discountBps),
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
): Promise<null> {
  if (reason === 'client') {
    await release(held.holdId, record('client_abort'));
    return null;
  }
  if (reason === 'timeout' || isUpstreamTimeout(err)) {
    await release(held.holdId, record('timeout'));
    throw new AppError('upstream_timeout');
  }
  // Never log the error object: undici errors can carry the request headers.
  ctx.logger.warn(
    {
      modelId: input.model._id.toHexString(),
      errName: err instanceof Error ? err.name : 'unknown',
    },
    'upstream request failed',
  );
  await release(held.holdId, record('upstream_error'));
  throw new AppError('upstream_error');
}
