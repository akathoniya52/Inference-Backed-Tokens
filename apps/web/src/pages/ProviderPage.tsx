import {
  OwnerModelSchema,
  parseUnits,
  USDC_DECIMALS,
  type Model,
  type UpdateModelRequest,
} from '@ibt/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { ClaimFees } from '../components/ClaimFees';
import { PhaseBadge } from '../components/ModelCard';
import { EXTERNAL_LINK } from '../components/ModelStats';
import { WalletGate } from '../components/WalletGate';
import { useSessionWallet } from '../hooks/useAuth';
import { apiFetch } from '../lib/api';
import {
  formatCount,
  formatDecimal,
  formatPct,
  formatPeriod,
  formatUsdc,
  shortAddress,
} from '../lib/format';
import { publicQueryKeys, useProviderModels, useSettlements } from '../lib/queries';
import { txUrl } from '../lib/solscan';

const SECTION_LABEL = 'font-mono text-xs uppercase tracking-label text-ink-400';
const PANEL = 'rounded-sm border border-ink-800 bg-ink-900/60 p-6';
const GHOST_BUTTON =
  'inline-flex h-9 items-center rounded-sm border border-ink-600 px-4 font-mono text-xs uppercase tracking-label text-ink-200 transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50';
const PAYOUT_ROWS = 6;

const STATUS_STYLE: Record<Model['status'], string> = {
  active: 'border-positive/40 text-positive',
  paused: 'border-accent/40 text-accent',
  delisted: 'border-negative/40 text-negative',
};

function sumUsdc(values: readonly string[]): bigint {
  return values.reduce((total, value) => total + parseUnits(value, USDC_DECIMALS), 0n);
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-ink-950 p-5">
      <dt className={SECTION_LABEL}>{label}</dt>
      <dd className="mt-2 font-mono text-xl tabular-nums text-ink-50">{children}</dd>
    </div>
  );
}

