import {
  usdcStringToMicro,
  type Cluster,
  type Settlement,
  type SettlementState,
} from '@ibt/shared';

import { env } from '../env';
import { formatCount, formatDecimal, formatPeriod, formatSol, shortAddress } from '../lib/format';
import { useSettlements } from '../lib/queries';
import { txUrl } from '../lib/solscan';
import { EXTERNAL_LINK } from './ModelStats';

const STATES: Record<SettlementState, { label: string; className: string }> = {
  computing: { label: 'Computing', className: 'text-ink-200' },
  paid_provider: { label: 'Provider paid', className: 'text-accent' },
  converted: { label: 'Converted', className: 'text-accent' },
  bought: { label: 'Bought', className: 'text-accent' },
  locked: { label: 'Locked', className: 'text-accent' },
  done: { label: 'Done', className: 'text-positive' },
  failed: { label: 'Failed', className: 'text-negative' },
};

const COLUMNS = [
  'Period (UTC)',
  'Requests',
  'Revenue USDC',
  'Provider USDC',
  'Liquidity slice',
  'State',
  'Transactions',
] as const;

const SECONDARY_BUTTON =
  'inline-flex h-9 items-center rounded-sm border border-ink-600 px-4 font-mono text-xs uppercase tracking-label text-ink-200 transition-colors hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-60';

function usdc(amount: string): string {
  return formatDecimal(amount, 6, 2);
}

function signatures(settlement: Settlement): { label: string; signature: string }[] {
  const { provider, liquidity } = settlement;
  const all = [
    ['Payout', provider.txSignature],
    ['Buy', liquidity.buyTxSignature],
    ['Swap', liquidity.swapTxSignature],
    ['Migration', liquidity.migrationSignature],
    ['Add liquidity', liquidity.addTxSignature],
    ['Lock', liquidity.lockTxSignature],
    ['Fee claim', liquidity.claimTxSignature],
  ] as const;
  return all.flatMap(([label, signature]) => (signature === null ? [] : [{ label, signature }]));
}

function SettlementRow({ settlement, cluster }: { settlement: Settlement; cluster: Cluster }) {
  const state = STATES[settlement.state];
  const { provider, liquidity } = settlement;
  const carried = usdcStringToMicro(provider.carryOverUsdc) > 0n;
  const txs = signatures(settlement);

  return (
    <tr className="border-t border-ink-800 align-top">
      <td className="whitespace-nowrap px-4 py-3 text-ink-200">
        {formatPeriod(settlement.periodStart, settlement.periodEnd)}
      </td>
      <td className="px-4 py-3 text-right">{formatCount(settlement.requestCount)}</td>
      <td className="px-4 py-3 text-right text-ink-50">{usdc(settlement.revenueUsdc)}</td>
      <td className="px-4 py-3 text-right">
        <span className="block text-ink-50">{usdc(provider.amountUsdc)}</span>
        {carried && (
          <span className="block text-xs text-ink-400">
            {formatDecimal(provider.carryOverUsdc, 6)} carried
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <span className="block text-ink-50">{usdc(liquidity.sliceUsdc)} USDC</span>
        {liquidity.solLamports !== null && (
          <span className="block text-xs text-ink-400">{formatSol(liquidity.solLamports)} SOL</span>
        )}
      </td>
      <td
        className={`whitespace-nowrap px-4 py-3 text-xs uppercase tracking-label ${state.className}`}
      >
        {state.label}
      </td>
      <td className="px-4 py-3">
        {txs.length === 0 ? (
          <span className="text-ink-600">—</span>
        ) : (
          <ul className="space-y-1 text-xs">
            {txs.map(({ label, signature }) => (
              <li key={label} className="whitespace-nowrap">
                <span className="text-ink-400">{label}</span>{' '}
                <a
                  href={txUrl(signature, cluster)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={signature}
                  aria-label={`${label} transaction`}
                  className={EXTERNAL_LINK}
                >
                  {shortAddress(signature, 6)}
                </a>
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

interface SettlementTableProps {
  mint: string;
  cluster?: Cluster;
}

/** Public hourly settlement ledger for `mint`, refetched every 60 s. */
export function SettlementTable({ mint, cluster = env.VITE_CLUSTER }: SettlementTableProps) {
  const settlements = useSettlements(mint);
  const items = settlements.data?.pages.flatMap((page) => page.items) ?? [];

  if (settlements.isPending) {
    return (
      <div role="status" aria-label="Loading settlements" className="animate-pulse space-y-2">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="h-10 rounded-sm bg-ink-900" />
        ))}
      </div>
    );
  }

  if (settlements.isError) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-4 rounded-sm border border-negative/40 bg-negative/10 p-5"
      >
        <div>
          <p className="font-medium text-ink-50">Could not load settlements</p>
          <p className="mt-1 font-mono text-xs text-ink-400">{settlements.error.message}</p>
        </div>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          onClick={() => void settlements.refetch()}
        >
          Retry
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-sm border border-dashed border-ink-800 px-6 py-10 text-center">
        <p className="font-medium text-ink-50">No settlements yet</p>
        <p className="mt-2 text-sm text-ink-400">
          The keeper settles each hour&apos;s revenue at five past the hour.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto rounded-sm border border-ink-800">
        <table className="w-full min-w-max font-mono text-sm tabular-nums">
          <thead className="bg-ink-900 text-xs uppercase tracking-label text-ink-400">
            <tr>
              {COLUMNS.map((column, index) => (
                <th
                  key={column}
                  scope="col"
                  className={`px-4 py-3 font-normal ${index >= 1 && index <= 4 ? 'text-right' : 'text-left'}`}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((settlement) => (
              <SettlementRow key={settlement.id} settlement={settlement} cluster={cluster} />
            ))}
          </tbody>
        </table>
      </div>
      {settlements.hasNextPage && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={settlements.isFetchingNextPage}
            onClick={() => void settlements.fetchNextPage()}
          >
            {settlements.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
