export interface SignInMessageInput {
  domain: string;
  wallet: string;
  nonce: string;
  issuedAt: Date | string;
}

/** G22 fixed template; the api verifies the wallet's signature over exactly these bytes. */
export function buildSignInMessage({
  domain,
  wallet,
  nonce,
  issuedAt,
}: SignInMessageInput): string {
  const iso = typeof issuedAt === 'string' ? issuedAt : issuedAt.toISOString();
  return `${domain} wants you to sign in with your Solana account:\n${wallet}\n\nNonce: ${nonce}\nIssued At: ${iso}`;
}
