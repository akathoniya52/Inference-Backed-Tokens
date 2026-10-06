import type { Model } from '@ibt/shared';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { skipToken, useQuery } from '@tanstack/react-query';

import { useSendTx, type SendTxStatus } from '../hooks/useSendTx';
import {
  buildClaimTransaction,
  fetchFeeClaimer,
  resolveClaimRoles,
  type ClaimRole,
} from '../lib/claims';
import { shortAddress } from '../lib/format';
import { queryKeys } from '../lib/queryKeys';
import { parsePublicKey } from '../lib/solana';
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

const NO_ROLES: ClaimRole[] = [];

function useClaimRoles(model: Model, wallet: string | null): ClaimRole[] {
  const { connection } = useConnection();
  const dbcPool = parsePublicKey(model.token.dbcPool);
  // Fetched for the provider too: the treasury may also be the config's fee claimer.
  const feeClaimer = useQuery({
    queryKey: queryKeys.feeClaimer(dbcPool?.toBase58() ?? ''),
    queryFn:
      wallet !== null && dbcPool !== null ? () => fetchFeeClaimer(connection, dbcPool) : skipToken,
    staleTime: Infinity,
  });
  if (wallet === null || dbcPool === null) return NO_ROLES;
  return resolveClaimRoles(wallet, model.providerWallet, feeClaimer.data ?? null);
}

/**
 * Claims trading fees for the connected wallet: the provider as pool creator,
 * the treasury wallet as the config's fee claimer, or both. Renders nothing for
 * a wallet that holds neither role.
 */
export function ClaimFees({ model }: { model: Model }) {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const roles = useClaimRoles(model, wallet);
  if (wallet === null || roles.length === 0) return null;
  return (
    <div className="space-y-6">
      {roles.map((role) => (
        <ClaimPanel key={role} model={model} role={role} wallet={wallet} />
      ))}
    </div>
  );
}

function ClaimPanel({ model, role, wallet }: { model: Model; role: ClaimRole; wallet: string }) {
  const { send, status, signature, error } = useSendTx();
  const { dbcPool, dammV2Pool } = model.token;
  const graduated = model.token.status === 'graduated' && dammV2Pool !== null;
  const busy = status !== 'idle' && status !== 'confirmed' && status !== 'failed';
  const headingId = `claim-${model.id}-${role}`;

  function onClaim() {
    const pool = parsePublicKey(dbcPool);
    if (pool === null) return;
    const dammPool = graduated ? parsePublicKey(dammV2Pool) : null;
    void send({
      build: ({ connection, payer }) =>
        buildClaimTransaction(connection, { role, owner: payer, dbcPool: pool, dammPool }),
      invalidate: [],
    });
  }

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-sm border border-ink-800 bg-ink-900/60 p-6"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-lg font-semibold tracking-tight text-ink-50">
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
        Fees accrue in SOL and are paid to {shortAddress(wallet)}. Claiming with nothing accrued
        only costs the network fee.
      </p>
      <button type="button" className={`${PRIMARY_BUTTON} mt-5`} disabled={busy} onClick={onClaim}>
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
