import { randomBytes } from 'node:crypto';

import { Nonces, Users } from '@ibt/db';
import {
  AppError,
  JWT_TTL_S,
  JwtClaimsSchema,
  NONCE_TTL_MS,
  buildSignInMessage,
  type NonceResponse,
  type User,
} from '@ibt/shared';
import { generateDepositRef } from '@ibt/shared/node';
import { SignJWT, jwtVerify } from 'jose';
import nacl from 'tweetnacl';

import type { AppContext } from '../../app.js';
import type { AuthUser } from '../../context.js';
import { base58Decode } from '../../lib/base58.js';

const JWT_ALG = 'HS256';
const UPSERT_ATTEMPTS = 3;

function signInDomain(ctx: AppContext): string {
  return new URL(ctx.env.WEB_ORIGIN).host;
}

function jwtKey(ctx: AppContext): Uint8Array {
  return new TextEncoder().encode(ctx.env.JWT_SECRET);
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}

/** Issues a single-use nonce valid for 5 minutes (L223, L518). */
export async function issueNonce(ctx: AppContext, wallet: string): Promise<NonceResponse> {
  const issuedAt = ctx.clock();
  const nonce = randomBytes(16).toString('hex');
  await Nonces.create({
    wallet,
    nonce,
    expiresAt: new Date(issuedAt.getTime() + NONCE_TTL_MS),
  });
  const message = buildSignInMessage({ domain: signInDomain(ctx), wallet, nonce, issuedAt });
  return { nonce, message };
}

async function consumeNonce(wallet: string, nonce: string | undefined) {
  // findOneAndDelete makes the nonce single-use even under concurrent verifies.
  return Nonces.findOneAndDelete(nonce === undefined ? { wallet } : { wallet, nonce }, {
    sort: { expiresAt: -1 },
  }).lean();
}

async function upsertUser(ctx: AppContext, wallet: string): Promise<User> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const user = await Users.findOneAndUpdate(
        { wallet },
        {
          $set: { lastSeenAt: ctx.clock() },
          $setOnInsert: { wallet, depositRef: generateDepositRef(), role: 'consumer' },
        },
        { upsert: true, new: true },
      ).lean();
      return { id: user._id.toString(), wallet: user.wallet, role: user.role };
    } catch (err) {
      // A concurrent first sign-in or a depositRef collision; the retry reads or re-rolls.
      if (!isDuplicateKey(err) || attempt >= UPSERT_ATTEMPTS) throw err;
    }
  }
}

export async function signJwt(ctx: AppContext, user: AuthUser): Promise<string> {
  const now = Math.floor(ctx.clock().getTime() / 1000);
  return new SignJWT({ userId: user.userId, wallet: user.wallet, role: user.role })
    .setProtectedHeader({ alg: JWT_ALG })
    .setSubject(user.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_TTL_S)
    .sign(jwtKey(ctx));
}

export async function verifyJwt(ctx: AppContext, token: string): Promise<AuthUser> {
  try {
    const { payload } = await jwtVerify(token, jwtKey(ctx), {
      algorithms: [JWT_ALG],
      currentDate: ctx.clock(),
    });
    const claims = JwtClaimsSchema.parse(payload);
    if (payload.sub !== claims.userId) throw new Error('sub does not match userId');
    return claims;
  } catch (err) {
    throw new AppError('unauthorized', { message: 'invalid or expired token', cause: err });
  }
}

export interface VerifyInput {
  wallet: string;
  nonce?: string | undefined;
  signature: string;
}

/** Ed25519 check over the exact message issued with the nonce, then a 24 h JWT. */
export async function verifySignIn(
  ctx: AppContext,
  input: VerifyInput,
): Promise<{ token: string; user: User }> {
  const unauthorized = (message: string) => new AppError('unauthorized', { message });
  const stored = await consumeNonce(input.wallet, input.nonce);
  if (!stored) throw unauthorized('unknown or used nonce');
  if (stored.expiresAt.getTime() <= ctx.clock().getTime()) throw unauthorized('nonce expired');

  const message = buildSignInMessage({
    domain: signInDomain(ctx),
    wallet: input.wallet,
    nonce: stored.nonce,
    issuedAt: new Date(stored.expiresAt.getTime() - NONCE_TTL_MS),
  });
  const signature = base58Decode(input.signature);
  const publicKey = base58Decode(input.wallet);
  const valid =
    signature?.length === nacl.sign.signatureLength &&
    publicKey?.length === nacl.sign.publicKeyLength &&
    nacl.sign.detached.verify(new TextEncoder().encode(message), signature, publicKey);
  if (!valid) throw unauthorized('signature does not match wallet');

  const user = await upsertUser(ctx, input.wallet);
  const token = await signJwt(ctx, { userId: user.id, wallet: user.wallet, role: user.role });
  return { token, user };
}
