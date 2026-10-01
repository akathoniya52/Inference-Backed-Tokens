import { randomBytes } from 'node:crypto';

import { Models } from '@ibt/db';
import {
  LaunchConfirmResponseSchema,
  LaunchPrepareResponseSchema,
  OwnerModelSchema,
} from '@ibt/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { base58Encode } from '../src/lib/base58.js';
import { toPublicKey } from '../src/lib/publicKey.js';
import { randomSignature } from './depositTx.js';
import { bearer, errorOf, makeTestApp, newWallet, signIn, type TestApp } from './helpers.js';

function randomKey(): string {
  return base58Encode(randomBytes(32));
}

let slugCounter = 0;

describe('token launch prepare + confirm', () => {
  let t: TestApp;
  let owner: string;
  let ownerWallet: string;
  let stranger: string;

  async function createModel(): Promise<string> {
    slugCounter += 1;
    const res = await request(t.app)
      .post('/api/models')
      .set('Authorization', bearer(owner))
      .send({
        slug: `launch-model-${slugCounter}`,
        name: `Launch ${slugCounter}`,
        upstream: { baseUrl: 'http://127.0.0.1:1/v1', modelName: 'm', apiKey: 'sk-test' },
        pricing: { inputPerMTokUsdc: '0.1', outputPerMTokUsdc: '0.4' },
      });
    if (res.status !== 201) throw new Error(`create model failed: ${res.status}`);
    return OwnerModelSchema.parse(res.body).id;
  }

  function prepare(body: object, jwt = owner) {
    return request(t.app)
      .post('/api/tokens/launch/prepare')
      .set('Authorization', bearer(jwt))
      .send(body);
  }

  function confirm(body: object, jwt = owner) {
    return request(t.app)
      .post('/api/tokens/launch/confirm')
      .set('Authorization', bearer(jwt))
      .send(body);
  }

  function addPool(mint: string, opts: { config?: string; creator?: string } = {}) {
    return t.chain
      .addPool({
        mint: toPublicKey(mint),
        config: toPublicKey(opts.config ?? t.env.DBC_CONFIG),
        creator: toPublicKey(opts.creator ?? ownerWallet),
      })
      .toBase58();
  }

  beforeAll(async () => {
    t = await makeTestApp();
    const w = newWallet();
    ownerWallet = w.wallet;
    owner = await signIn(t.app, w.keypair);
    stranger = await signIn(t.app, newWallet().keypair);
  });

  afterAll(async () => {
    await t.close();
  });

  it('prepare stores a pending mint; re-prepare replaces it', async () => {
    const modelId = await createModel();
    const first = randomKey();
    const res = await prepare({ modelId, mint: first, symbol: 'LLAMA' });
    expect(res.status).toBe(200);
    expect(LaunchPrepareResponseSchema.parse(res.body)).toEqual({
      token: { status: 'pending', mint: first },
    });
    expect((await Models.findById(modelId).lean())?.token).toMatchObject({
      status: 'pending',
      mint: first,
      symbol: 'LLAMA',
    });

    const second = randomKey();
    expect((await prepare({ modelId, mint: second })).status).toBe(200);
    expect((await Models.findById(modelId).lean())?.token).toMatchObject({
      status: 'pending',
      mint: second,
      symbol: 'LLAMA',
    });
  });

  it('a good confirm moves the token to curve and is idempotent', async () => {
    const modelId = await createModel();
    const mint = randomKey();
    await prepare({ modelId, mint });
    const pool = addPool(mint);
    const signature = randomSignature();

    const res = await confirm({ modelId, mint, signature });
    expect(res.status).toBe(200);
    expect(LaunchConfirmResponseSchema.parse(res.body)).toEqual({
      token: { status: 'curve', mint, dbcPool: pool, progress: 0 },
    });
    expect((await Models.findById(modelId).lean())?.token).toMatchObject({
      status: 'curve',
      mint,
      dbcPool: pool,
      launchSignature: signature,
    });

    const again = await confirm({ modelId, mint, signature: randomSignature() });
    expect(again.status).toBe(200);
    expect(LaunchConfirmResponseSchema.parse(again.body).token.dbcPool).toBe(pool);
    expect((await Models.findById(modelId).lean())?.token.launchSignature).toBe(signature);

    const reprepare = await prepare({ modelId, mint: randomKey() });
    expect(reprepare.status).toBe(409);
    expect(errorOf(reprepare).code).toBe('token_already_launched');
    const otherMint = await confirm({ modelId, mint: randomKey(), signature: randomSignature() });
    expect(otherMint.status).toBe(409);
  });

  it('wrong creator or wrong config → 422 pool_mismatch with a reason, token stays pending', async () => {
    const modelId = await createModel();
    const badCreator = randomKey();
    await prepare({ modelId, mint: badCreator });
    addPool(badCreator, { creator: randomKey() });
    const creatorRes = await confirm({ modelId, mint: badCreator, signature: randomSignature() });
    expect(creatorRes.status).toBe(422);
    expect(errorOf(creatorRes)).toMatchObject({
      code: 'pool_mismatch',
      message: 'pool creator is not the model owner',
    });

    const badConfig = randomKey();
    await prepare({ modelId, mint: badConfig });
    addPool(badConfig, { config: randomKey() });
    const configRes = await confirm({ modelId, mint: badConfig, signature: randomSignature() });
    expect(configRes.status).toBe(422);
    expect(errorOf(configRes)).toMatchObject({
      code: 'pool_mismatch',
      message: 'pool does not use the platform config',
    });

    const noPool = randomKey();
    await prepare({ modelId, mint: noPool });
    const missing = await confirm({ modelId, mint: noPool, signature: randomSignature() });
    expect(missing.status).toBe(422);
    expect((await Models.findById(modelId).lean())?.token.status).toBe('pending');
  });

  it('confirm with an unprepared mint → 422', async () => {
    const modelId = await createModel();
    const mint = randomKey();
    addPool(mint);
    const unprepared = await confirm({ modelId, mint, signature: randomSignature() });
    expect(unprepared.status).toBe(422);
    expect(errorOf(unprepared)).toMatchObject({
      code: 'pool_mismatch',
      message: 'mint was not prepared for this model',
    });

    await prepare({ modelId, mint: randomKey() });
    const different = await confirm({ modelId, mint, signature: randomSignature() });
    expect(different.status).toBe(422);
  });

  it('non-owners get 403; unknown models 404; bad bodies 400; anonymous 401', async () => {
    const modelId = await createModel();
    const mint = randomKey();
    const foreignPrepare = await prepare({ modelId, mint }, stranger);
    expect(foreignPrepare.status).toBe(403);
    expect(errorOf(foreignPrepare).code).toBe('forbidden');

    await prepare({ modelId, mint });
    addPool(mint);
    const foreignConfirm = await confirm({ modelId, mint, signature: randomSignature() }, stranger);
    expect(foreignConfirm.status).toBe(403);

    const unknown = await prepare({ modelId: '0123456789abcdef01234567', mint });
    expect(unknown.status).toBe(404);
    expect((await prepare({ modelId, mint: 'nope' })).status).toBe(400);
    expect((await prepare({ modelId, mint, symbol: 'lower' })).status).toBe(400);
    expect((await confirm({ modelId, mint, signature: 'short' })).status).toBe(400);
    expect(
      (await request(t.app).post('/api/tokens/launch/prepare').send({ modelId, mint })).status,
    ).toBe(401);
  });

  it('a mint prepared by another model → 409', async () => {
    const a = await createModel();
    const b = await createModel();
    const mint = randomKey();
    expect((await prepare({ modelId: a, mint })).status).toBe(200);
    const clash = await prepare({ modelId: b, mint });
    expect(clash.status).toBe(409);
    expect(errorOf(clash).message).toBe('mint is already used by another model');
  });
});
