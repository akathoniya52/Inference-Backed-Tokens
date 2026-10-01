import { randomBytes } from 'node:crypto';

import { FAKE_TOKENS_PER_LAMPORT } from '@ibt/chain/testing';
import { Models, PoolSnapshots, Settlements, Types } from '@ibt/db';
import {
  QuoteResponseSchema,
  SettlementsResponseSchema,
  TokenStateResponseSchema,
} from '@ibt/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { base58Encode } from '../src/lib/base58.js';
import { toPublicKey } from '../src/lib/publicKey.js';
import { decimalString } from '../src/modules/tokens/public.js';
import { errorOf, makeTestApp, newWallet, type TestApp } from './helpers.js';

const signature = () => base58Encode(randomBytes(64));
const address = () => newWallet().wallet;

describe('tokens: state, quote and settlements', () => {
  let t: TestApp;
  const curveMint = address();
  const gradMint = address();
  const pendingMint = address();
  let curveModelId: Types.ObjectId;
  let curvePool: string;
  let payoutSig: string;

  async function seedModel(slug: string, token: Record<string, unknown>, stats = {}) {
    const doc = await Models.create({
      providerId: new Types.ObjectId(),
      slug,
      name: slug,
      upstream: { baseUrl: 'http://127.0.0.1:1/v1', modelName: 'm', apiKeyEnc: 'enc' },
      pricing: { inputPerMTokMicroUsdc: 1n, outputPerMTokMicroUsdc: 1n },
      token,
      stats,
    });
    return doc._id;
  }

  beforeAll(async () => {
    t = await makeTestApp();
    const config = toPublicKey(address());
    const creator = toPublicKey(address());
    const keeper = { publicKey: toPublicKey(address()), secretKey: new Uint8Array(64) };

    curvePool = t.chain.addPool({ mint: toPublicKey(curveMint), config, creator }).toBase58();
    curveModelId = await seedModel(
      'tok-curve',
      { status: 'curve', mint: curveMint, dbcPool: curvePool },
      {
        requests: 1180,
        successRate: 0.992,
        revenueMicroUsdc: 14_300_000n,
        lockedLiquidityLamports: 800_000_000n,
      },
    );

    const gradPool = t.chain.addPool({ mint: toPublicKey(gradMint), config, creator });
    t.chain.migrateWhen(1_000n);
    t.chain.setSol(keeper.publicKey, 1_000n);
    await t.chain.curveBuy(keeper, gradPool, 1_000n);
    await t.chain.migrate(keeper, gradPool);
    await seedModel('tok-grad', {
      status: 'graduated',
      mint: gradMint,
      dbcPool: gradPool.toBase58(),
      dammV2Pool: address(),
    });
    await seedModel('tok-pending', { status: 'pending', mint: pendingMint });

    const ts = new Date('2026-10-02T12:00:00Z');
    await PoolSnapshots.create([
      {
        modelId: curveModelId,
        pool: curvePool,
        ts: new Date(ts.getTime() - 60_000),
        quoteReserve: '100000000',
        baseReserve: '1',
        sqrtPrice: '1',
        progress: 0.1,
        priceSolPerToken: 1e-9,
      },
      {
        modelId: curveModelId,
        pool: curvePool,
        ts,
        quoteReserve: '420000000',
        baseReserve: '1',
        sqrtPrice: '1',
        progress: 0.42,
        priceSolPerToken: 6.1e-9,
      },
    ]);

    payoutSig = signature();
    const hour = 60 * 60 * 1000;
    for (let i = 0; i < 3; i += 1) {
      await Settlements.create({
        modelId: curveModelId,
        periodStart: new Date(ts.getTime() + i * hour),
        periodEnd: new Date(ts.getTime() + (i + 1) * hour),
        state: i === 2 ? 'failed' : 'done',
        revenueMicroUsdc: 14_300_000n,
        requestCount: 10 + i,
        provider: { amountMicroUsdc: 10_010_000n, txSignature: payoutSig },
        liquidity: {
          phase: 'curve',
          sliceMicroUsdc: 2_860_000n,
          solLamports: 19_000_000n,
          solPriceUsdc: '150.25',
          tokensBaseUnits: 19_000_000_000n,
          buyTxSignature: signature(),
        },
        platformMicroUsdc: 1_430_000n,
        error: i === 2 ? 'boom' : null,
      });
    }
  });

  afterAll(async () => {
    await t.close();
  });

  it('GET /state returns the latest snapshot and the model stats in the spec shape', async () => {
    const res = await request(t.app).get(`/api/tokens/${curveMint}/state`);
    expect(res.status).toBe(200);
    expect(TokenStateResponseSchema.parse(res.body)).toEqual({
      phase: 'curve',
      progress: 0.42,
      quoteReserveSol: '0.42',
      priceSolPerToken: '0.0000000061',
      dbcPool: curvePool,
      dammV2Pool: null,
      lockedLiquiditySol: '0.8',
      stats: {
        requests24h: 1180,
        successRate: 0.992,
        revenueUsdc24h: '14.300000',
        lockedLiquiditySol: '0.8',
      },
    });
  });

  it('GET /state without a snapshot: graduated → progress 1, pending → phase none', async () => {
    const grad = TokenStateResponseSchema.parse(
      (await request(t.app).get(`/api/tokens/${gradMint}/state`)).body,
    );
    expect(grad).toMatchObject({ phase: 'graduated', progress: 1, quoteReserveSol: '0' });
    const pending = TokenStateResponseSchema.parse(
      (await request(t.app).get(`/api/tokens/${pendingMint}/state`)).body,
    );
    expect(pending).toMatchObject({ phase: 'none', progress: 0, dbcPool: null });
  });

  it('unknown mint → 404, malformed mint → 400', async () => {
    const unknown = await request(t.app).get(`/api/tokens/${address()}/state`);
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown).code).toBe('not_found');
    const bad = await request(t.app).get('/api/tokens/not-a-mint/state');
    expect(bad.status).toBe(400);
    expect(errorOf(bad).code).toBe('invalid_request');
  });

  it('GET /quote on the curve mirrors the chain fake DBC quote', async () => {
    const res = await request(t.app).get(`/api/tokens/${curveMint}/quote?side=buy&amount=250`);
    expect(res.status).toBe(200);
    const quote = QuoteResponseSchema.parse(res.body);
    expect(quote).toEqual({
      side: 'buy',
      phase: 'curve',
      amountIn: '250',
      amountOut: String(250n * FAKE_TOKENS_PER_LAMPORT),
      fee: '0',
      priceImpactPct: null,
    });
    const expected = await t.chain.quoteCurve(toPublicKey(curvePool), {
      side: 'buy',
      amount: 250n,
    });
    expect(quote.amountOut).toBe(expected.amountOut.toString());
  });

  it('GET /quote once graduated uses the DAMM v2 quote', async () => {
    const res = await request(t.app).get(`/api/tokens/${gradMint}/quote?side=sell&amount=5000`);
    expect(res.status).toBe(200);
    expect(QuoteResponseSchema.parse(res.body)).toEqual({
      side: 'sell',
      phase: 'graduated',
      amountIn: '5000',
      amountOut: String(5000n / FAKE_TOKENS_PER_LAMPORT),
      fee: '0',
      priceImpactPct: 0,
    });
    expect(t.chain.calls.some((call) => call.method === 'quoteDamm')).toBe(true);
  });

  it('GET /quote validates side and amount, and 404s without a pool', async () => {
    for (const query of ['side=hold&amount=1', 'side=buy&amount=0', 'side=buy&amount=1.5']) {
      const res = await request(t.app).get(`/api/tokens/${curveMint}/quote?${query}`);
      expect(res.status).toBe(400);
    }
    const pending = await request(t.app).get(`/api/tokens/${pendingMint}/quote?side=buy&amount=1`);
    expect(pending.status).toBe(404);
  });

  it('GET /settlements pages the public ledger newest first', async () => {
    const first = await request(t.app).get(`/api/tokens/${curveMint}/settlements?limit=2`);
    expect(first.status).toBe(200);
    const page1 = SettlementsResponseSchema.parse(first.body);
    expect(page1.items.map((s) => s.requestCount)).toEqual([12, 11]);
    expect(page1.items[0]).toMatchObject({
      modelId: curveModelId.toHexString(),
      state: 'failed',
      revenueUsdc: '14.300000',
      platformUsdc: '1.430000',
      provider: { amountUsdc: '10.010000', carryOverUsdc: '0.000000', txSignature: payoutSig },
      liquidity: {
        phase: 'curve',
        sliceUsdc: '2.860000',
        solLamports: '19000000',
        solPriceUsdc: '150.25',
        tokensBaseUnits: '19000000000',
        lockTxSignature: null,
      },
    });
    expect(first.text).not.toContain('boom');
    expect(page1.nextCursor).not.toBeNull();

    const second = await request(t.app).get(
      `/api/tokens/${curveMint}/settlements?limit=2&cursor=${page1.nextCursor ?? ''}`,
    );
    const page2 = SettlementsResponseSchema.parse(second.body);
    expect(page2.items.map((s) => s.requestCount)).toEqual([10]);
    expect(page2.nextCursor).toBeNull();

    const empty = await request(t.app).get(`/api/tokens/${gradMint}/settlements`);
    expect(SettlementsResponseSchema.parse(empty.body)).toEqual({ items: [], nextCursor: null });
  });

  it('decimalString renders float prices without exponents', () => {
    expect(decimalString(6.1e-9)).toBe('0.0000000061');
    expect(decimalString(2.5)).toBe('2.5');
    expect(decimalString(0)).toBe('0');
    expect(decimalString(Number.NaN)).toBe('0');
  });
});
