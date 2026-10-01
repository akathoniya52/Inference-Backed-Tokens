import { USDC_MINT } from '@ibt/chain';

/** `@solana/web3.js` `PublicKey`, typed through `@ibt/chain` (web3.js is not an api dependency). */
export type PublicKey = (typeof USDC_MINT)['devnet'];

type PublicKeyClass = new (value: string) => PublicKey;

// Reuse the exact class `@ibt/chain` was built with, so `equals`/`instanceof`
// checks inside the chain package see the same constructor.
const PublicKeyCtor = USDC_MINT.devnet.constructor as PublicKeyClass;

/** Throws on input that is not a valid base58 public key; validate with zod first. */
export function toPublicKey(value: string): PublicKey {
  return new PublicKeyCtor(value);
}
