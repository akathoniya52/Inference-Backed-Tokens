import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { parseDeposit, type DepositExpectation } from '../src/deposit.js';
import {
  loadDepositFixture,
  type RawDepositTx,
  type RawInstruction,
} from '../src/testing/fixtures.js';

const SENDER_WALLET = '8eLrykPHS4psd74CWCTHM6ohRu8Um9ESQZyjcfktMcQb';
const TREASURY_ATA = 'H5DxSmP8dcxbWdXT95KUtBFbprmvu8zUjFLnmi7MjDpc';
const OTHER_ATA = '6xyDJvCpnH1mZGCe2WVK4fZekpMWZkKPnVpKcDEfoa7Q';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const DEPOSIT_REF = 'dep_7Kq2xV9mPz';

const expected: DepositExpectation = {
  usdcMint: new PublicKey(USDC_DEVNET),
  treasuryAta: new PublicKey(TREASURY_ATA),
  depositRef: DEPOSIT_REF,
  confirmationStatus: 'finalized',
};

const topLevel = (raw: RawDepositTx) => raw.transaction.message.instructions;
const isMemo = (ix: RawInstruction) => ix.program === 'spl-memo';
function transferInfo(ix: RawInstruction | undefined): Record<string, unknown> {
  if (!ix || typeof ix.parsed !== 'object') throw new Error('fixture: not a parsed transfer');
  return ix.parsed.info;
}

describe('parseDeposit', () => {
  it('accepts a top-level transferChecked into the treasury with the right memo', () => {
    const tx = loadDepositFixture('deposit-transfer-checked');
    expect(parseDeposit(tx, expected)).toEqual({
      ok: true,
      amountMicro: 25_000_000n,
      from: SENDER_WALLET,
      memo: DEPOSIT_REF,
      slot: 412345678,
      signature:
        '2nVtp8joXngfD7Frz9g3SDYDZ5EogLd2vwtpj8bTyVmY7tJmu9sS2y8dMc53Luwucfy9K2XuvQZgMg6Csjg6Wfd4',
    });
  });

  it('accepts an inner (CPI) plain transfer, resolving the mint via postTokenBalances', () => {
    const tx = loadDepositFixture('deposit-transfer-inner');
    const result = parseDeposit(tx, expected);
    expect(result).toMatchObject({ ok: true, amountMicro: 10_000_000n, from: SENDER_WALLET });
  });

  it('sums only the transfers whose destination is the treasury ATA', () => {
    const tx = loadDepositFixture('deposit-two-transfers');
    expect(parseDeposit(tx, expected)).toMatchObject({ ok: true, amountMicro: 4_500_000n });
  });

  it('rejects a memo that differs from depositRef', () => {
    const tx = loadDepositFixture('deposit-transfer-checked');
    expect(parseDeposit(tx, { ...expected, depositRef: 'dep_someoneElse' })).toEqual({
      ok: false,
      reason: 'memo_mismatch',
    });
  });

  it('rejects a transaction without a memo instruction', () => {
    const tx = loadDepositFixture('deposit-transfer-checked', (raw) => {
      raw.transaction.message.instructions = topLevel(raw).filter((ix) => !isMemo(ix));
    });
    expect(parseDeposit(tx, expected)).toEqual({ ok: false, reason: 'missing_memo' });
  });

  it('rejects a transferChecked of another mint', () => {
    const tx = loadDepositFixture('deposit-transfer-checked');
    expect(parseDeposit(tx, { ...expected, usdcMint: new PublicKey(USDC_MAINNET) })).toEqual({
      ok: false,
      reason: 'wrong_mint',
    });
  });

  it('rejects a plain transfer whose destination balance is another mint', () => {
    const tx = loadDepositFixture('deposit-transfer-inner', (raw) => {
      for (const balance of raw.meta.postTokenBalances) balance.mint = USDC_MAINNET;
    });
    expect(parseDeposit(tx, expected)).toEqual({ ok: false, reason: 'wrong_mint' });
  });

  it('rejects a transfer to another destination', () => {
    const tx = loadDepositFixture('deposit-transfer-checked');
    expect(parseDeposit(tx, { ...expected, treasuryAta: new PublicKey(OTHER_ATA) })).toEqual({
      ok: false,
      reason: 'wrong_destination',
    });
  });

  it('ignores transfers that are not from the classic SPL Token program', () => {
    const tx = loadDepositFixture('deposit-transfer-checked', (raw) => {
      const transfer = topLevel(raw).find((ix) => ix.program === 'spl-token');
      if (!transfer) throw new Error('fixture: no transfer');
      transfer.programId = TOKEN_2022;
      transfer.program = 'spl-token-2022';
    });
    expect(parseDeposit(tx, expected)).toEqual({ ok: false, reason: 'wrong_destination' });
  });

  it('rejects a failed transaction', () => {
    const tx = loadDepositFixture('deposit-transfer-checked', (raw) => {
      raw.meta.err = { InstructionError: [2, { Custom: 1 }] };
    });
    expect(parseDeposit(tx, expected)).toEqual({ ok: false, reason: 'tx_failed' });
  });

  it('rejects a transaction that is not finalized yet', () => {
    const tx = loadDepositFixture('deposit-transfer-checked');
    expect(parseDeposit(tx, { ...expected, confirmationStatus: 'confirmed' })).toEqual({
      ok: false,
      reason: 'not_finalized',
    });
  });

  it('rejects a zero amount', () => {
    const tx = loadDepositFixture('deposit-transfer-checked', (raw) => {
      const tokenAmount = transferInfo(topLevel(raw)[2]).tokenAmount;
      if (typeof tokenAmount !== 'object' || tokenAmount === null) throw new Error('fixture');
      Object.assign(tokenAmount, { amount: '0', uiAmount: 0, uiAmountString: '0' });
    });
    expect(parseDeposit(tx, expected)).toEqual({ ok: false, reason: 'zero_amount' });
  });

  it('rejects a missing transaction', () => {
    expect(parseDeposit(null, expected)).toEqual({ ok: false, reason: 'tx_not_found' });
  });
});
