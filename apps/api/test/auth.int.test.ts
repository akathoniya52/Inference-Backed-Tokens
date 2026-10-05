import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  JWT_TTL_S,
  NONCE_TTL_MS,
  NonceResponseSchema,
  VerifyResponseSchema,
} from '@ibt/shared';
import { Nonces, Users } from '@ibt/db';
import { SignJWT, decodeJwt } from 'jose';
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
    expect(message).toContain(
      '\n\nSign in with your Solana account.\n\nURI: http://localhost:5173\nVersion: 1\nChain ID: solana:devnet\n',
    );

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

  it('verify without a nonce → 400 invalid_request and leaves the nonce usable', async () => {
    const { keypair, wallet } = newWallet();
    const ip = nextIp();
    const { nonce: n, message } = await nonce(wallet, ip);
    const signature = signMessage(keypair, message);
    const res = await request(t.app)
      .post('/api/auth/verify')
      .set('X-Forwarded-For', ip)
      .send({ wallet, signature });
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('invalid_request');

    const ok = await request(t.app)
      .post('/api/auth/verify')
      .set('X-Forwarded-For', ip)
      .send({ wallet, nonce: n, signature });
    expect(ok.status).toBe(200);
  });

  it('a forged signature does not burn the nonce: the real sign-in still succeeds', async () => {
    const victim = newWallet();
    const attacker = newWallet();
    const ip = nextIp();
    const { nonce: n, message } = await nonce(victim.wallet, ip);

    for (const signature of [signMessage(attacker.keypair, message), '1'.repeat(88)]) {
      const forged = await request(t.app)
        .post('/api/auth/verify')
        .set('X-Forwarded-For', nextIp())
        .send({ wallet: victim.wallet, nonce: n, signature });
      expect(forged.status).toBe(401);
      expect(errorOf(forged).code).toBe('unauthorized');
    }
    expect(await Nonces.countDocuments({ wallet: victim.wallet, nonce: n })).toBe(1);

    const res = await request(t.app)
      .post('/api/auth/verify')
      .set('X-Forwarded-For', ip)
      .send({ wallet: victim.wallet, nonce: n, signature: signMessage(victim.keypair, message) });
    expect(res.status).toBe(200);
    expect(await Nonces.countDocuments({ wallet: victim.wallet, nonce: n })).toBe(0);
  });

  it('concurrent verifies of one valid signature: exactly one wins', async () => {
    const { keypair, wallet } = newWallet();
    const { nonce: n, message } = await nonce(wallet, nextIp());
    const payload = { wallet, nonce: n, signature: signMessage(keypair, message) };
    const results = await Promise.all(
      [nextIp(), nextIp(), nextIp()].map((ip) =>
        request(t.app).post('/api/auth/verify').set('X-Forwarded-For', ip).send(payload),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401]);
    for (const r of results.filter((r) => r.status === 401)) {
      expect(errorOf(r).message).toBe('unknown or used nonce');
    }
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

    // Query operators never reach a filter: the schema only takes strings.
    const { wallet } = newWallet();
    for (const body of [
      { wallet: { $ne: null } },
      { wallet, nonce: { $gt: '' }, signature: { $ne: null } },
    ]) {
      const path = 'nonce' in body ? '/api/auth/verify' : '/api/auth/nonce';
      const injected = await request(t.app).post(path).set('X-Forwarded-For', ip).send(body);
      expect(injected.status).toBe(400);
      expect(errorOf(injected).code).toBe('invalid_request');
    }
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

  it('logout revokes the JWT; a fresh sign-in works and older tokens stay revoked', async () => {
    const { keypair, wallet } = newWallet();
    const token = await signIn(t.app, keypair, { ip: nextIp() });
    expect(decodeJwt(token).ver).toBe(0);
    const session = () =>
      request(t.app).get('/__test/session').set('Authorization', `Bearer ${token}`);
    expect((await session()).status).toBe(200);

    const unauthenticated = await request(t.app)
      .post('/api/auth/logout')
      .set('X-Forwarded-For', nextIp());
    expect(unauthenticated.status).toBe(401);

    const out = await request(t.app)
      .post('/api/auth/logout')
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', `Bearer ${token}`);
    expect(out.status).toBe(204);
    expect((await Users.findOne({ wallet }).lean())?.tokenVersion).toBe(1);

    const revoked = await session();
    expect(revoked.status).toBe(401);
    expect(errorOf(revoked).code).toBe('unauthorized');

    const again = await signIn(t.app, keypair, { ip: nextIp() });
    expect(decodeJwt(again).ver).toBe(1);
    const fresh = await request(t.app)
      .get('/__test/session')
      .set('Authorization', `Bearer ${again}`);
    expect(fresh.status).toBe(200);
    expect((await session()).status).toBe(401);
  });

  it('rejects tokens with a wrong or missing issuer/audience, or for a deleted user', async () => {
    const { keypair, wallet } = newWallet();
    const token = await signIn(t.app, keypair, { ip: nextIp() });
    const { userId } = decodeJwt(token);
    const key = new TextEncoder().encode(t.env.JWT_SECRET);
    const now = Math.floor(t.clock.now().getTime() / 1000);
    const mint = (iss: string | null, aud: string | null, ver?: number) => {
      const jwt = new SignJWT({
        userId,
        wallet,
        role: 'consumer',
        ...(ver === undefined ? {} : { ver }),
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(String(userId))
        .setIssuedAt(now)
        .setExpirationTime(now + 60);
      if (iss !== null) jwt.setIssuer(iss);
      if (aud !== null) jwt.setAudience(aud);
      return jwt.sign(key);
    };
    const status = async (jwt: string) =>
      (await request(t.app).get('/__test/session').set('Authorization', `Bearer ${jwt}`)).status;

    expect(decodeJwt(token)).toMatchObject({ iss: JWT_ISSUER, aud: JWT_AUDIENCE });
    expect(await status(await mint(JWT_ISSUER, JWT_AUDIENCE, 0))).toBe(200);
    // A token minted before `ver` existed is version 0.
    expect(await status(await mint(JWT_ISSUER, JWT_AUDIENCE))).toBe(200);
    expect(await status(await mint('someone-else', JWT_AUDIENCE, 0))).toBe(401);
    expect(await status(await mint(JWT_ISSUER, 'ibt-admin', 0))).toBe(401);
    expect(await status(await mint(null, JWT_AUDIENCE, 0))).toBe(401);
    expect(await status(await mint(JWT_ISSUER, null, 0))).toBe(401);
    expect(await status(await mint(JWT_ISSUER, JWT_AUDIENCE, 5))).toBe(401);

    await Users.deleteOne({ wallet });
    expect(await status(token)).toBe(401);
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
