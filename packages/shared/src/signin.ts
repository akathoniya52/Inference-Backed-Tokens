import type { Cluster } from './constants.js';

export interface SignInMessageInput {
  /** Origin of the web app, e.g. `https://app.example`; its host is the SIWS domain. */
  uri: string;
  chainId: string;
  wallet: string;
  nonce: string;
  issuedAt: Date | string;
}

export function signInChainId(cluster: Cluster): string {
  return cluster === 'mainnet-beta' ? 'mainnet' : 'devnet';
}

/**
 * G22 fixed template; the api verifies the wallet's signature over exactly these bytes.
 * Phantom refuses SIWS text without URI, Version and Chain ID, and the field order
 * matches `createSignInMessageText`, so a wallet's own `signIn` produces the same text.
 */
export function buildSignInMessage({
  uri,
  chainId,
  wallet,
  nonce,
  issuedAt,
}: SignInMessageInput): string {
  const iso = typeof issuedAt === 'string' ? issuedAt : issuedAt.toISOString();
  return [
    `${new URL(uri).host} wants you to sign in with your Solana account:`,
    wallet,
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${iso}`,
  ].join('\n');
}
