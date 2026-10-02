import type { Model, TokenStateResponse } from '@ibt/shared';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';

import { OwnerClaimFees } from '../components/ClaimFees';
import { CopyButton } from '../components/CodeBlock';
import { CurveProgress } from '../components/CurveProgress';
import { formatMTokPrice, PhaseBadge } from '../components/ModelCard';
import { AddressLink, EXTERNAL_LINK, ModelStats } from '../components/ModelStats';
import { SettlementTable } from '../components/SettlementTable';
import { TradePanel } from '../components/TradePanel';
import { isApiError } from '../lib/api';
import { shortAddress } from '../lib/format';
import { useModel, useTokenState } from '../lib/queries';
import { txUrl } from '../lib/solscan';

export interface TokenSlotContext {
  model: Model;
  state: TokenStateResponse | undefined;
}

type Slot = (context: TokenSlotContext) => ReactNode;

interface TokenPageProps {
  /** Replaces the default `TradePanel`; tests inject a stub. */
  tradePanel?: Slot;
  /** Replaces the default owner-only `ClaimFees`; tests inject a stub. */
  claimFees?: Slot;
}

const defaultTradePanel: Slot = ({ model }) => <TradePanel model={model} />;
const defaultClaimFees: Slot = ({ model }) => <OwnerClaimFees model={model} />;

const SECTION_LABEL = 'font-mono text-xs uppercase tracking-label text-ink-400';
const PANEL = 'rounded-sm border border-ink-800 bg-ink-900/60 p-6';

function TokenHeading({ slug }: { slug: string }) {
  return (
    <h1 className="page-title">
      Token <span className="font-mono text-accent">{slug}</span>
    </h1>
  );
}

