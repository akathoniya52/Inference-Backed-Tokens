import {
  Types,
  capture,
  hold,
  isHoldUnbilled,
  release,
  type DailyCapOptions,
  type RequestRecord,
} from '@ibt/db';
import {
  AppError,
  ChatCompletionResponseSchema,
  applyDiscount,
  GATEWAY_RESPONSE_HEADERS,
  computeCostMicro,
  estimateHoldMicro,
  microToUsdcString,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
} from '@ibt/shared';
import { decrypt } from '@ibt/shared/node';
import { request, type Dispatcher } from 'undici';

import type { AppContext } from '../../app.js';
import type { ApiKeyContext } from '../../context.js';
import { chatCompletionsUrl, isUpstreamTimeout, upstreamTimeouts } from '../../lib/upstream.js';
import type { ResolvedModel } from './router.js';
import { count, countPrompt } from './tokenCount.js';

export interface CompletionInput {
  requestId: string;
  key: ApiKeyContext;
  model: ResolvedModel;
  body: ChatCompletionRequest;
  maxTokens: number;
  /** Holder discount for this user and model, 0 or `HOLDER_DISCOUNT_BPS`. */
  discountBps: number;
  idempotencyKey?: string;
}

export interface CompletionResult {
  rawBody: string;
  headers: Record<string, string>;
}

type UpstreamOutcome =
  | { ok: true; rawBody: string; parsed: ChatCompletionResponse; upstreamStatus: number }
  | { ok: false; status: 'upstream_error' | 'timeout'; upstreamStatus: number | null };

/**
 * Body sent upstream: the provider's model name, and `stream_options` only on a
 * streamed call to an upstream flagged `supportsStreamUsage` (G28); some
 * upstreams reject the field with a 400. The completion limit is always the
 * held `maxTokens`, under the field name the client used (`max_tokens` by
 * default), so the output can never outgrow the hold.
 */
export function upstreamBody(
  model: ResolvedModel,
  body: ChatCompletionRequest,
  stream: boolean,
  maxTokens: number,
): string {
  const {
    stream_options: _streamOptions,
    max_tokens: _maxTokens,
    max_completion_tokens: maxCompletionTokens,
    ...rest
  } = body;
  const usageOption =
    stream && model.upstream.supportsStreamUsage ? { stream_options: { include_usage: true } } : {};
  const limit =
    maxCompletionTokens == null ? { max_tokens: maxTokens } : { max_completion_tokens: maxTokens };
  return JSON.stringify({
    ...rest,
    model: model.upstream.modelName,
    stream,
    ...limit,
    ...usageOption,
  });
}

