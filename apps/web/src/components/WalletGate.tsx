import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import type { ReactNode } from 'react';

import { useSession, useSessionWalletSync, useSignIn, type SignInStatus } from '../hooks/useAuth';
import { shortAddress } from '../lib/format';

const PRIMARY_BUTTON =
  'inline-flex h-9 items-center rounded-sm bg-accent px-4 font-mono text-xs font-medium uppercase tracking-label text-accent-fg transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50';

const PROGRESS: Partial<Record<SignInStatus, string>> = {
  requesting: 'Requesting a sign-in nonce…',
  signing: 'Approve the message in your wallet…',
  verifying: 'Verifying signature…',
};

interface WalletGateProps {
  children: ReactNode;
  /** What signing in unlocks, shown in the panel. */
  purpose?: string;
}

/**
 * Renders `children` only for a signed-in wallet. The signature is free (no
 * transaction) and the session lives in memory for this tab only.
 */
export function WalletGate({ children, purpose = 'manage your account' }: WalletGateProps) {
  useSessionWalletSync();
  const session = useSession();
  const { publicKey, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  const { signIn, status, error } = useSignIn();
  const wallet = publicKey?.toBase58() ?? null;

  if (session !== null && wallet !== null && session.wallet === wallet) return <>{children}</>;

  const busy = status === 'requesting' || status === 'signing' || status === 'verifying';

  return (
    <section
      aria-labelledby="wallet-gate-title"
      className="mt-10 max-w-xl rounded-sm border border-ink-800 bg-ink-900 p-6 sm:p-8"
    >
      <p className="font-mono text-xs uppercase tracking-label text-accent">Wallet sign-in</p>
      <h2 id="wallet-gate-title" className="mt-3 text-xl font-semibold tracking-tight text-ink-50">
        Sign in with wallet
      </h2>
      <p className="mt-2 text-sm text-ink-400">
        Sign a one-time message to {purpose}. It is not a transaction and costs nothing. The session
        lasts until you disconnect or reload.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        {wallet === null ? (
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={connecting}
            onClick={() => setVisible(true)}
          >
            {connecting ? 'Connecting…' : 'Connect wallet'}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={busy}
              onClick={() => void signIn()}
            >
              Sign in with wallet
            </button>
            <span className="font-mono text-xs text-ink-400" title={wallet}>
              {shortAddress(wallet)}
            </span>
          </>
        )}
      </div>

      <p aria-live="polite" className="mt-4 min-h-5 font-mono text-xs text-ink-400">
        {PROGRESS[status] ?? ''}
      </p>
      {error !== null && (
        <p role="alert" className="mt-1 text-sm text-negative">
          {error}
        </p>
      )}
    </section>
  );
}
