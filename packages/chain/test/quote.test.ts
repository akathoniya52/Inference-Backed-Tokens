import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import type { ChainClient } from '../src/client.js';
import { NATIVE_MINT } from '../src/sdk.js';
import { FAKE_TOKENS_PER_LAMPORT, createFakeChain } from '../src/testing/fake-chain.js';

const keeper = Keypair.generate();
const mint = Keypair.generate().publicKey;
const config = Keypair.generate().publicKey;
const creator = Keypair.generate().publicKey;

describe('fake chain quotes', () => {
  it('quoteCurve mirrors curveBuy at the fixed rate and stops at the curve room', async () => {
    const chain = createFakeChain();
    const pool = chain.addPool({ mint, config, creator });
    chain.migrateWhen(1_000n);
    const client: ChainClient = chain;

    const buy = await client.quoteCurve(pool, { side: 'buy', amount: 400n });
    expect(buy).toEqual({
      amountIn: 400n,
      amountOut: 400n * FAKE_TOKENS_PER_LAMPORT,
      fee: 0n,
      priceImpactPct: null,
    });
    chain.setSol(keeper.publicKey, 400n);
    const bought = await chain.curveBuy(keeper, pool, 400n);
    expect(bought.outAmount).toBe(buy.amountOut);

    const capped = await client.quoteCurve(pool, { side: 'buy', amount: 5_000n });
    expect(capped.amountIn).toBe(600n);

    const sell = await client.quoteCurve(pool, { side: 'sell', amount: 5_000n });
    expect(sell.amountOut).toBe(5_000n / FAKE_TOKENS_PER_LAMPORT);
  });

  it('quoteDamm mirrors dammSwap once graduated and fails before', async () => {
    const chain = createFakeChain();
    const pool = chain.addPool({ mint, config, creator });
    await expect(chain.quoteDamm(mint, { side: 'buy', amount: 10n })).rejects.toThrow(/DAMM/);

    chain.migrateWhen(100n);
    chain.setSol(keeper.publicKey, 100n);
    await chain.curveBuy(keeper, pool, 100n);
    await chain.migrate(keeper, pool);
    await expect(chain.quoteCurve(pool, { side: 'buy', amount: 1n })).rejects.toThrow(/curve/);

    const quote = await chain.quoteDamm(mint, { side: 'buy', amount: 7n });
    chain.setSol(keeper.publicKey, 7n);
    const swap = await chain.dammSwap(keeper, mint, { inputMint: NATIVE_MINT, amountIn: 7n });
    expect(quote).toEqual({
      amountIn: 7n,
      amountOut: swap.outAmount,
      fee: 0n,
      priceImpactPct: 0,
    });
    expect(chain.calls.map((call) => call.method)).toContain('quoteDamm');
  });
});
