import { AppError } from '@ibt/shared';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

import type { ChainClient } from '../src/client.js';
import { FakePriceSource } from '../src/price.js';
import { USDC_MINT } from '../src/sdk.js';
import { ataOf } from '../src/spl.js';
import { createFakeChain, type FakeChainMongo, type FakeChainTx } from '../src/testing.js';
import { loadDepositFixture } from '../src/testing/fixtures.js';

const keeper = Keypair.generate();
const treasury = Keypair.generate();
const provider = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const config = Keypair.generate().publicKey;
const usdc = USDC_MINT.devnet;

function memoryMongo(): FakeChainMongo & { rows: FakeChainTx[] } {
  const rows: FakeChainTx[] = [];
  const matches = (filter: Partial<FakeChainTx>) => (row: FakeChainTx) =>
    Object.entries(filter).every(([k, v]) => row[k as keyof FakeChainTx] === v);
  return {
    rows,
    collection: (name: string) => {
      expect(name).toBe('fakeChainTxs');
      return {
        insertOne: (doc: FakeChainTx) => {
          rows.push(doc);
          return Promise.resolve({ acknowledged: true });
        },
        findOne: (filter: Partial<FakeChainTx>) =>
          Promise.resolve(rows.find(matches(filter)) ?? null),
        find: (filter: Partial<FakeChainTx>) => ({
          toArray: () => Promise.resolve(rows.filter(matches(filter))),
        }),
      };
    },
  };
}

