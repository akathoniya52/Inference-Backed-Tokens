import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/** Parses a base58 or JSON-array secret key. Errors never echo the value. */
export function parseSecretKey(name: string, raw: string): Keypair {
  const value = raw.trim();
  let bytes: Uint8Array;
  try {
    if (value.startsWith('[')) {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n))) {
        throw new Error('not an integer array');
      }
      bytes = Uint8Array.from(parsed as number[]);
    } else {
      bytes = bs58.decode(value);
    }
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error(`${name} is not a valid base58 or JSON-array secret key`);
  }
}