function PhasePanel({ model }: { model: Model }) {
  const { token } = model;

  if (token.status === 'curve' && token.mint !== null) {
    return (
      <section aria-label="Bonding curve" className={PANEL}>
        <CurveProgress mint={token.mint} />
        <p className="mt-4 text-sm text-ink-400">
          Twenty percent of every settled hour of inference revenue buys this token on the curve. At
          the threshold the pool migrates to Meteora DAMM v2 and the keeper&apos;s position is
          locked permanently.
        </p>
      </section>
    );
  }

  if (token.status === 'graduated' && token.dammV2Pool !== null) {
    return (
      <section aria-label="Graduated" className={PANEL}>
        <p className={SECTION_LABEL}>Graduated to DAMM v2</p>
        <dl className="mt-4 grid gap-4 font-mono text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-ink-400">Pool</dt>
            <dd className="mt-1">
              <AddressLink address={token.dammV2Pool} label="DAMM v2 pool on Solscan" />
            </dd>
          </div>
          {token.migrationSignature !== null && (
            <div>
              <dt className="text-xs text-ink-400">Migration</dt>
              <dd className="mt-1">
                <a
                  href={txUrl(token.migrationSignature)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Migration transaction"
                  title={token.migrationSignature}
                  className={EXTERNAL_LINK}
                >
                  {shortAddress(token.migrationSignature)}
                </a>
              </dd>
            </div>
          )}
        </dl>
        <p className="mt-4 text-sm text-ink-400">
          Each hourly liquidity slice is now added to the keeper&apos;s DAMM v2 position and
          permanently locked.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Token" className={PANEL}>
      <p className="font-medium text-ink-50">
        {token.status === 'pending' ? 'Launch pending confirmation' : 'No token launched yet'}
      </p>
      <p className="mt-2 text-sm text-ink-400">
        {token.status === 'pending'
          ? 'The provider signed a launch; the pool appears here once the API verifies it on-chain.'
          : 'Until the provider launches a token, the provider receives 90% of revenue and the platform 10%.'}
      </p>
    </section>
  );
}

export function TokenPage({
  tradePanel = defaultTradePanel,
  claimFees = defaultClaimFees,
}: TokenPageProps = {}) {
  const { slug = '' } = useParams<{ slug: string }>();
  const model = useModel(slug);
  const token = model.data?.token;
  const live = token !== undefined && (token.status === 'curve' || token.status === 'graduated');
  const mint = live ? token.mint : null;
  const state = useTokenState(mint);

  if (model.isPending) {
    return (
      <section>
        <TokenHeading slug={slug} />
        <div role="status" aria-label="Loading model" className="mt-10 animate-pulse space-y-4">
          <div className="h-24 rounded-sm bg-ink-900" />
          <div className="h-40 rounded-sm bg-ink-900" />
        </div>
      </section>
    );
  }

  if (model.isError) {
    if (isApiError(model.error) && model.error.status === 404) {
      return (
        <section>
          <h1 className="page-title">Model not found</h1>
          <p className="page-lede">
            No model is registered as <span className="font-mono text-ink-200">{slug}</span>.
          </p>
          <Link
            to="/"
            className="mt-6 inline-block font-mono text-xs uppercase tracking-label text-accent"
          >
            Back to Explore
          </Link>
        </section>
      );
    }
    return (
      <section>
        <TokenHeading slug={slug} />
        <div
          role="alert"
          className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-sm border border-negative/40 bg-negative/10 p-5"
        >
          <div>
            <p className="font-medium text-ink-50">Could not load this model</p>
            <p className="mt-1 font-mono text-xs text-ink-400">{model.error.message}</p>
          </div>
          <button
            type="button"
            onClick={() => void model.refetch()}
            className="inline-flex h-9 items-center rounded-sm border border-ink-600 px-4 font-mono text-xs uppercase tracking-label text-ink-200 transition-colors hover:border-accent hover:text-accent"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  const data = model.data;
  const context: TokenSlotContext = { model: data, state: state.data };

  return (
    <section>
      <header className="border-b border-ink-800 pb-8">
        <p className="font-mono text-xs text-ink-400">{data.slug}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="page-title">{data.name}</h1>
          {data.token.symbol !== null && (
            <span className="font-mono text-lg text-accent">${data.token.symbol}</span>
          )}
          <PhaseBadge status={data.token.status} />
        </div>
        {data.description !== '' && <p className="page-lede">{data.description}</p>}
        <dl className="mt-6 flex flex-wrap gap-x-10 gap-y-4 font-mono text-sm">
          {data.token.mint !== null && (
            <div>
              <dt className={SECTION_LABEL}>Mint</dt>
              <dd className="mt-1 flex items-center gap-2">
                <AddressLink
                  address={data.token.mint}
                  label={`Mint ${shortAddress(data.token.mint)} on Solscan`}
                />
                <CopyButton value={data.token.mint} label="Copy mint address" />
              </dd>
            </div>
          )}
          <div>
            <dt className={SECTION_LABEL}>Provider</dt>
            <dd className="mt-1 flex h-7 items-center">
              <AddressLink address={data.providerWallet} />
            </dd>
          </div>
          <div>
            <dt className={SECTION_LABEL}>Price / 1M tokens</dt>
            <dd className="mt-1 flex h-7 items-center tabular-nums text-ink-50">
              {formatMTokPrice(data.pricing.inputPerMTokUsdc)} in ·{' '}
              {formatMTokPrice(data.pricing.outputPerMTokUsdc)} out
            </dd>
          </div>
        </dl>
      </header>

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <PhasePanel model={data} />
          <ModelStats model={data} state={state.data} />
        </div>
        <aside className="space-y-6">
          <div data-slot="trade-panel">{tradePanel?.(context)}</div>
          <div data-slot="claim-fees">{claimFees?.(context)}</div>
        </aside>
      </div>

      {mint !== null && (
        <section aria-labelledby="settlements-heading" className="mt-12">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2
              id="settlements-heading"
              className="text-xl font-semibold tracking-tight text-ink-50"
            >
              Settlement ledger
            </h2>
            <p className="text-sm text-ink-400">
              Hourly revenue split 70 / 20 / 10, every step signed on-chain.
            </p>
          </div>
          <SettlementTable mint={mint} />
        </section>
      )}
    </section>
  );
}
