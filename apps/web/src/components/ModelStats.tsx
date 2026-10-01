import type { Cluster, Model, TokenStateResponse } from '@ibt/shared';
import type { ReactNode } from 'react';

import { env } from '../env';
import { formatCount, formatDecimal, formatPct, shortAddress } from '../lib/format';
import { addressUrl } from '../lib/solscan';

export const EXTERNAL_LINK =
  'font-mono tabular-nums text-ink-200 underline decoration-ink-600 underline-offset-4 transition-colors hover:text-accent hover:decoration-accent';

export function AddressLink({
  address,
  cluster = env.VITE_CLUSTER,
  label,
}: {
  address: string;
  cluster?: Cluster;
  label?: string;
}) {
  return (
    <a
      href={addressUrl(address, cluster)}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      className={EXTERNAL_LINK}
      {...(label ? { 'aria-label': label } : {})}
    >
      {shortAddress(address)}
    </a>
  );
}

function Stat({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`bg-ink-950 p-5 ${wide ? 'sm:col-span-2' : ''}`}>
      <dt className="font-mono text-xs uppercase tracking-label text-ink-400">{label}</dt>
      <dd className="mt-2 font-mono text-xl tabular-nums text-ink-50">{children}</dd>
    </div>
  );
}

interface ModelStatsProps {
  model: Model;
  /** Latest `/api/tokens/:mint/state`; its stats and pools win over the model's. */
  state?: TokenStateResponse | undefined;
  cluster?: Cluster;
}

export function ModelStats({ model, state, cluster = env.VITE_CLUSTER }: ModelStatsProps) {
  const stats = state?.stats ?? model.stats;
  const lockedSol = state?.lockedLiquiditySol ?? stats.lockedLiquiditySol ?? '0';
  const dbcPool = state?.dbcPool ?? model.token.dbcPool;
  const dammPool = state?.dammV2Pool ?? model.token.dammV2Pool;

  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-ink-800 bg-ink-800 lg:grid-cols-4">
      <Stat label="Requests 24h">{formatCount(stats.requests24h)}</Stat>
      <Stat label="Success rate">{stats.requests24h > 0 ? formatPct(stats.successRate) : '—'}</Stat>
      <Stat label="Revenue 24h">{`${formatDecimal(stats.revenueUsdc24h, 2, 2)} USDC`}</Stat>
      <Stat label="Locked liquidity">{`${formatDecimal(lockedSol, 4)} SOL`}</Stat>
      <Stat label="DBC pool" wide>
        {dbcPool === null ? (
          <span className="text-ink-400">Not launched</span>
        ) : (
          <AddressLink address={dbcPool} cluster={cluster} />
        )}
      </Stat>
      <Stat label="DAMM v2 pool" wide>
        {dammPool === null ? (
          <span className="text-ink-400">Not migrated</span>
        ) : (
          <AddressLink address={dammPool} cluster={cluster} />
        )}
      </Stat>
    </dl>
  );
}
