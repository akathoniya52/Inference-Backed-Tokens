import type { Model, TokenStatus } from '@ibt/shared';
import { Link } from 'react-router-dom';

import { formatCount, formatDecimal, formatPct, shortAddress } from '../lib/format';
import { CurveProgress } from './CurveProgress';

const PHASES: Record<TokenStatus, { label: string; className: string }> = {
  none: { label: 'No token', className: 'border-ink-800 text-ink-400' },
  pending: { label: 'Launch pending', className: 'border-ink-600 text-ink-200' },
  curve: { label: 'On curve', className: 'border-accent/40 bg-accent/10 text-accent' },
  graduated: { label: 'Graduated', className: 'border-positive/40 bg-positive/10 text-positive' },
};

export function PhaseBadge({ status }: { status: TokenStatus }) {
  const phase = PHASES[status];
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center rounded-sm border px-2 font-mono text-xs uppercase tracking-label ${phase.className}`}
    >
      {phase.label}
    </span>
  );
}

export function formatMTokPrice(usdc: string): string {
  return `$${formatDecimal(usdc, 6, 2)}`;
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-xs uppercase tracking-label text-ink-400">{label}</dt>
      <dd className="mt-1 truncate font-mono text-sm tabular-nums text-ink-50">{value}</dd>
    </div>
  );
}

export function ModelCard({ model }: { model: Model }) {
  const { token, stats, pricing } = model;
  const hasTraffic = stats.requests24h > 0;

  return (
    <article className="group relative flex flex-col rounded-sm border border-ink-800 bg-ink-900/60 p-5 transition-colors focus-within:border-accent/60 hover:border-ink-600 hover:bg-ink-900">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-medium tracking-tight text-ink-50">
            <Link to={`/t/${model.slug}`} className="after:absolute after:inset-0">
              {model.name}
            </Link>
          </h2>
          <p className="mt-1 truncate font-mono text-xs text-ink-400">
            {token.symbol !== null && <span className="mr-2 text-accent">${token.symbol}</span>}
            {model.slug}
          </p>
        </div>
        <PhaseBadge status={token.status} />
      </div>

      {model.description !== '' && (
        <p className="mt-3 line-clamp-2 text-sm text-ink-400">{model.description}</p>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-ink-800 pt-4">
        <Figure label="Input / 1M" value={formatMTokPrice(pricing.inputPerMTokUsdc)} />
        <Figure label="Output / 1M" value={formatMTokPrice(pricing.outputPerMTokUsdc)} />
        <Figure label="Requests 24h" value={formatCount(stats.requests24h)} />
        <Figure label="Success" value={hasTraffic ? formatPct(stats.successRate) : '—'} />
      </dl>

      {token.status === 'curve' && token.mint !== null && (
        <div className="mt-5 border-t border-ink-800 pt-4">
          <CurveProgress mint={token.mint} size="sm" />
        </div>
      )}
      {token.status === 'graduated' && stats.lockedLiquiditySol !== undefined && (
        <dl className="mt-5 border-t border-ink-800 pt-4">
          <Figure
            label="Locked liquidity"
            value={`${formatDecimal(stats.lockedLiquiditySol, 4)} SOL`}
          />
        </dl>
      )}

      <p className="mt-auto flex items-center justify-between gap-3 pt-5 font-mono text-xs text-ink-400">
        <span>
          Provider <span className="text-ink-200">{shortAddress(model.providerWallet)}</span>
        </span>
        {model.status !== 'active' && (
          <span className="uppercase tracking-label text-negative">{model.status}</span>
        )}
      </p>
    </article>
  );
}
