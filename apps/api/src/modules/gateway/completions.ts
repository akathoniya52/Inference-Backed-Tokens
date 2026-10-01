import { Requests, capture, hold, release, type RequestRecord } from '@ibt/db';
import {
  AppError,
  ChatCompletionResponseSchema,
  computeCostMicro,
  estimateHoldMicro,
  microToUsdcString,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
} from '@ibt/shared';
import { decrypt } from '@ibt/shared/node';
import { request } from 'undici';

import type { AppContext } from '../../app.js';
import type { ApiKeyContext } from '../../context.js';
import { chatCompletionsUrl, isUpstreamTimeout, upstreamTimeouts } from '../../lib/upstream.js';
import type { ResolvedModel } from './router.js';
import { count, countMessages } from './tokenCount.js';

export interface CompletionInput {
  requestId: string;
  key: ApiKeyContext;
  model: ResolvedModel;
  body: ChatCompletionRequest;
  maxTokens: number;
}

export interface CompletionResult {
  rawBody: string;
  headers: Record<string, string>;
}

type UpstreamOutcome =
  | { ok: true; rawBody: string; parsed: ChatCompletionResponse; upstreamStatus: number }
  | { ok: false; status: 'upstream_error' | 'timeout'; upstreamStatus: number | null };

/** `X-Discount-Bps` is always 0: the holder discount (P4-T8) is cut from the MVP. */
const DISCOUNT_BPS = 0;

function upstreamBody(model: ResolvedModel, body: ChatCompletionRequest): string {
  // Non-streaming only (P4-T6 is cut), so `stream_options` is never forwarded (G28).
  const { stream_options: _streamOptions, ...rest } = body;
  return JSON.stringify({ ...rest, model: model.upstream.modelName, stream: false });
}

function parseCompletion(text: string): ChatCompletionResponse | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ChatCompletionResponseSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

async function callUpstream(
  ctx: AppContext,
  model: ResolvedModel,
  body: ChatCompletionRequest,
): Promise<UpstreamOutcome> {
  const { firstByteMs, totalMs } = upstreamTimeouts(ctx);
  // undici's `headersTimeout` ticks on a coarse (~0.5–1 s) timer wheel, so a
  // native timer enforces the first-byte deadline precisely as well.
  const firstByte = new AbortController();
  const firstByteTimer = setTimeout(() => {
    firstByte.abort();
  }, firstByteMs);
  const signal = AbortSignal.any([firstByte.signal, AbortSignal.timeout(totalMs)]);
  let upstreamStatus: number | null = null;
  try {
    const res = await request(chatCompletionsUrl(model.upstream.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${decrypt(model.upstream.apiKeyEnc, ctx.env.MASTER_KEY)}`,
      },
      body: upstreamBody(model, body),
      headersTimeout: firstByteMs,
      bodyTimeout: totalMs,
      signal,
    });
    clearTimeout(firstByteTimer);
    upstreamStatus = res.statusCode;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      await res.body.dump();
      return { ok: false, status: 'upstream_error', upstreamStatus };
    }
    const rawBody = await res.body.text();
    const parsed = parseCompletion(rawBody);
    if (!parsed) return { ok: false, status: 'upstream_error', upstreamStatus };
    return { ok: true, rawBody, parsed, upstreamStatus };
  } catch (err) {
    clearTimeout(firstByteTimer);
    if (signal.aborted || isUpstreamTimeout(err)) {
      return { ok: false, status: 'timeout', upstreamStatus };
    }
    // Never log the error object: undici errors can carry the request headers.
    ctx.logger.warn(
      { modelId: model._id.toHexString(), errName: err instanceof Error ? err.name : 'unknown' },
      'upstream request failed',
    );
    return { ok: false, status: 'upstream_error', upstreamStatus };
  }
}

function completionText(response: ChatCompletionResponse): string {
  return response.choices
    .map((choice) => {
      const { content } = choice.message;
      const text = typeof content === 'string' ? content : '';
      const toolCalls = 'tool_calls' in choice.message ? choice.message.tool_calls : undefined;
      return toolCalls === undefined ? text : text + JSON.stringify(toolCalls);
    })
    .join('');
}

/** Upstream usage when present, else a tiktoken count flagged `usageEstimated` (L147). */
function usageOf(
  response: ChatCompletionResponse,
  body: ChatCompletionRequest,
): { promptTokens: number; completionTokens: number; usageEstimated: boolean } {
  if (response.usage) {
    return {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      usageEstimated: false,
    };
  }
  return {
    promptTokens: countMessages(body.messages),
    completionTokens: count(completionText(response)),
    usageEstimated: true,
  };
}

/**
 * Gateway steps 3–6 (L236–239) for a non-streaming call: hold the worst case,
 * forward, then capture the actual cost or release the hold on failure.
 */
export async function completeChat(
  ctx: AppContext,
  input: CompletionInput,
): Promise<CompletionResult> {
  const { requestId, key, model, body } = input;
  if (await Requests.exists({ requestId })) {
    throw new AppError('invalid_request', { message: 'X-Request-Id was already used' });
  }

  const pricing = {
    inPrice: model.pricing.inputPerMTokMicroUsdc,
    outPrice: model.pricing.outputPerMTokMicroUsdc,
  };
  const estimate = estimateHoldMicro({
    promptTokens: countMessages(body.messages),
    maxTokens: input.maxTokens,
    ...pricing,
  });
  // `hold` needs a positive amount; a free model still reserves one micro-USDC.
  const { holdId } = await hold(key.userId, estimate > 0n ? estimate : 1n, { requestId });

  const started = performance.now();
  const outcome = await callUpstream(ctx, model, body);
  const record = {
    requestId,
    apiKeyId: key.apiKeyId,
    modelId: model._id,
    latencyMs: Math.round(performance.now() - started),
    streamed: false,
    upstreamStatus: outcome.upstreamStatus,
    discountBps: DISCOUNT_BPS,
  } satisfies Partial<RequestRecord>;

  if (!outcome.ok) {
    await release(holdId, {
      ...record,
      status: outcome.status,
      promptTokens: 0,
      completionTokens: 0,
    });
    throw new AppError(outcome.status === 'timeout' ? 'upstream_timeout' : 'upstream_error');
  }

  const usage = usageOf(outcome.parsed, body);
  const cost = computeCostMicro({ pt: usage.promptTokens, ct: usage.completionTokens, ...pricing });
  // The hold is the overdraft guard (G14): never bill past it, even if the
  // upstream's tokenizer counts more prompt tokens than tiktoken did.
  const billed = cost > estimate ? estimate : cost;
  if (billed < cost) {
    ctx.logger.warn(
      { requestId, cost: cost.toString(), estimate: estimate.toString() },
      'upstream usage exceeded the hold estimate; billing the estimate',
    );
  }
  const { balanceMicro } = await capture(holdId, billed, {
    ...record,
    status: 'success',
    ...usage,
  });

  return {
    rawBody: outcome.rawBody,
    headers: {
      'X-Cost-Usdc': microToUsdcString(billed),
      'X-Balance-Usdc': microToUsdcString(balanceMicro),
      'X-Discount-Bps': String(DISCOUNT_BPS),
    },
  };
}
