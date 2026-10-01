import { createHash, randomBytes } from 'node:crypto';

import bs58 from 'bs58';

import { API_KEY_DISPLAY_PREFIX_LENGTH, API_KEY_PREFIX, DEPOSIT_REF_LENGTH } from '../constants.js';

export function generateApiKey(): string {
  return API_KEY_PREFIX + bs58.encode(randomBytes(32));
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function keyPrefix(key: string): string {
  return key.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH);
}

export function generateDepositRef(): string {
  // The last 8 base58 digits of a random 128-bit number: always 8 chars, bias below 2^-81.
  return bs58.encode(randomBytes(16)).slice(-DEPOSIT_REF_LENGTH);
}
