import { useConnection } from '@solana/wallet-adapter-react';
import { skipToken, useQuery } from '@tanstack/react-query';

import { quoteTrade, type TradeSide, type TradeTarget } from '../lib/trade';

export const QUOTE_REFETCH_MS = 15_000;

export const quoteKeys = {
  quote: (target: TradeTarget | null, side: TradeSide, amountIn: bigint | null, bps: number) =>
    [
      'quote',
      target?.phase ?? null,
      target?.pool.toBase58() ?? null,
      side,
      amountIn?.toString() ?? null,
      bps,
    ] as const,
};

/** Live quote for `amountIn`; idle until there is a pool and a positive amount. */
export function useQuote(
  target: TradeTarget | null,
  side: TradeSide,
  amountIn: bigint | null,
  slippageBps: number,
) {
  const { connection } = useConnection();
  const ready = target !== null && amountIn !== null && amountIn > 0n;
  return useQuery({
    queryKey: quoteKeys.quote(target, side, amountIn, slippageBps),
    queryFn: ready
      ? () => quoteTrade(connection, target, { side, amountIn, slippageBps })
      : skipToken,
    refetchInterval: QUOTE_REFETCH_MS,
    retry: false,
  });
}
