import {
  DepositResponseSchema,
  ErrorEnvelopeSchema,
  UsdcInputSchema,
  usdcStringToMicro,
  type DepositRequest,
  type DepositResponse,
} from '@ibt/shared';
import { useWallet } from '@solana/wallet-adapter-react';
import { useState, type FormEvent } from 'react';

import { useSendTx } from '../hooks/useSendTx';
import { apiFetch, isApiError } from '../lib/api';
import { formatUsdc } from '../lib/format';
import { buildDepositTransaction } from '../lib/solana';

export const DEPOSIT_POLL_INTERVAL_MS = 5_000;
export const DEPOSIT_POLL_ATTEMPTS = 24;

export type DepositPhase = 'idle' | 'signing' | 'pending' | 'credited' | 'error';

type DepositResult =
  { kind: 'credited'; data: DepositResponse } | { kind: 'already_credited' } | { kind: 'timeout' };

function isPendingBody(body: unknown): boolean {
  const envelope = ErrorEnvelopeSchema.safeParse(body);
  if (envelope.success) return envelope.data.error.code === 'deposit_pending';
  if (typeof body !== 'object' || body === null) return false;
  return Object.values(body).includes('deposit_pending');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Posts the signature until the api has seen it finalized. A 202
 * `deposit_pending` is retried every 5 s for ~2 min (P3-T7); anything else
 * that is not a credit is thrown.
 */
async function pollDeposit(txSignature: string): Promise<DepositResult> {
  const body: DepositRequest = { txSignature };
  for (let attempt = 0; attempt < DEPOSIT_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(DEPOSIT_POLL_INTERVAL_MS);
    let response: unknown;
    try {
      response = await apiFetch('/api/billing/deposits', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (isApiError(error) && error.code === 'deposit_already_credited') {
        return { kind: 'already_credited' };
      }
      if (isApiError(error) && error.code === 'deposit_pending') continue;
      throw error;
    }
    const credited = DepositResponseSchema.safeParse(response);
    if (credited.success) return { kind: 'credited', data: credited.data };
    if (!isPendingBody(response)) throw new Error('Unexpected response from the deposit endpoint.');
  }
  return { kind: 'timeout' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Deposit failed.';
}

const INPUT =
  'h-10 w-full rounded-sm border border-ink-800 bg-ink-950 px-3 font-mono text-sm text-ink-50 placeholder:text-ink-600 focus:border-accent focus:outline-none';
const PRIMARY_BUTTON =
  'inline-flex h-10 items-center rounded-sm bg-accent px-4 font-mono text-xs font-medium uppercase tracking-label text-accent-fg transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50';
const GHOST_BUTTON =
  'inline-flex h-9 items-center rounded-sm border border-ink-800 px-3 font-mono text-xs uppercase tracking-label text-ink-200 transition-colors hover:border-ink-600 hover:text-ink-50';

interface DepositUsdcProps {
  depositRef: string;
}

export function DepositUsdc({ depositRef }: DepositUsdcProps) {
  const { publicKey } = useWallet();
  const { send } = useSendTx();
  const [amount, setAmount] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [phase, setPhase] = useState<DepositPhase>('idle');
  const [signature, setSignature] = useState<string | null>(null);
  const [credited, setCredited] = useState<DepositResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  function settle(result: DepositResult) {
    if (result.kind === 'timeout') {
      setError(
        'The deposit is still not final after two minutes. It will be credited once it is; check again shortly.',
      );
      setPhase('error');
      return;
    }
    setCredited(result.kind === 'credited' ? result.data : null);
    setPhase('credited');
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = UsdcInputSchema.safeParse(amount.trim());
    const amountMicro = parsed.success ? usdcStringToMicro(parsed.data) : 0n;
    if (amountMicro <= 0n) {
      setFieldError('Enter a USDC amount greater than 0, with up to 6 decimals.');
      return;
    }
    setFieldError(null);
    setError(null);
    setCredited(null);
    setSignature(null);
    setPhase('signing');

    const outcome = await send<DepositResult>({
      build: ({ payer }) =>
        Promise.resolve(buildDepositTransaction({ owner: payer, amountMicro, depositRef })),
      onConfirmed: (sig) => {
        setSignature(sig);
        setPhase('pending');
        return pollDeposit(sig);
      },
      invalidate: [['me'], ['ledger']],
    });
    if (outcome.signature) setSignature(outcome.signature);
    if (!outcome.ok) {
      setError(outcome.error.message);
      setPhase('error');
      return;
    }
    if (outcome.result) settle(outcome.result);
  }

  async function checkAgain(sig: string) {
    setError(null);
    setPhase('pending');
    try {
      settle(await pollDeposit(sig));
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase('error');
    }
  }

  const busy = phase === 'signing' || phase === 'pending';

  return (
    <section
      aria-labelledby="deposit-title"
      className="rounded-sm border border-ink-800 bg-ink-900 p-6"
    >
      <h2 id="deposit-title" className="text-lg font-semibold tracking-tight text-ink-50">
        Deposit USDC
      </h2>
      <p className="mt-1 text-sm text-ink-400">
        Sends USDC to the treasury with your deposit reference{' '}
        <span className="font-mono text-ink-200">{depositRef}</span> as the memo. Credit lands once
        the transfer is finalized.
      </p>

      <form className="mt-5 flex flex-wrap items-start gap-3" onSubmit={(e) => void onSubmit(e)}>
        <div className="min-w-0 flex-1">
          <label htmlFor="deposit-amount" className="sr-only">
            Amount in USDC
          </label>
          <input
            id="deposit-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="25.00"
            className={INPUT}
            value={amount}
            disabled={busy}
            aria-invalid={fieldError !== null}
            aria-describedby={fieldError ? 'deposit-amount-error' : undefined}
            onChange={(e) => setAmount(e.target.value)}
          />
          {fieldError !== null && (
            <p id="deposit-amount-error" className="mt-2 text-sm text-negative">
              {fieldError}
            </p>
          )}
        </div>
        <button type="submit" className={PRIMARY_BUTTON} disabled={busy || publicKey === null}>
          Deposit
        </button>
      </form>

      <div aria-live="polite" className="mt-4 text-sm" data-phase={phase}>
        {phase === 'signing' && (
          <p className="text-ink-400">Approve the transfer in your wallet…</p>
        )}
        {phase === 'pending' && (
          <p className="text-ink-400">
            Transfer confirmed. Waiting for it to finalize before crediting…
          </p>
        )}
        {phase === 'credited' && (
          <p className="text-positive">
            {credited
              ? `Credited ${formatUsdc(usdcStringToMicro(credited.amountUsdc))} USDC. Balance ${formatUsdc(usdcStringToMicro(credited.balanceUsdc))} USDC.`
              : 'This deposit was already credited.'}
          </p>
        )}
        {signature !== null && (
          <p className="mt-1 break-all font-mono text-xs text-ink-600">Signature {signature}</p>
        )}
      </div>
      {phase === 'error' && error !== null && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
          {signature !== null && (
            <button
              type="button"
              className={GHOST_BUTTON}
              onClick={() => void checkAgain(signature)}
            >
              Check again
            </button>
          )}
        </div>
      )}
    </section>
  );
}
