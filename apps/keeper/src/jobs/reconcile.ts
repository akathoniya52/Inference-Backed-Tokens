import { Settlements, Users, recomputeBalance, withTransaction } from '@ibt/db';
import { microToUsdcString } from '@ibt/shared';

import type { KeeperCtx } from '../ctx.js';

const WINDOW_MS = 48 * 3_600_000;

export interface BalanceDrift {
  userId: string;
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

  async function reconcileBalances(): Promise<{ checked: number; drift: BalanceDrift[] }> {
    const users = await Users.find({}, { balanceMicroUsdc: 1 }).lean();
    const drift: BalanceDrift[] = [];
    for (const user of users) {
      const ledger = await recomputeBalance(user._id);
      if (ledger === user.balanceMicroUsdc) continue;
      const { modifiedCount } = await withTransaction((session) =>
        Users.updateOne(
          { _id: user._id, balanceMicroUsdc: user.balanceMicroUsdc },
          { $set: { balanceMicroUsdc: ledger } },
          { session },
        ),
      );
      const row: BalanceDrift = {
        userId: user._id.toHexString(),
        cachedMicroUsdc: user.balanceMicroUsdc,
        ledgerMicroUsdc: ledger,
        fixed: modifiedCount === 1,
      };
      drift.push(row);
      const body = {
        userId: row.userId,
        cachedUsdc: microToUsdcString(row.cachedMicroUsdc),
        ledgerUsdc: microToUsdcString(row.ledgerMicroUsdc),
        fixed: row.fixed,
      };
      log.warn(body, 'balance drift');
      await ctx.alerter.alert('warn', 'balance drift', body);
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
