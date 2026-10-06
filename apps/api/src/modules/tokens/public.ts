import {
  Models,
  PoolSnapshots,
  Settlements,
  type ModelFields,
  type SettlementFields,
  type Types,
} from '@ibt/db';
import {
  AppError,
  QuoteResponseSchema,
  SettlementsResponseSchema,
  TokenSnapshotsResponseSchema,
  TokenStateResponseSchema,
  lamportsToSol,
  microToUsdcString,
  type PaginationQuery,
  type QuoteQuery,
  type QuoteResponse,
  type Settlement,
  type SettlementsResponse,
  type TokenPhase,
  type TokenSnapshotsQuery,
  type TokenSnapshotsResponse,
  type TokenStateResponse,
} from '@ibt/shared';

import type { AppContext } from '../../app.js';
import { toPublicKey } from '../../lib/publicKey.js';
import { cursorFilter, toPage } from '../../pagination.js';

type TokenModel = Pick<ModelFields, 'token' | 'stats'> & { _id: Types.ObjectId };
type SettlementRow = SettlementFields & { _id: Types.ObjectId; updatedAt: Date };

async function modelByMint(mint: string): Promise<TokenModel> {
  const row = await Models.findOne({ 'token.mint': mint, status: { $ne: 'delisted' } })
    .select({ token: 1, stats: 1 })
    .lean<TokenModel>();
  if (!row) throw new AppError('not_found', { message: 'unknown mint' });
  return row;
}

function phaseOf(model: TokenModel): TokenPhase {
  if (model.token.status === 'graduated') return 'graduated';
  return model.token.status === 'curve' ? 'curve' : 'none';
}

/** Plain decimal (no exponent) for a float price such as `6.1e-9`. */
export function decimalString(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const fixed = value.toFixed(20);
  if (fixed.includes('e')) return '0';
  return fixed.replace(/\.?0+$/, '') || '0';
}

function clampProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
}

/** `GET /api/tokens/:mint/state` (L452–454): latest pool snapshot plus model stats. */
export async function tokenState(mint: string): Promise<TokenStateResponse> {
  const model = await modelByMint(mint);
  const snapshot = await PoolSnapshots.findOne({ modelId: model._id }).sort({ ts: -1 }).lean();
  const phase = phaseOf(model);
  const lockedLiquiditySol = lamportsToSol(model.stats.lockedLiquidityLamports);
  return TokenStateResponseSchema.parse({
    phase,
    progress: snapshot ? clampProgress(snapshot.progress) : phase === 'graduated' ? 1 : 0,
    quoteReserveSol: snapshot ? lamportsToSol(BigInt(snapshot.quoteReserve)) : '0',
    priceSolPerToken: snapshot ? decimalString(snapshot.priceSolPerToken) : '0',
    dbcPool: model.token.dbcPool ?? null,
    dammV2Pool: model.token.dammV2Pool ?? null,
    lockedLiquiditySol,
    stats: {
      requests24h: model.stats.requests,
      successRate: model.stats.successRate,
      revenueUsdc24h: microToUsdcString(model.stats.revenueMicroUsdc),
      lockedLiquiditySol,
    },
  });
}

/** `GET /api/tokens/:mint/snapshots`: the latest `limit` snapshots as a price series, oldest first. */
export async function tokenSnapshots(
  mint: string,
  query: TokenSnapshotsQuery,
): Promise<TokenSnapshotsResponse> {
  const model = await modelByMint(mint);
  const rows = await PoolSnapshots.find({ modelId: model._id })
    .sort({ ts: -1 })
    .limit(query.limit)
    .select({ ts: 1, priceSolPerToken: 1, progress: 1, isMigrated: 1 })
    .lean();
  return TokenSnapshotsResponseSchema.parse({
    mint,
    points: rows.reverse().map((row) => ({
      ts: row.ts.toISOString(),
      priceSolPerToken: decimalString(row.priceSolPerToken),
      progress: clampProgress(row.progress),
      phase: row.isMigrated ? 'graduated' : 'curve',
    })),
  });
}

/** API-05: how long a quote is reused, and how many distinct quotes are kept. */
export const QUOTE_CACHE_MS = 3_000;
export const QUOTE_CACHE_MAX = 500;

interface CachedQuote {
  at: number;
  quote: Promise<QuoteResponse>;
}

