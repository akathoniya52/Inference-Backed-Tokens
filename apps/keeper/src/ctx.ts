import type { ChainClient, PriceSource } from '@ibt/chain';
import type { Alerter } from '@ibt/shared/node';
import type { Signer } from '@solana/web3.js';
import type { Logger } from 'pino';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface KeeperConfig {
  /** Provider payouts below this accrue as carry-over (L176). */
  minPayoutMicroUsdc: bigint;
  /** `MAX_PAYOUT_USDC_PER_RUN`; the excess carries over (G18). */
  maxPayoutMicroUsdc: bigint;
  /** `MAX_SLICE_SOL_PER_RUN` in lamports (G18). */
  maxSliceLamports: bigint;
  /** Wait between `signatureStatus` checks on an unresolved `pendingTx` (G20). */
  pendingTxPollMs: number;
  /** Checks before an unresolved, unexpired `pendingTx` fails the step (retried by the engine). */
  pendingTxMaxPolls: number;
}

/** The keeper lease as a settlement run sees it: checked before every chain send. */
export interface LeaseGuard {
  /** False once the lease is lost, released or not renewed within its TTL. */
  isHeld(): boolean;
  /** Fencing token of this tenure, above every earlier holder's; `null` while not held. */
  epoch(): number | null;
}

/** What one run may still pay providers (`MAX_PAYOUT_USDC_PER_RUN` across all models). */
export interface PayoutBudget {
  remainingMicroUsdc: bigint;
  /** Settlements whose payout this run already charged (at reservation or at send). */
  charged: Set<string>;
}

/** Everything a keeper job or settlement step needs; tests build it with `makeKeeperCtx()`. */
export interface KeeperCtx {
  chain: ChainClient;
  price: PriceSource;
  clock: Clock;
  logger: Logger;
  alerter: Alerter;
  /** Signs SOL float spends, buys, locks and migration cranks. */
  keeper: Signer;
  /** Signs USDC payouts from the treasury. */
  treasury: Signer;
  config: KeeperConfig;
  /** Current block height, compared against `pendingTx.lastValidBlockHeight` (G20). */
  blockHeight(): Promise<number>;
  sleep(ms: number): Promise<void>;
  /** The lease guarding settlement runs; unset only in tests that drive steps directly. */
  lease?: LeaseGuard;
  /** Set per run by the orchestrator; without it only the per-model payout cap applies. */
  payoutBudget?: PayoutBudget;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
