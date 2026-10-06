import type { SettlementDoc } from '@ibt/db';

import type { SettlementOutcome } from './orchestrator.js';

const str = (value: bigint | null | undefined): string | null =>
  value == null ? null : value.toString();

/** JSON-safe view of a settlement: BigInt amounts become decimal strings. */
export function settlementSummary(settlement: SettlementDoc) {
  const { provider, liquidity } = settlement;
  return {
    settlementId: settlement._id.toHexString(),
    periodStart: settlement.periodStart.toISOString(),
    state: settlement.state,
    lastCompletedState: settlement.lastCompletedState ?? null,
    attempts: settlement.attempts,
    error: settlement.error ?? null,
    revenueMicroUsdc: settlement.revenueMicroUsdc.toString(),
    requestCount: settlement.requestCount,
    platformMicroUsdc: settlement.platformMicroUsdc.toString(),
    providerMicroUsdc: provider.amountMicroUsdc.toString(),
    providerCarryOverMicroUsdc: provider.carryOverMicroUsdc.toString(),
    providerTx: provider.txSignature ?? null,
    liquidity: {
      phase: liquidity.phase,
      sliceMicroUsdc: liquidity.sliceMicroUsdc.toString(),
      solPriceUsdc: liquidity.solPriceUsdc ?? null,
      solLamports: str(liquidity.solLamports),
      solAddedLamports: str(liquidity.solAddedLamports),
      tokensBaseUnits: str(liquidity.tokensBaseUnits),
      buyTx: liquidity.buyTxSignature ?? null,
      swapTx: liquidity.swapTxSignature ?? null,
      migrationTx: liquidity.migrationSignature ?? null,
      addTx: liquidity.addTxSignature ?? null,
      lockTx: liquidity.lockTxSignature ?? null,
      claimTx: liquidity.claimTxSignature ?? null,
    },
  };
}

export const outcomeSummary = (outcome: SettlementOutcome) =>
  'skipped' in outcome || 'error' in outcome
    ? outcome
    : { model: outcome.model, resumed: outcome.resumed, ...settlementSummary(outcome.settlement) };
