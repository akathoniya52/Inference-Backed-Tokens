import {
  Settlements,
  Users,
  recomputeBalance,
  recomputeHeld,
  withTransaction,
  type Types,
} from '@ibt/db';
import { microToUsdcString } from '@ibt/shared';

import type { KeeperCtx } from '../ctx.js';

const WINDOW_MS = 48 * 3_600_000;

export interface BalanceDrift {
  userId: string;
  /** `balance` (deposits + adjustments − captures) or `held` (open hold estimates). */
  field: 'balance' | 'held';
  cachedMicroUsdc: bigint;
  ledgerMicroUsdc: bigint;
  fixed: boolean;
}

export interface BadSignature {
  settlementId: string;
  field: string;
  signature: string;
  status: string;
}

export interface ReconcileReport {
  usersChecked: number;
  drift: BalanceDrift[];
  signaturesChecked: number;
  badSignatures: BadSignature[];
}

const SIGNATURE_FIELDS = [
  ['provider.txSignature', (s: SettlementRow) => s.provider.txSignature],
  ['liquidity.buyTxSignature', (s: SettlementRow) => s.liquidity.buyTxSignature],
  ['liquidity.swapTxSignature', (s: SettlementRow) => s.liquidity.swapTxSignature],
  ['liquidity.migrationSignature', (s: SettlementRow) => s.liquidity.migrationSignature],
  ['liquidity.addTxSignature', (s: SettlementRow) => s.liquidity.addTxSignature],
  ['liquidity.lockTxSignature', (s: SettlementRow) => s.liquidity.lockTxSignature],
  ['liquidity.claimTxSignature', (s: SettlementRow) => s.liquidity.claimTxSignature],
] as const;

interface SettlementRow {
  _id: { toHexString(): string };
  provider: { txSignature?: string | null };
  liquidity: {
    buyTxSignature?: string | null;
    swapTxSignature?: string | null;
    migrationSignature?: string | null;
    addTxSignature?: string | null;
    lockTxSignature?: string | null;
    claimTxSignature?: string | null;
  };
}

/**
 * Nightly reconciliation (L372, L531): every cached balance is compared with its ledger
 * sum and drift is logged, alerted and fixed (only if the balance did not move meanwhile);
 * every settlement signature from the last 48 h must have landed, otherwise alert.
 */
export function createReconcileJob(ctx: Pick<KeeperCtx, 'chain' | 'clock' | 'logger' | 'alerter'>) {
  const log = ctx.logger.child({ job: 'reconcile' });

  /**
   * One user's cached balance and held amount against the ledger, all read in one
   * transaction snapshot (KPR-07), so a capture or deposit committing meanwhile cannot
   * show up as drift. Drift is fixed in the same transaction; a write conflict with live
   * traffic retries it on a fresh snapshot.
   */
  async function reconcileUser(userId: Types.ObjectId): Promise<BalanceDrift[]> {
    return withTransaction(async (session) => {
      const user = await Users.findById(userId, { balanceMicroUsdc: 1, heldMicroUsdc: 1 })
        .session(session)
        .lean();
      if (!user) return [];
      const balance = await recomputeBalance(userId, { session });
      const held = await recomputeHeld(userId, { session });
      const rows: BalanceDrift[] = [];
      const set: Record<string, bigint> = {};
      if (balance !== user.balanceMicroUsdc) {
        set.balanceMicroUsdc = balance;
        rows.push({
          userId: userId.toHexString(),
          field: 'balance',
          cachedMicroUsdc: user.balanceMicroUsdc,
          ledgerMicroUsdc: balance,
          fixed: true,
        });
      }
      if (held !== user.heldMicroUsdc) {
        set.heldMicroUsdc = held;
        rows.push({
          userId: userId.toHexString(),
          field: 'held',
          cachedMicroUsdc: user.heldMicroUsdc,
          ledgerMicroUsdc: held,
          fixed: true,
        });
      }
      if (rows.length > 0) {
        await Users.updateOne(
          {
            _id: userId,
            balanceMicroUsdc: user.balanceMicroUsdc,
            heldMicroUsdc: user.heldMicroUsdc,
          },
          { $set: set },
          { session },
        );
      }
      return rows;
    });
  }

  async function reconcileBalances(): Promise<{ checked: number; drift: BalanceDrift[] }> {
    const users = await Users.find({}, { _id: 1 }).lean();
    const drift: BalanceDrift[] = [];
    for (const user of users) {
      for (const row of await reconcileUser(user._id)) {
        drift.push(row);
        const body = {
          userId: row.userId,
          field: row.field,
          cachedUsdc: microToUsdcString(row.cachedMicroUsdc),
          ledgerUsdc: microToUsdcString(row.ledgerMicroUsdc),
          fixed: row.fixed,
        };
        log.warn(body, `${row.field} drift`);
        await ctx.alerter.alert('warn', `${row.field} drift`, body);
      }
    }
    return { checked: users.length, drift };
  }

  async function reconcileSignatures(): Promise<{ checked: number; bad: BadSignature[] }> {
    const since = new Date(ctx.clock.now().getTime() - WINDOW_MS);
    const settlements = await Settlements.find(
      { periodStart: { $gte: since } },
      { provider: 1, liquidity: 1 },
    ).lean<SettlementRow[]>();
    const bad: BadSignature[] = [];
    let checked = 0;
    for (const settlement of settlements) {
      for (const [field, read] of SIGNATURE_FIELDS) {
        const signature = read(settlement);
        if (!signature) continue;
        checked += 1;
        const status = await ctx.chain.signatureStatus(signature);
        if (status !== 'landed') {
          bad.push({ settlementId: settlement._id.toHexString(), field, signature, status });
        }
      }
    }
    if (bad.length > 0) {
      log.error({ bad }, 'settlement signatures not landed');
      await ctx.alerter.alert('error', 'settlement signatures not landed', {
        count: bad.length,
        signatures: bad,
      });
    }
    return { checked, bad };
  }

  return {
    async tick(): Promise<ReconcileReport> {
      const balances = await reconcileBalances();
      const signatures = await reconcileSignatures();
      const report = {
        usersChecked: balances.checked,
        drift: balances.drift,
        signaturesChecked: signatures.checked,
        badSignatures: signatures.bad,
      };
      log.info(
        {
          usersChecked: report.usersChecked,
          drift: report.drift.length,
          signaturesChecked: report.signaturesChecked,
          badSignatures: report.badSignatures.length,
        },
        'reconciliation finished',
      );
      return report;
    },
  };
}
