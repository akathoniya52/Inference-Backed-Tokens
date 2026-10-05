import { JWT_TTL_S, NONCE_TTL_MS, NonceResponseSchema, VerifyResponseSchema } from '@ibt/shared';
import { Users } from '@ibt/db';
import { decodeJwt } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requireAuthUser } from '../src/context.js';
import { base58Encode } from '../src/lib/base58.js';
import { jwtAuth } from '../src/middleware/jwtAuth.js';
import {
  errorOf,
  makeTestApp,
  newWallet,
  signIn,
  signMessage,
  type MakeTestAppOptions,
  type TestApp,
} from './helpers.js';

let ipCounter = 0;
/** Each test gets its own client IP so the 10/min auth limit only bites where intended. */
const nextIp = () => `198.51.100.${++ipCounter}`;

const sessionRoute: MakeTestAppOptions['extraRoutes'] = (app, ctx) => {
  app.get('/__test/session', jwtAuth(ctx), (req, res) => {
    res.json(requireAuthUser(req));
  });
};

describe('auth', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeTestApp({ extraRoutes: sessionRoute });
  });

  afterAll(async () => {
    await t.close();
  });

  async function nonce(wallet: string, ip: string) {
    const res = await request(t.app)
      .post('/api/auth/nonce')
      .set('X-Forwarded-For', ip)
      .send({ wallet });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return NonceResponseSchema.parse(res.body);
  }

  it('valid signature → JWT with userId, wallet and role; user upserted with a depositRef', async () => {
    const { keypair, wallet } = newWallet();
    const ip = nextIp();
    const { nonce: n, message } = await nonce(wallet, ip);
    expect(message).toContain(wallet);
    expect(message).toContain(`Nonce: ${n}`);
    expect(message.startsWith('localhost:5173 wants you to sign in')).toBe(true);
    expect(message).toContain('\n\nURI: http://localhost:5173\nVersion: 1\nChain ID: devnet\n');

    const res = await request(t.app)
      .post('/api/auth/verify')
      .set('X-Forwarded-For', ip)
      .send({ wallet, nonce: n, signature: signMessage(keypair, message) });
    expect(res.status).toBe(200);
    const body = VerifyResponseSchema.parse(res.body);
    expect(body.user).toMatchObject({ wallet, role: 'consumer' });

    const claims = decodeJwt(body.token);
    expect(claims).toMatchObject({
      sub: body.user.id,
      userId: body.user.id,
      wallet,
      role: 'consumer',
    });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(JWT_TTL_S);

    const user = await Users.findOne({ wallet }).lean();
    expect(user?.depositRef).toMatch(/^[1-9A-HJ-NP-Za-km-z]{8}$/);

    // Signing in again keeps the same user and depositRef.
    const again = await signIn(t.app, keypair, { ip });
    expect(decodeJwt(again).sub).toBe(body.user.id);
    expect((await Users.findOne({ wallet }).lean())?.depositRef).toBe(user?.depositRef);
  });

  it('verify without a nonce uses the latest issued nonce', async () => {
    const { keypair, wallet } = newWallet();
    const ip = nextIp();
    const { message } = await nonce(wallet, ip);
    const res = await request(t.app)
      .post('/api/auth/verify')
      .set('X-Forwarded-For', ip)
      .send({ wallet, signature: signMessage(keypair, message) });
    expect(res.status).toBe(200);
  });

  it('a replayed nonce → 401', async () => {
    const { keypair, wallet } = newWallet();
    const ip = nextIp();
    const { nonce: n, message } = await nonce(wallet, ip);
    const payload = { wallet, nonce: n, signature: signMessage(keypair, message) };
    const first = await request(t.app)
      .post('/api/auth/verify')
      .set('X-Forwarded-For', ip)
      .send(payload);
    expect(first.status).toBe(200);
    const replay = await request(t.app)
      .post('/api/auth/verify')
      .set('X-Forwarded-For', ip)
      .send(payload);
    expect(replay.status).toBe(401);
    expect(errorOf(replay).code).toBe('unauthorized');
  });

  it('an expired nonce → 401', async () => {
    const { keypair, wallet } = newWallet();
    const ip = nextIp();
    const { nonce: n, message } = await nonce(wallet, ip);
    t.clock.advance(NONCE_TTL_MS + 1);
    const res = await request(t.app)
      .post('/api/auth/verify')
      .set('X-Forwarded-For', ip)
      .send({ wallet, nonce: n, signature: signMessage(keypair, message) });
    expect(res.status).toBe(401);
  });

  it('a signature from another wallet → 401', async () => {
    const { wallet } = newWallet();
    const attacker = newWallet();
    const ip = nextIp();
    const { nonce: n, message } = await nonce(wallet, ip);
    const res = await request(t.app)
      .post('/api/auth/verify')
      .set('X-Forwarded-For', ip)
      .send({ wallet, nonce: n, signature: signMessage(attacker.keypair, message) });
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('unauthorized');
  });

  it('a signature over a different message → 401', async () => {
    const { keypair, wallet } = newWallet();
    const ip = nextIp();
    const { nonce: n } = await nonce(wallet, ip);
    const res = await request(t.app)
      .post('/api/auth/verify')
      .set('X-Forwarded-For', ip)
      .send({ wallet, nonce: n, signature: signMessage(keypair, 'something else') });
    expect(res.status).toBe(401);
  });

  it('malformed bodies → 400 invalid_request', async () => {
    const ip = nextIp();
    const res = await request(t.app)
      .post('/api/auth/nonce')
      .set('X-Forwarded-For', ip)
      .send({ wallet: 'not-a-key' });
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('invalid_request');
  });

  it('rate limits auth routes to 10/min per IP', async () => {
    const { wallet } = newWallet();
    const ip = nextIp();
    for (let i = 0; i < 10; i += 1) await nonce(wallet, ip);
    const limited = await request(t.app)
      .post('/api/auth/nonce')
      .set('X-Forwarded-For', ip)
      .send({ wallet });
    expect(limited.status).toBe(429);
    expect(errorOf(limited).code).toBe('rate_limited');
    // Another client IP is unaffected.
    await nonce(wallet, nextIp());
  });

  it('jwtAuth accepts the token and rejects tampered, foreign or expired tokens', async () => {
    const { keypair } = newWallet();
    const token = await signIn(t.app, keypair, { ip: nextIp() });
    const ok = await request(t.app).get('/__test/session').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ wallet: base58Encode(keypair.publicKey), role: 'consumer' });

    const missing = await request(t.app).get('/__test/session');
    expect(missing.status).toBe(401);
    expect(errorOf(missing).code).toBe('unauthorized');

    const tampered = await request(t.app)
      .get('/__test/session')
      .set('Authorization', `Bearer ${token.slice(0, -2)}xx`);
    expect(tampered.status).toBe(401);

    const other = await makeTestApp({ extraRoutes: sessionRoute });
    const foreign = await request(other.app)
      .get('/__test/session')
      .set('Authorization', `Bearer ${token}`);
    expect(foreign.status).toBe(401);
    await other.close();

    t.clock.advance(JWT_TTL_S * 1000 + 1000);
    const expired = await request(t.app)
      .get('/__test/session')
      .set('Authorization', `Bearer ${token}`);
    expect(expired.status).toBe(401);
  });

  it('never leaks the nonce store across wallets', async () => {
    const a = newWallet();
    const b = newWallet();
    const ip = nextIp();
    const { nonce: n, message } = await nonce(a.wallet, ip);
    const res = await request(t.app)
      .post('/api/auth/verify')
      .set('X-Forwarded-For', ip)
      .send({ wallet: b.wallet, nonce: n, signature: signMessage(b.keypair, message) });
    expect(res.status).toBe(401);
  });
});
