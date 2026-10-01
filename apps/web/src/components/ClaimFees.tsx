import type { Model } from '@ibt/shared';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { skipToken, useQuery } from '@tanstack/react-query';

import { useSendTx, type SendTxStatus } from '../hooks/useSendTx';
import {
  buildClaimTransaction,
  fetchFeeClaimer,
  resolveClaimRole,
  type ClaimRole,
} from '../lib/claims';
import { shortAddress } from '../lib/format';
import { queryKeys } from '../lib/queryKeys';
import { txUrl } from '../lib/solscan';
import { EXTERNAL_LINK } from './ModelStats';

const SECTION_LABEL = 'font-mono text-xs uppercase tracking-label text-ink-400';
const PRIMARY_BUTTON =
  'inline-flex h-10 items-center rounded-sm bg-accent px-4 font-mono text-xs font-medium uppercase tracking-label text-accent-fg transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50';

const ROLE_LABEL: Record<ClaimRole, string> = { creator: 'Creator', partner: 'Platform' };

const TX_PROGRESS: Partial<Record<SendTxStatus, string>> = {
  building: 'Building the claim…',
  signing: 'Approve the claim in your wallet…',
  sending: 'Sending…',
  confirming: 'Confirming on-chain…',
};

function claimSources(role: ClaimRole, graduated: boolean): string[] {
  if (role === 'partner') return ['Partner share of curve trading fees (DBC)'];
  return [
    'Creator share of curve trading fees (DBC)',
    ...(graduated ? ['Fees on your locked DAMM v2 position'] : []),
  ];
}

function useClaimRole(model: Model, wallet: string | null): ClaimRole | null {
  const { connection } = useConnection();
  const dbcPool = model.token.dbcPool;
  const needsConfig = wallet !== null && wallet !== model.providerWallet && dbcPool !== null;
  const feeClaimer = useQuery({
    queryKey: queryKeys.feeClaimer(dbcPool ?? ''),
    queryFn:
      needsConfig && dbcPool !== null
        ? () => fetchFeeClaimer(connection, new PublicKey(dbcPool))
        : skipToken,
    staleTime: Infinity,
  });
  if (wallet === null) return null;
  return resolveClaimRole(wallet, model.providerWallet, feeClaimer.data ?? null);
}

/**
 * Claims trading fees for the connected wallet: the provider as pool creator,
 * the treasury wallet as the config's fee claimer. Renders nothing otherwise.
 */
export function ClaimFees({ model }: { model: Model }) {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const role = useClaimRole(model, wallet);
  const { send, status, signature, error } = useSendTx();
  const { dbcPool, dammV2Pool } = model.token;

  if (role === null || dbcPool === null) return null;

  const graduated = model.token.status === 'graduated' && dammV2Pool !== null;
  const busy = status !== 'idle' && status !== 'confirmed' && status !== 'failed';

  function onClaim(claimRole: ClaimRole, pool: string) {
    void send({
      build: ({ connection, payer }) =>
        buildClaimTransaction(connection, {
          role: claimRole,
          owner: payer,
          dbcPool: new PublicKey(pool),
          dammPool: graduated && dammV2Pool !== null ? new PublicKey(dammV2Pool) : null,
        }),
      invalidate: [],
    });
  }

  return (
    <section
      aria-labelledby={`claim-${model.id}`}
      className="rounded-sm border border-ink-800 bg-ink-900/60 p-6"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={`claim-${model.id}`} className="text-lg font-semibold tracking-tight text-ink-50">
          Claim fees
        </h2>
        <span className="rounded-sm border border-accent/40 px-2 py-0.5 font-mono text-xs uppercase tracking-label text-accent">
          {ROLE_LABEL[role]}
        </span>
      </div>
      <p className={`${SECTION_LABEL} mt-4`}>Included</p>
      <ul className="mt-2 space-y-1.5 text-sm text-ink-200">
        {claimSources(role, graduated).map((source) => (
          <li key={source} className="flex gap-2">
            <span aria-hidden className="text-accent">
              ›
            </span>
            {source}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-ink-400">
        Fees accrue in SOL and are paid to {shortAddress(wallet ?? '')}. Claiming with nothing
        accrued only costs the network fee.
      </p>
      <button
        type="button"
        className={`${PRIMARY_BUTTON} mt-5`}
        disabled={busy}
        onClick={() => onClaim(role, dbcPool)}
      >
        {busy ? 'Claiming…' : 'Claim fees'}
      </button>
      <p aria-live="polite" className="mt-3 min-h-5 font-mono text-xs text-ink-400">
        {TX_PROGRESS[status] ?? ''}
      </p>
      {status === 'confirmed' && signature !== null && (
        <p className="text-sm text-positive">
          Fees claimed:{' '}
          <a
            href={txUrl(signature)}
            target="_blank"
            rel="noopener noreferrer"
            className={EXTERNAL_LINK}
          >
            {shortAddress(signature)}
          </a>
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-negative">
          {error.message}
        </p>
      )}
    </section>
  );
}

/** Token page variant (spec L480): only the model's provider sees it. */
export function OwnerClaimFees({ model }: { model: Model }) {
  const { publicKey } = useWallet();
  if (publicKey?.toBase58() !== model.providerWallet) return null;
  return <ClaimFees model={model} />;
}