describe('createFakeChain', () => {
  it('is a ChainClient with in-memory balances and recorded calls', async () => {
    const chain = createFakeChain({ priceSource: new FakePriceSource(150), usdcMint: usdc });
    const client: ChainClient = chain;
    chain.setUsdc(treasury.publicKey, 5_000_000n);
    const onSigned = vi.fn();
    const { signature } = await client.transferUsdc(treasury, provider, 2_000_000n, { onSigned });
    expect(onSigned).toHaveBeenCalledWith(signature, expect.any(Number), 'payout');
    expect(await client.usdcBalance(treasury.publicKey)).toBe(3_000_000n);
    expect(await client.usdcBalance(provider)).toBe(2_000_000n);
    expect(await client.signatureStatus(signature)).toBe('landed');
    expect(await client.signatureStatus('nope')).toBe('unknown');
    expect(chain.calls.map((c) => c.method)).toEqual([
      'transferUsdc',
      'usdcBalance',
      'usdcBalance',
      'signatureStatus',
      'signatureStatus',
    ]);
    expect(await chain.priceSource.solUsd()).toBe(150);
  });

  it('invokes onSigned before the tx lands, and a throwing onSigned prevents landing', async () => {
    const chain = createFakeChain({ usdcMint: usdc });
    chain.setUsdc(treasury.publicKey, 1n);
    let landedAtSign: boolean | null = null;
    await chain.transferUsdc(treasury, provider, 1n, {
      onSigned: async (sig) => {
        landedAtSign = (await chain.signatureStatus(sig)) === 'landed';
      },
    });
    expect(landedAtSign).toBe(false);
    await expect(
      chain.transferUsdc(treasury, provider, 1n, {
        onSigned: () => Promise.reject(new Error('x')),
      }),
    ).rejects.toThrow('x');
    expect(chain.txs).toHaveLength(1);
  });

  it('failNext throws chain_send_failed n times without landing', async () => {
    const chain = createFakeChain({ usdcMint: usdc });
    chain.setUsdc(treasury.publicKey, 10n);
    chain.failNext('transferUsdc', 2);
    for (let i = 0; i < 2; i++) {
      const err = await chain.transferUsdc(treasury, provider, 1n).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ code: 'chain_send_failed' });
    }
    await chain.transferUsdc(treasury, provider, 1n);
    expect(chain.txs).toHaveLength(1);
  });

  it('crashAfter signs (onSigned runs) but never lands', async () => {
    const chain = createFakeChain({ usdcMint: usdc });
    chain.setUsdc(treasury.publicKey, 10n);
    chain.crashAfter('transferUsdc');
    let pending = '';
    await expect(
      chain.transferUsdc(treasury, provider, 1n, { onSigned: (s) => void (pending = s) }),
    ).rejects.toThrow(/crash/);
    expect(await chain.signatureStatus(pending)).toBe('unknown');
    expect(await chain.usdcBalance(provider)).toBe(0n);
  });

  it('crashAfterLand records the tx as landed, then throws', async () => {
    const chain = createFakeChain({ usdcMint: usdc });
    chain.setUsdc(treasury.publicKey, 10n);
    chain.crashAfterLand('transferUsdc');
    let pending = '';
    await expect(
      chain.transferUsdc(treasury, provider, 4n, { onSigned: (s) => void (pending = s) }),
    ).rejects.toThrow(/crash/);
    expect(await chain.signatureStatus(pending)).toBe('landed');
    expect(await chain.usdcBalance(provider)).toBe(4n);
    await chain.transferUsdc(treasury, provider, 1n);
    expect(await chain.usdcBalance(provider)).toBe(5n);
  });

  it('runs a curve to completion with migrateWhen, then migrates and trades on DAMM', async () => {
    const chain = createFakeChain({ usdcMint: usdc });
    const pool = chain.addPool({ mint, config, creator: provider });
    chain.migrateWhen(1_000_000_000n);
    chain.setSol(keeper.publicKey, 5_000_000_000n);

    const buy = await chain.curveBuy(keeper, pool, 600_000_000n);
    expect(buy.outAmount).toBeGreaterThan(0n);
    expect((await chain.readPool({ pool }))?.progress).toBe(0.6);
    await chain.curveBuy(keeper, pool, 600_000_000n);
    const complete = await chain.readPool({ mint, config });
    expect(complete).toMatchObject({ progress: 1, isMigrated: false });
    expect(await chain.readDammPool(mint)).toBeNull();

    await chain.migrate(keeper, pool);
    expect((await chain.readPool({ pool }))?.isMigrated).toBe(true);
    expect(await chain.readDammPool(mint)).not.toBeNull();

    const swap = await chain.dammSwap(keeper, mint, {
      inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
      amountIn: 100_000_000n,
    });
    const locked = await chain.addAndLock(keeper, mint, {
      position: null,
      lamports: 100_000_000n,
      maxTokens: swap.outAmount,
    });
    expect(locked.lockSignature).not.toBe(locked.addSignature);
    await chain.claimPositionFee(keeper, mint, locked);
    expect(await chain.tokenBalance(keeper.publicKey, mint)).toBeGreaterThanOrEqual(0n);
    expect(await chain.solBalance(keeper.publicKey)).toBeLessThan(5_000_000_000n);
  });

  it('verifies launches against the stored pool', async () => {
    const chain = createFakeChain({ usdcMint: usdc });
    const pool = chain.addPool({ mint, config, creator: provider });
    await expect(
      chain.verifyLaunch({
        signature: 's',
        mint,
        expectedConfig: config,
        expectedCreator: provider,
      }),
    ).resolves.toEqual({ pool: pool.toBase58() });
    await expect(
      chain.verifyLaunch({
        signature: 's',
        mint,
        expectedConfig: config,
        expectedCreator: keeper.publicKey,
      }),
    ).rejects.toMatchObject({ code: 'pool_mismatch' });
  });

  it('verifies deposits from stored parsed transactions', async () => {
    const chain = createFakeChain({ usdcMint: usdc });
    const tx = loadDepositFixture('deposit-transfer-checked');
    const signature = tx.transaction.signatures[0] ?? '';
    chain.setParsedTx(signature, tx);
    expect(await chain.getParsedTx(signature)).toBe(tx);
    const result = await chain.verifyDeposit('missing', {
      treasuryAta: ataOf(treasury.publicKey, usdc),
      depositRef: 'x',
    });
    expect(result).toEqual({ ok: false, reason: 'tx_not_found' });
  });

  it('persists landed txs to fakeChainTxs and answers signatureStatus from a fresh instance', async () => {
    const mongo = memoryMongo();
    const first = createFakeChain({ mongo, usdcMint: usdc });
    first.setUsdc(treasury.publicKey, 10n);
    const { signature } = await first.transferUsdc(treasury, provider, 3n, {
      settlementRef: 'settlement-1',
    });
    expect(mongo.rows).toEqual([
      {
        signature,
        method: 'transferUsdc',
        from: treasury.publicKey.toBase58(),
        to: provider.toBase58(),
        amount: '3',
        mint: usdc.toBase58(),
        settlementRef: 'settlement-1',
        ts: expect.any(Date) as Date,
      },
    ]);

    const restarted = createFakeChain({ mongo, usdcMint: usdc });
    expect(await restarted.signatureStatus(signature)).toBe('landed');
    expect(await restarted.signatureStatus('unknown-sig')).toBe('unknown');
    expect(await restarted.landedTxs({ settlementRef: 'settlement-1' })).toHaveLength(1);
  });
});
