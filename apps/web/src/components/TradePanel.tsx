import { parseUnits, type Model } from '@ibt/shared';
import { useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { useQuote } from '../hooks/useQuote';
import { useSendTx, type SendTxStatus } from '../hooks/useSendTx';
import { formatPct, formatUnits, shortAddress } from '../lib/format';
import { publicQueryKeys } from '../lib/queries';
import { txUrl } from '../lib/solscan';
import {
  buildTradeTransaction,
  inputDecimals,
  outputDecimals,
  type TradeSide,
  type TradeTarget,
} from '../lib/trade';
import { EXTERNAL_LINK } from './ModelStats';

export const SLIPPAGE_OPTIONS_BPS = [50, 100, 300] as const;
export const DEFAULT_SLIPPAGE_BPS = 100;
export const QUOTE_DEBOUNCE_MS = 250;
const HIGH_PRICE_IMPACT_WARNING = 0.05;

const SECTION_LABEL = 'font-mono text-xs uppercase tracking-label text-ink-400';
const PRIMARY_BUTTON =
  'inline-flex h-11 w-full items-center justify-center rounded-sm bg-accent px-4 font-mono text-xs font-medium uppercase tracking-label text-accent-fg transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50';

const TX_PROGRESS: Partial<Record<SendTxStatus, string>> = {
  building: 'Fetching a fresh quote and building the swap…',
  signing: 'Approve the swap in your wallet…',
  sending: 'Sending…',
  confirming: 'Confirming on-chain…',
};

export function tradeTarget(model: Model): TradeTarget | null {
  const { token } = model;
  if (token.status === 'curve' && token.dbcPool !== null && token.mint !== null) {
    return { phase: 'curve', pool: new PublicKey(token.dbcPool), mint: new PublicKey(token.mint) };
  }
  if (token.status === 'graduated' && token.dammV2Pool !== null && token.mint !== null) {
    return {
      phase: 'graduated',
      pool: new PublicKey(token.dammV2Pool),
      mint: new PublicKey(token.mint),
    };
  }
  return null;
}

function parseAmount(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const amount = parseUnits(trimmed, decimals);
    return amount > 0n ? amount : null;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function QuoteRow({
  label,
  value,
  tone = 'text-ink-50',
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-xs text-ink-400">{label}</dt>
      <dd className={`font-mono text-sm tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}

export function TradePanel({ model }: { model: Model }) {
  const target = useMemo(() => tradeTarget(model), [model]);
  const { publicKey } = useWallet();
  const { send, status, error, signature, reset } = useSendTx();
  const [side, setSide] = useState<TradeSide>('buy');
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);

  const symbol = model.token.symbol ?? 'TOKEN';
  const inUnit = side === 'buy' ? 'SOL' : `$${symbol}`;
  const outUnit = side === 'buy' ? `$${symbol}` : 'SOL';
  const amountIn = parseAmount(amount, inputDecimals(side));
  const invalid = amount.trim() !== '' && amountIn === null;
  const debouncedAmount = useDebounced(amountIn, QUOTE_DEBOUNCE_MS);
  const quote = useQuote(target, side, debouncedAmount, slippageBps);
  const fresh = quote.data !== undefined && debouncedAmount === amountIn;
  const busy = status !== 'idle' && status !== 'confirmed' && status !== 'failed';

  const hint =
    target === null
      ? 'Trading opens once this token has a live pool.'
      : publicKey === null
        ? 'Connect a wallet to trade.'
        : null;

  function switchSide(next: TradeSide) {
    setSide(next);
    setAmount('');
    reset();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (target === null || amountIn === null || !fresh) return;
    const order = { side, amountIn, slippageBps, minOut: quote.data.minOut };
    void send({
      build: ({ connection, payer }) => buildTradeTransaction(connection, payer, target, order),
      invalidate: model.token.mint
        ? [
            publicQueryKeys.tokenState(model.token.mint),
            publicQueryKeys.model(model.slug),
            ['quote'],
          ]
        : [publicQueryKeys.model(model.slug)],
    }).then((outcome) => {
      if (outcome.ok) setAmount('');
      else void quote.refetch();
    });
  }

  return (
    <section
      aria-labelledby="trade-heading"
      className="rounded-sm border border-ink-800 bg-ink-900/60 p-6"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="trade-heading" className="text-lg font-semibold tracking-tight text-ink-50">
          Trade ${symbol}
        </h2>
        {target !== null && (
          <span className={SECTION_LABEL}>
            {target.phase === 'curve' ? 'Meteora DBC' : 'DAMM v2'}
          </span>
        )}
      </div>

      <div
        role="group"
        aria-label="Trade side"
        className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-ink-800 bg-ink-800"
      >
        {(['buy', 'sell'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={side === option}
            onClick={() => switchSide(option)}
            className={`h-9 font-mono text-xs uppercase tracking-label transition-colors ${
              side === option
                ? option === 'buy'
                  ? 'bg-positive/15 text-positive'
                  : 'bg-negative/15 text-negative'
                : 'bg-ink-950 text-ink-400 hover:text-ink-200'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <form noValidate className="mt-5" onSubmit={onSubmit}>
        <label htmlFor="trade-amount" className={SECTION_LABEL}>
          {side === 'buy' ? 'You pay' : 'You sell'}
        </label>
        <div className="mt-2 flex h-12 items-center rounded-sm border border-ink-800 bg-ink-950 focus-within:border-accent aria-[invalid=true]:border-negative">
          <input
            id="trade-amount"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder="0.0"
            value={amount}
            disabled={target === null}
            aria-invalid={invalid}
            onChange={(e) => setAmount(e.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-lg tabular-nums text-ink-50 placeholder:text-ink-600 focus:outline-none disabled:cursor-not-allowed"
          />
          <span className="pr-3 font-mono text-xs text-ink-400">{inUnit}</span>
        </div>
        {invalid && (
          <p className="mt-1.5 text-xs text-negative">
            Enter a positive amount with at most {inputDecimals(side)} decimals.
          </p>
        )}

        <fieldset className="mt-5">
          <legend className={SECTION_LABEL}>Slippage</legend>
          <div className="mt-2 flex gap-2">
            {SLIPPAGE_OPTIONS_BPS.map((bps) => (
              <button
                key={bps}
                type="button"
                aria-pressed={slippageBps === bps}
                onClick={() => setSlippageBps(bps)}
                className={`h-8 flex-1 rounded-sm border font-mono text-xs tabular-nums transition-colors ${
                  slippageBps === bps
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-ink-800 text-ink-400 hover:border-ink-600 hover:text-ink-200'
                }`}
              >
                {formatPct(bps / 10_000)}
              </button>
            ))}
          </div>
        </fieldset>

        <dl
          aria-label="Quote"
          aria-busy={quote.isFetching}
          className="mt-5 divide-y divide-ink-800 border-y border-ink-800"
        >
          {quote.isError ? (
            <p role="alert" className="py-3 text-sm text-negative">
              Could not quote this trade: {quote.error.message}
            </p>
          ) : fresh ? (
            <>
              <QuoteRow
                label="You receive"
                value={`≈ ${formatUnits(quote.data.amountOut, outputDecimals(side), 6)} ${outUnit}`}
              />
              <QuoteRow
                label="Minimum received"
                value={`${formatUnits(quote.data.minOut, outputDecimals(side), 6)} ${outUnit}`}
              />
              <QuoteRow
                label="Price impact"
                value={quote.data.priceImpact === null ? '—' : formatPct(quote.data.priceImpact, 2)}
                tone={
                  quote.data.priceImpact !== null &&
                  quote.data.priceImpact > HIGH_PRICE_IMPACT_WARNING
                    ? 'text-negative'
                    : 'text-ink-50'
                }
              />
            </>
          ) : (
            <p className="py-3 font-mono text-xs text-ink-600">
              {amountIn !== null && target !== null
                ? 'Quoting…'
                : 'Enter an amount to see a quote.'}
            </p>
          )}
        </dl>

        <p className="mt-4 text-xs leading-relaxed text-ink-400">
          Keep about <span className="font-mono text-ink-200">0.01 SOL</span> extra for network fees
          and token account rent. The pool fee is taken from the swap and shared by the creator, the
          platform and Meteora.
        </p>

        <button
          type="submit"
          className={`${PRIMARY_BUTTON} mt-5`}
          disabled={hint !== null || !fresh || busy}
        >
          {busy ? 'Working…' : `${side === 'buy' ? 'Buy' : 'Sell'} $${symbol}`}
        </button>

        <p aria-live="polite" className="mt-3 min-h-5 font-mono text-xs text-ink-400">
          {hint ?? TX_PROGRESS[status] ?? ''}
        </p>
        {status === 'confirmed' && signature !== null && (
          <p className="text-sm text-positive">
            Swap confirmed:{' '}
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
      </form>
    </section>
  );
}