export type TokenQuoter = (mint: string, query: QuoteQuery) => Promise<QuoteResponse>;

/**
 * `GET /api/tokens/:mint/quote` (L400): curve → DBC quote, graduated → DAMM v2 quote.
 * API-05: each quote costs several RPC reads, so identical quotes within
 * `QUOTE_CACHE_MS` (including ones still in flight) share one chain call. The
 * cache is bounded: expired entries go first, then the oldest.
 */
export function createTokenQuoter(ctx: AppContext): TokenQuoter {
  const cache = new Map<string, CachedQuote>();

  const evict = (now: number): void => {
    for (const [key, entry] of cache) {
      if (now - entry.at >= QUOTE_CACHE_MS || now < entry.at) cache.delete(key);
    }
    for (const key of cache.keys()) {
      if (cache.size < QUOTE_CACHE_MAX) break;
      cache.delete(key);
    }
  };

  return (mint, query) => {
    const key = `${mint}:${query.side}:${query.amount}`;
    const now = ctx.clock().getTime();
    const hit = cache.get(key);
    if (hit && now >= hit.at && now - hit.at < QUOTE_CACHE_MS) return hit.quote;
    evict(now);
    const quote = tokenQuote(ctx, mint, query);
    cache.set(key, { at: now, quote });
    // A failed quote is not cached.
    quote.catch(() => {
      if (cache.get(key)?.quote === quote) cache.delete(key);
    });
    return quote;
  };
}

export async function tokenQuote(
  ctx: AppContext,
  mint: string,
  query: QuoteQuery,
): Promise<QuoteResponse> {
  const model = await modelByMint(mint);
  const phase = phaseOf(model);
  const input = { side: query.side, amount: BigInt(query.amount) };
  let quote;
  if (phase === 'curve' && model.token.dbcPool) {
    quote = await ctx.chain.quoteCurve(toPublicKey(model.token.dbcPool), input);
  } else if (phase === 'graduated') {
    quote = await ctx.chain.quoteDamm(toPublicKey(mint), input);
  } else {
    throw new AppError('not_found', { message: 'token has no pool yet' });
  }
  return QuoteResponseSchema.parse({
    side: query.side,
    phase,
    amountIn: quote.amountIn.toString(),
    amountOut: quote.amountOut.toString(),
    fee: quote.fee.toString(),
    priceImpactPct: quote.priceImpactPct,
  });
}

function bigOrNull(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

function toSettlementDto(row: SettlementRow): Settlement {
  const { provider, liquidity } = row;
  return {
    id: row._id.toHexString(),
    modelId: row.modelId.toHexString(),
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    state: row.state,
    revenueUsdc: microToUsdcString(row.revenueMicroUsdc),
    requestCount: row.requestCount,
    provider: {
      amountUsdc: microToUsdcString(provider.amountMicroUsdc),
      carryOverUsdc: microToUsdcString(provider.carryOverMicroUsdc),
      txSignature: provider.txSignature ?? null,
    },
    liquidity: {
      phase: liquidity.phase,
      sliceUsdc: microToUsdcString(liquidity.sliceMicroUsdc),
      solLamports: bigOrNull(liquidity.solLamports),
      solPriceUsdc: liquidity.solPriceUsdc ?? null,
      tokensBaseUnits: bigOrNull(liquidity.tokensBaseUnits),
      buyTxSignature: liquidity.buyTxSignature ?? null,
      swapTxSignature: liquidity.swapTxSignature ?? null,
      migrationSignature: liquidity.migrationSignature ?? null,
      addTxSignature: liquidity.addTxSignature ?? null,
      lockTxSignature: liquidity.lockTxSignature ?? null,
      claimTxSignature: liquidity.claimTxSignature ?? null,
    },
    platformUsdc: microToUsdcString(row.platformMicroUsdc),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `GET /api/tokens/:mint/settlements` (L401): the public settlement ledger, newest first. */
export async function tokenSettlements(
  mint: string,
  query: PaginationQuery,
): Promise<SettlementsResponse> {
  const model = await modelByMint(mint);
  const rows = await Settlements.find({ modelId: model._id, ...cursorFilter(query.cursor) })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean<SettlementRow[]>();
  const page = toPage(rows, query.limit);
  return SettlementsResponseSchema.parse({
    items: page.rows.map(toSettlementDto),
    nextCursor: page.nextCursor,
  });
}
