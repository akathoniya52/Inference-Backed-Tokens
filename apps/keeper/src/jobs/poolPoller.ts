import type { DammPoolDto, DbcPoolDto } from '@ibt/chain';
import { Models, PoolSnapshots, type Types } from '@ibt/db';
import { PublicKey } from '@solana/web3.js';

import type { KeeperCtx } from '../ctx.js';

export const POOL_POLLER_CRON = '*/15 * * * * *';

const Q64 = 2 ** 64;
const SOL_DECIMALS_SHIFT = 1e-3; // 10^(tokenDecimals 6 − solDecimals 9)

interface PolledModel {
  _id: Types.ObjectId;
  slug: string;
  token: {
    status: string;
    mint?: string | null;
    dbcPool?: string | null;
    migrationSignature?: string | null;
  };
}

export interface PoolPoller {
  /** One pass over every curve/graduated model; concurrent calls share the pass in flight. */
  tick(): Promise<void>;
}

/** SOL per whole token from the DAMM v2 sqrt price (Q64.64, token B per token A in base units). */
export function dammPriceSolPerToken(damm: DammPoolDto, mint: string): number {
  const raw = (Number(damm.sqrtPrice) / Q64) ** 2;
  if (raw === 0) return 0;
  return damm.tokenAMint === mint ? raw * SOL_DECIMALS_SHIFT : SOL_DECIMALS_SHIFT / raw;
}

/** On the curve the DTO carries no sqrt price, so the chart uses the reserve ratio. */
function curvePriceSolPerToken(pool: DbcPoolDto): number {
  const base = Number(pool.baseReserve);
  return base === 0 ? 0 : (Number(pool.quoteReserve) / base) * SOL_DECIMALS_SHIFT;
}

const isComplete = (pool: DbcPoolDto) =>
  BigInt(pool.quoteReserve) >= BigInt(pool.migrationQuoteThreshold);

export function createPoolPoller(ctx: KeeperCtx): PoolPoller {
  const log = ctx.logger.child({ job: 'poolPoller' });
  /** lastValidBlockHeight of migrations this process signed, keyed by DBC pool. */
  const pendingMigrations = new Map<string, number>();
  let inFlight: Promise<void> | null = null;

  async function shouldSendMigration(model: PolledModel, pool: string): Promise<boolean> {
    const signature = model.token.migrationSignature;
    if (!signature) return true;
    const status = await ctx.chain.signatureStatus(signature);
    if (status === 'landed') return false;
    if (status === 'failed') return true;
    const lastValid = pendingMigrations.get(pool);
    // Unknown signature: wait while its blockhash can still land. A resend after a
    // restart is safe because a second migrate on a migrated pool fails on-chain.
    return lastValid === undefined || (await ctx.blockHeight()) > lastValid;
  }

  async function crankMigration(model: PolledModel, pool: string): Promise<void> {
    if (!(await shouldSendMigration(model, pool))) return;
    const { signature } = await ctx.chain.migrate(ctx.keeper, new PublicKey(pool), {
      onSigned: async (sig, lastValidBlockHeight) => {
        pendingMigrations.set(pool, lastValidBlockHeight);
        await Models.updateOne({ _id: model._id }, { $set: { 'token.migrationSignature': sig } });
      },
    });
    log.info({ model: model.slug, pool, signature }, 'migration sent');
  }

  async function pollModel(model: PolledModel): Promise<void> {
    const { mint, dbcPool } = model.token;
    if (!mint || !dbcPool) return;
    const pool = await ctx.chain.readPool({ pool: new PublicKey(dbcPool) });
    if (!pool) {
      log.warn({ model: model.slug, pool: dbcPool }, 'DBC pool not found');
      return;
    }
    const damm = pool.isMigrated ? await ctx.chain.readDammPool(new PublicKey(mint)) : null;

    await PoolSnapshots.create({
      modelId: model._id,
      pool: dbcPool,
      ts: ctx.clock.now(),
      quoteReserve: pool.quoteReserve,
      baseReserve: pool.baseReserve,
      sqrtPrice: damm?.sqrtPrice ?? '0',
      progress: pool.isMigrated ? 1 : pool.progress,
      priceSolPerToken: damm ? dammPriceSolPerToken(damm, mint) : curvePriceSolPerToken(pool),
      totalTradingQuoteFee: '0',
      isMigrated: pool.isMigrated,
    });

    if (!pool.isMigrated) {
      if (isComplete(pool)) await crankMigration(model, dbcPool);
      return;
    }
    pendingMigrations.delete(dbcPool);
    if (model.token.status === 'curve') {
      if (!damm) {
        log.warn({ model: model.slug, mint }, 'migrated but DAMM v2 pool not readable yet');
        return;
      }
      await Models.updateOne(
        { _id: model._id, 'token.status': 'curve' },
        { $set: { 'token.status': 'graduated', 'token.dammV2Pool': damm.address } },
      );
      log.info({ model: model.slug, dammV2Pool: damm.address }, 'token graduated');
    }
  }

  async function pass(): Promise<void> {
    const models = await Models.find(
      { 'token.status': { $in: ['curve', 'graduated'] }, 'token.dbcPool': { $type: 'string' } },
      { slug: 1, token: 1 },
    ).lean<PolledModel[]>();
    for (const model of models) {
      try {
        await pollModel(model);
      } catch (err) {
        log.error({ err, model: model.slug }, 'pool poll failed');
      }
    }
  }

  return {
    tick() {
      inFlight ??= pass().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
