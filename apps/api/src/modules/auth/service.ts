import { randomBytes } from 'node:crypto';

import { Nonces, Users, type Types } from '@ibt/db';
import {
  AppError,
  JWT_AUDIENCE,
  JWT_ISSUER,
  JWT_TTL_S,
  JwtClaimsSchema,
  NONCE_TTL_MS,
  buildSignInMessage,
  signInChainId,
  type JwtClaims,
  type NonceResponse,
  type User,
} from '@ibt/shared';
import { generateDepositRef } from '@ibt/shared/node';
import { SignJWT, jwtVerify } from 'jose';
import nacl from 'tweetnacl';

import type { AppContext } from '../../app.js';
import type { AuthUser } from '../../context.js';
import { base58Decode } from '../../lib/base58.js';
import { isDuplicateKey } from '../../lib/mongoErrors.js';

const JWT_ALG = 'HS256';
const UPSERT_ATTEMPTS = 3;

function signInMessage(ctx: AppContext, wallet: string, nonce: string, issuedAt: Date): string {
  return buildSignInMessage({
    uri: ctx.env.WEB_ORIGIN,
    chainId: signInChainId(ctx.env.CLUSTER),
    wallet,
    nonce,
    issuedAt,
  });
}

function jwtKey(ctx: AppContext): Uint8Array {
  return new TextEncoder().encode(ctx.env.JWT_SECRET);
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
  const message = signInMessage(ctx, wallet, nonce, issuedAt);
  return { nonce, message };
}

async function findNonce(wallet: string, nonce: string) {
  return Nonces.findOne({ wallet, nonce }).lean();
}

/** Atomic, so the nonce is single-use even under concurrent verifies. */
async function consumeNonce(id: Types.ObjectId): Promise<boolean> {
  return (await Nonces.findOneAndDelete({ _id: id }).lean()) !== null;
}

async function upsertUser(
  ctx: AppContext,
  wallet: string,
): Promise<{ user: User; tokenVersion: number }> {
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
      return {
        user: { id: user._id.toString(), wallet: user.wallet, role: user.role },
        tokenVersion: user.tokenVersion ?? 0,
      };
    } catch (err) {
      // A concurrent first sign-in or a depositRef collision; the retry reads or re-rolls.
      if (!isDuplicateKey(err) || attempt >= UPSERT_ATTEMPTS) throw err;
    }
  }
}

export async function signJwt(
  ctx: AppContext,
  user: AuthUser,
  tokenVersion: number,
): Promise<string> {
  const now = Math.floor(ctx.clock().getTime() / 1000);
  const claims: JwtClaims = {
    userId: user.userId,
    wallet: user.wallet,
    role: user.role,
    ver: tokenVersion,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setSubject(user.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_TTL_S)
    .sign(jwtKey(ctx));
}

async function verifiedClaims(ctx: AppContext, token: string): Promise<JwtClaims> {
  try {
    const { payload } = await jwtVerify(token, jwtKey(ctx), {
      algorithms: [JWT_ALG],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      requiredClaims: ['iss', 'aud', 'sub'],
      currentDate: ctx.clock(),
    });
    const claims = JwtClaimsSchema.parse(payload);
    if (payload.sub !== claims.userId) throw new Error('sub does not match userId');
    return claims;
  } catch (err) {
    throw new AppError('unauthorized', { message: 'invalid or expired token', cause: err });
  }
}

/** Signature and claims, then the user's current `tokenVersion` so logout revokes the token. */
export async function verifyJwt(ctx: AppContext, token: string): Promise<AuthUser> {
  const claims = await verifiedClaims(ctx, token);
  const user = await Users.findById(claims.userId, { wallet: 1, tokenVersion: 1 }).lean();
  if (!user || user.wallet !== claims.wallet || (claims.ver ?? 0) !== (user.tokenVersion ?? 0)) {
    throw new AppError('unauthorized', { message: 'session revoked' });
  }
  return { userId: claims.userId, wallet: claims.wallet, role: claims.role };
}

/** Revokes every JWT issued to the user so far. */
export async function revokeSessions(userId: string): Promise<void> {
  await Users.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}

export interface VerifyInput {
  wallet: string;
  nonce: string;
  signature: string;
}

/**
 * Ed25519 check over the exact message issued with the nonce, then a 24 h JWT.
 * The nonce is only consumed after the signature checks out, so a forged verify
 * cannot burn another wallet's nonce.
 */
export async function verifySignIn(
  ctx: AppContext,
  input: VerifyInput,
): Promise<{ token: string; user: User }> {
  const unauthorized = (message: string) => new AppError('unauthorized', { message });
  const stored = await findNonce(input.wallet, input.nonce);
  if (!stored) throw unauthorized('unknown or used nonce');
  if (stored.expiresAt.getTime() <= ctx.clock().getTime()) throw unauthorized('nonce expired');

  const message = signInMessage(
    ctx,
    input.wallet,
    stored.nonce,
    new Date(stored.expiresAt.getTime() - NONCE_TTL_MS),
  );
  const signature = base58Decode(input.signature);
  const publicKey = base58Decode(input.wallet);
  const valid =
    signature?.length === nacl.sign.signatureLength &&
    publicKey?.length === nacl.sign.publicKeyLength &&
    nacl.sign.detached.verify(new TextEncoder().encode(message), signature, publicKey);
  if (!valid) throw unauthorized('signature does not match wallet');
  if (!(await consumeNonce(stored._id))) throw unauthorized('unknown or used nonce');

  const { user, tokenVersion } = await upsertUser(ctx, input.wallet);
  const token = await signJwt(
    ctx,
    { userId: user.id, wallet: user.wallet, role: user.role },
    tokenVersion,
  );
  return { token, user };
}
