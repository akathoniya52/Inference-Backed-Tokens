import { Models, type ModelFields, type Types } from '@ibt/db';
import {
  ChatCompletionResponseSchema,
  HEALTH_FAILURES_TO_PAUSE,
  type HealthCheckResponse,
  type ModelStatus,
} from '@ibt/shared';
import { decrypt } from '@ibt/shared/node';
import { request } from 'undici';

import type { AppContext } from '../../app.js';
import { chatCompletionsUrl, isUpstreamTimeout, upstreamTimeouts } from '../../lib/upstream.js';

export type HealthCheckModel = Pick<ModelFields, 'slug' | 'upstream' | 'status'> & {
  _id: Types.ObjectId;
};

/** Latency samples per model for `p50LatencyMs`; process-local, newest last. */
const LATENCY_WINDOW = 21;
const latencySamples = new Map<string, number[]>();

function recordLatency(modelId: string, latencyMs: number): number {
  const samples = [...(latencySamples.get(modelId) ?? []), latencyMs].slice(-LATENCY_WINDOW);
  latencySamples.set(modelId, samples);
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? latencyMs;
}

type ProbeResult = { ok: true; latencyMs: number } | { ok: false; error: string };

/** One `max_tokens: 1` completion against the provider (L250). Errors never carry the key. */
async function probe(ctx: AppContext, model: HealthCheckModel): Promise<ProbeResult> {
  const { firstByteMs, totalMs } = upstreamTimeouts(ctx);
  const url = chatCompletionsUrl(model.upstream.baseUrl);
  const started = performance.now();
  try {
    const res = await request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${decrypt(model.upstream.apiKeyEnc, ctx.env.MASTER_KEY)}`,
      },
      body: JSON.stringify({
        model: model.upstream.modelName,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      headersTimeout: firstByteMs,
      bodyTimeout: totalMs,
      signal: AbortSignal.timeout(totalMs),
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      await res.body.dump();
      return { ok: false, error: `upstream returned ${res.statusCode}` };
    }
    const body: unknown = await res.body.json().catch(() => null);
    if (!ChatCompletionResponseSchema.safeParse(body).success) {
      return { ok: false, error: 'upstream returned a malformed body' };
    }
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    if (isUpstreamTimeout(err)) return { ok: false, error: 'upstream timed out' };
    ctx.logger.warn(
      { modelId: model._id.toHexString(), errName: err instanceof Error ? err.name : 'unknown' },
      'health check request failed',
    );
    return { ok: false, error: 'upstream request failed' };
  }
}

/**
 * Runs one health check and records it; the third consecutive failure pauses
 * the model and alerts (L250). Reused by the admin run endpoint (G12).
 */
export async function runHealthCheck(
  ctx: AppContext,
  model: HealthCheckModel,
): Promise<HealthCheckResponse> {
  const modelId = model._id.toHexString();
  const result = await probe(ctx, model);

  if (result.ok) {
    const updated = await Models.findOneAndUpdate(
      { _id: model._id },
      {
        $set: {
          'health.lastOkAt': ctx.clock(),
          'health.p50LatencyMs': recordLatency(modelId, result.latencyMs),
          'health.consecutiveFailures': 0,
        },
      },
      { new: true },
    ).lean();
    return {
      ok: true,
      latencyMs: result.latencyMs,
      status: updated?.status ?? model.status,
      consecutiveFailures: 0,
    };
  }

  const failed = await Models.findOneAndUpdate(
    { _id: model._id },
    { $inc: { 'health.consecutiveFailures': 1 } },
    { new: true },
  ).lean();
  const consecutiveFailures = failed?.health.consecutiveFailures ?? 0;
  let status: ModelStatus = failed?.status ?? model.status;

  if (consecutiveFailures >= HEALTH_FAILURES_TO_PAUSE && status === 'active') {
    // Conditional on `active`, so concurrent checks pause and alert once.
    const paused = await Models.updateOne(
      { _id: model._id, status: 'active' },
      { $set: { status: 'paused' } },
    );
    if (paused.modifiedCount === 1) {
      status = 'paused';
      ctx.alerts.modelPaused({
        modelId,
        slug: model.slug,
        reason: 'health_check',
        consecutiveFailures,
        error: result.error,
      });
    }
  }

  return { ok: false, latencyMs: null, status, consecutiveFailures, error: result.error };
}