export function upstreamHeaders(ctx: AppContext, model: ResolvedModel): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${decrypt(model.upstream.apiKeyEnc, ctx.env.MASTER_KEY)}`,
  };
}

/** GW-04: a non-streamed upstream body larger than this is an upstream error. */
export const MAX_UPSTREAM_BODY_BYTES = 8 * 1024 * 1024;

/** The body as text, or null (and the socket dropped) once it passes `max` bytes. */
async function readCapped(
  body: Dispatcher.ResponseData['body'],
  max: number,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    // Leaving the loop destroys the body, so the rest is never read.
    if (size > max) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
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

async function callUpstream(ctx: AppContext, input: CompletionInput): Promise<UpstreamOutcome> {
  const { model, body } = input;
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
      headers: upstreamHeaders(ctx, model),
      body: upstreamBody(model, body, false, input.maxTokens),
      headersTimeout: firstByteMs,
      bodyTimeout: totalMs,
      signal,
      dispatcher: ctx.upstreamAgent,
    });
    clearTimeout(firstByteTimer);
    upstreamStatus = res.statusCode;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      await res.body.dump();
      return { ok: false, status: 'upstream_error', upstreamStatus };
    }
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BODY_BYTES) {
      res.body.destroy();
      return { ok: false, status: 'upstream_error', upstreamStatus };
    }
    const rawBody = await readCapped(res.body, MAX_UPSTREAM_BODY_BYTES);
    if (rawBody === null) return { ok: false, status: 'upstream_error', upstreamStatus };
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

function isEmptyField(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value).length === 0;
}

/**
 * GW-01: every non-empty message field but `role` is output the provider was
 * paid to generate (content, reasoning, refusal, tool and function calls, …).
 */
function completionText(response: ChatCompletionResponse): string {
  return response.choices
    .map((choice) =>
      Object.entries(choice.message)
        .filter(([field, value]) => field !== 'role' && !isEmptyField(value))
        .map(([, value]) => (typeof value === 'string' ? value : JSON.stringify(value)))
        .join(''),
    )
    .join('');
}

/** Upstream usage when present, else a tiktoken count flagged `usageEstimated` (L147). */
function usageOf(response: ChatCompletionResponse, body: ChatCompletionRequest): UsageCount {
  if (response.usage) {
    return {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      usageEstimated: false,
    };
  }
  return {
    promptTokens: countPrompt(body),
    completionTokens: count(completionText(response)),
    usageEstimated: true,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * G21: the hold also reserves its estimate against today's (UTC) cap of the
 * key, so captured spend + open holds + this estimate never exceed the cap.
 */
function dailyCapOf(ctx: AppContext, key: ApiKeyContext): DailyCapOptions {
  const now = ctx.clock().getTime();
  return {
    apiKeyId: key.apiKeyId,
    day: new Date(now - (now % DAY_MS)),
    capMicro: key.dailyCapMicroUsdc,
  };
}

export interface Pricing {
  inPrice: bigint;
  outPrice: bigint;
}

export interface OpenHold {
  holdId: Types.ObjectId;
  /** Worst-case cost after the discount; also the billing cap (G14). */
  estimate: bigint;
  pricing: Pricing;
  discountBps: number;
}

/** Gateway steps 3–4 (L236–237): reuse and daily-cap checks, then hold the worst case. */
export async function openHold(ctx: AppContext, input: CompletionInput): Promise<OpenHold> {
  const { requestId, key, model, body } = input;
  // `requestId` is server-generated (GW-07); the hold's unique index still guards it (A2).
  const pricing = {
    inPrice: model.pricing.inputPerMTokMicroUsdc,
    outPrice: model.pricing.outputPerMTokMicroUsdc,
  };
  const estimate = applyDiscount(
    estimateHoldMicro({
      promptTokens: countPrompt(body),
      maxTokens: input.maxTokens,
      ...pricing,
    }),
    input.discountBps,
  );
  // `hold` needs a positive amount; a free model still reserves one micro-USDC.
  const { holdId } = await hold(key.userId, estimate > 0n ? estimate : 1n, {
    requestId,
    dailyCap: dailyCapOf(ctx, key),
  });
  return { holdId, estimate, pricing, discountBps: input.discountBps };
}

export interface UsageCount {
  promptTokens: number;
  completionTokens: number;
  usageEstimated: boolean;
}

/** Actual cost of the call after the holder discount (G16, floor), capped at the hold. */
export function billedCost(
  ctx: AppContext,
  requestId: string,
  held: OpenHold,
  usage: UsageCount,
): bigint {
  const cost = applyDiscount(
    computeCostMicro({ pt: usage.promptTokens, ct: usage.completionTokens, ...held.pricing }),
    held.discountBps,
  );
  // The hold is the overdraft guard (G14): never bill past it, even if the
  // upstream's tokenizer counts more prompt tokens than tiktoken did.
  const billed = cost > held.estimate ? held.estimate : cost;
  if (billed < cost) {
    ctx.logger.warn(
      { requestId, cost: cost.toString(), estimate: held.estimate.toString() },
      'upstream usage exceeded the hold estimate; billing the estimate',
    );
  }
  return billed;
}

/**
 * Gateway steps 3–6 (L236–239) for a non-streaming call: hold the worst case,
 * forward, then capture the actual cost or release the hold on failure.
 */
export async function completeChat(
  ctx: AppContext,
  input: CompletionInput,
): Promise<CompletionResult> {
  const held = await openHold(ctx, input);
  try {
    return await forwardAndBill(ctx, input, held);
  } catch (err) {
    const billed = await releaseAbandoned(ctx, input.requestId, held);
    throw billed ? new BilledCallError(err) : err;
  }
}

/**
 * GW-05: an error that escaped a call which was (or may have been) billed. The
 * router keeps the idempotency key locked, so a retry is never billed again,
 * and answers with `original`.
 */
export class BilledCallError extends Error {
  override readonly name = 'BilledCallError';

  constructor(readonly original: unknown) {
    super('a billed gateway call failed');
  }
}

/**
 * Last resort when an error escapes the gateway: releases a hold that neither
 * a capture nor a release closed. A no-op once the hold is closed. Returns
 * false only when the call is known unbilled (its hold released or expired).
 */
export async function releaseAbandoned(
  ctx: AppContext,
  requestId: string,
  held: OpenHold,
): Promise<boolean> {
  try {
    const { released } = await release(held.holdId);
    if (released) {
      ctx.logger.warn({ requestId }, 'released a hold abandoned by an error');
      return false;
    }
    // Captured, or open with a capture due (GW-12).
    return !(await isHoldUnbilled(held.holdId));
  } catch (err) {
    ctx.logger.error(
      { requestId, errName: err instanceof Error ? err.name : 'unknown' },
      'could not release an abandoned hold; hold expiry will',
    );
    // Unknown, so treated as billed: a locked key never charges twice.
    return true;
  }
}

async function forwardAndBill(
  ctx: AppContext,
  input: CompletionInput,
  held: OpenHold,
): Promise<CompletionResult> {
  const { requestId, key, model, body } = input;
  const started = performance.now();
  const outcome = await callUpstream(ctx, input);
  const record = {
    requestId,
    apiKeyId: key.apiKeyId,
    modelId: model._id,
    latencyMs: Math.round(performance.now() - started),
    streamed: false,
    upstreamStatus: outcome.upstreamStatus,
    discountBps: held.discountBps,
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  } satisfies Partial<RequestRecord>;

  if (!outcome.ok) {
    await release(held.holdId, {
      ...record,
      status: outcome.status,
      promptTokens: 0,
      completionTokens: 0,
    });
    throw new AppError(outcome.status === 'timeout' ? 'upstream_timeout' : 'upstream_error');
  }

  const usage = usageOf(outcome.parsed, body);
  const billed = billedCost(ctx, requestId, held, usage);
  const { balanceMicro } = await capture(held.holdId, billed, {
    ...record,
    status: 'success',
    ...usage,
  });

  return {
    rawBody: outcome.rawBody,
    headers: billingHeaders(billed, balanceMicro, held.discountBps),
  };
}

export function billingHeaders(
  costMicro: bigint,
  balanceMicro: bigint,
  discountBps: number,
): Record<string, string> {
  return {
    [GATEWAY_RESPONSE_HEADERS.costUsdc]: microToUsdcString(costMicro),
    [GATEWAY_RESPONSE_HEADERS.balanceUsdc]: microToUsdcString(balanceMicro),
    [GATEWAY_RESPONSE_HEADERS.discountBps]: String(discountBps),
  };
}