function usePauseToggle(model: Model) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (status: NonNullable<UpdateModelRequest['status']>) => {
      const body: UpdateModelRequest = { status };
      return OwnerModelSchema.parse(
        await apiFetch(`/api/models/${encodeURIComponent(model.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
      );
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['providerModels'] }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: publicQueryKeys.model(model.slug) }),
      ]),
  });
}

function PauseToggle({ model }: { model: Model }) {
  const toggle = usePauseToggle(model);
  if (model.status === 'delisted') return null;
  const next = model.status === 'active' ? 'paused' : 'active';
  const verb = next === 'paused' ? 'Pause' : 'Resume';
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className={GHOST_BUTTON}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate(next)}
        aria-label={`${verb} ${model.name}`}
      >
        {toggle.isPending ? 'Saving…' : verb}
      </button>
      {toggle.isError && (
        <p role="alert" className="text-xs text-negative">
          {toggle.error.message}
        </p>
      )}
    </div>
  );
}

function PayoutHistory({ mint }: { mint: string }) {
  const settlements = useSettlements(mint);
  const rows = settlements.data?.pages.flatMap((page) => page.items).slice(0, PAYOUT_ROWS) ?? [];

  if (settlements.isPending) {
    return (
      <div role="status" aria-label="Loading payouts" className="h-16 animate-pulse bg-ink-900" />
    );
  }
  if (settlements.isError) {
    return (
      <p className="text-sm text-negative">Could not load payouts: {settlements.error.message}</p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-400">
        No settlements yet. The first one runs at the top of the hour.
      </p>
    );
  }
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">Payouts received</caption>
      <thead>
        <tr className={SECTION_LABEL}>
          <th scope="col" className="pb-2 font-normal">
            Period
          </th>
          <th scope="col" className="pb-2 text-right font-normal">
            Paid
          </th>
          <th scope="col" className="pb-2 text-right font-normal">
            Transaction
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-ink-800 font-mono tabular-nums">
        {rows.map(({ id, periodStart, periodEnd, provider }) => (
          <tr key={id}>
            <td className="py-2 text-xs text-ink-400">{formatPeriod(periodStart, periodEnd)}</td>
            <td className="py-2 text-right text-ink-50">
              {formatDecimal(provider.amountUsdc, 2, 2)} USDC
            </td>
            <td className="py-2 text-right">
              {provider.txSignature !== null ? (
                <a
                  href={txUrl(provider.txSignature)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={EXTERNAL_LINK}
                >
                  {shortAddress(provider.txSignature)}
                </a>
              ) : (
                <span className="text-xs text-ink-400">
                  {parseUnits(provider.carryOverUsdc, USDC_DECIMALS) === 0n
                    ? '—'
                    : `${formatDecimal(provider.carryOverUsdc, 2, 2)} carried over`}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function healthLabel({ consecutiveFailures, p50LatencyMs }: Model['health']): string {
  if (consecutiveFailures > 0) return `${consecutiveFailures} failed checks`;
  if (p50LatencyMs !== null) return `p50 ${Math.round(p50LatencyMs)} ms`;
  return 'Not checked';
}

function ProviderModel({ model }: { model: Model }) {
  const { health, stats, token } = model;
  const live = token.status === 'curve' || token.status === 'graduated';
  return (
    <article aria-labelledby={`model-${model.id}`} className="grid gap-6 lg:grid-cols-3">
      <div className={`${PANEL} space-y-6 lg:col-span-2`}>
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h2
                id={`model-${model.id}`}
                className="text-xl font-semibold tracking-tight text-ink-50"
              >
                <Link to={`/t/${model.slug}`} className="transition-colors hover:text-accent">
                  {model.name}
                </Link>
              </h2>
              <span
                className={`rounded-sm border px-2 py-0.5 font-mono text-xs uppercase tracking-label ${STATUS_STYLE[model.status]}`}
              >
                {model.status}
              </span>
              <PhaseBadge status={token.status} />
            </div>
            <p className="mt-1 font-mono text-xs text-ink-400">
              {model.slug}
              {token.symbol !== null && <span className="text-accent"> · ${token.symbol}</span>}
            </p>
          </div>
          <PauseToggle model={model} />
        </header>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 font-mono text-sm sm:grid-cols-4">
          <div>
            <dt className={SECTION_LABEL}>Revenue 24h</dt>
            <dd className="mt-1 tabular-nums text-ink-50">
              {formatDecimal(stats.revenueUsdc24h, 2, 2)} USDC
            </dd>
          </div>
          <div>
            <dt className={SECTION_LABEL}>Requests 24h</dt>
            <dd className="mt-1 tabular-nums text-ink-50">{formatCount(stats.requests24h)}</dd>
          </div>
          <div>
            <dt className={SECTION_LABEL}>Success</dt>
            <dd className="mt-1 tabular-nums text-ink-50">
              {stats.requests24h > 0 ? formatPct(stats.successRate) : '—'}
            </dd>
          </div>
          <div>
            <dt className={SECTION_LABEL}>Health</dt>
            <dd
              className={`mt-1 tabular-nums ${health.consecutiveFailures > 0 ? 'text-negative' : 'text-ink-50'}`}
            >
              {healthLabel(health)}
            </dd>
          </div>
        </dl>

        <section aria-label={`Payouts for ${model.name}`}>
          <p className={`${SECTION_LABEL} mb-3`}>Payouts received</p>
          {live && token.mint !== null ? (
            <PayoutHistory mint={token.mint} />
          ) : (
            <p className="text-sm text-ink-400">
              Payouts are listed once the token is launched. Revenue still accrues every hour.
            </p>
          )}
        </section>
      </div>
      <aside>
        {token.dbcPool !== null ? (
          <ClaimFees model={model} />
        ) : (
          <div className={PANEL}>
            <p className="font-medium text-ink-50">No trading fees yet</p>
            <p className="mt-2 text-sm text-ink-400">
              Launch a token to earn a share of every trade&apos;s fee.
            </p>
          </div>
        )}
      </aside>
    </article>
  );
}

function ProviderDashboard() {
  const wallet = useSessionWallet();
  const models = useProviderModels(wallet);

  if (models.isPending) {
    return (
      <div role="status" aria-label="Loading your models" className="mt-10 animate-pulse space-y-4">
        <div className="h-24 rounded-sm bg-ink-900" />
        <div className="h-64 rounded-sm bg-ink-900" />
      </div>
    );
  }
  if (models.isError) {
    return (
      <div role="alert" className="mt-10 rounded-sm border border-negative/40 bg-negative/10 p-5">
        <p className="font-medium text-ink-50">Could not load your models</p>
        <p className="mt-1 font-mono text-xs text-ink-400">{models.error.message}</p>
      </div>
    );
  }
  if (models.data.length === 0) {
    return (
      <div className={`${PANEL} mt-10 max-w-xl`}>
        <p className="font-medium text-ink-50">No models yet</p>
        <p className="mt-2 text-sm text-ink-400">
          Register an endpoint and launch its token to start earning.
        </p>
        <Link
          to="/launch"
          className="mt-4 inline-block font-mono text-xs uppercase tracking-label text-accent"
        >
          Launch a model
        </Link>
      </div>
    );
  }

  const owned = models.data;
  const revenue = sumUsdc(owned.map((model) => model.stats.revenueUsdc24h));
  const requests = owned.reduce((total, model) => total + model.stats.requests24h, 0);
  const active = owned.filter((model) => model.status === 'active').length;

  return (
    <div className="mt-10 space-y-10">
      <dl
        aria-label="Totals"
        className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-ink-800 bg-ink-800 lg:grid-cols-4"
      >
        <Figure label="Models">{formatCount(owned.length)}</Figure>
        <Figure label="Active">{formatCount(active)}</Figure>
        <Figure label="Requests 24h">{formatCount(requests)}</Figure>
        <Figure label="Revenue 24h">{`${formatUsdc(revenue, 2)} USDC`}</Figure>
      </dl>
      {owned.map((model) => (
        <ProviderModel key={model.id} model={model} />
      ))}
    </div>
  );
}

export function ProviderPage() {
  return (
    <section>
      <h1 className="page-title">Provider</h1>
      <p className="page-lede">Your models, earnings, payouts and claimable trading fees.</p>
      <WalletGate purpose="see your models, payouts and claimable fees">
        <ProviderDashboard />
      </WalletGate>
    </section>
  );
}
