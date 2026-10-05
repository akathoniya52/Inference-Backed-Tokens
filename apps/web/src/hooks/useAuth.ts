import {
  buildSignInMessage,
  NonceResponseSchema,
  VerifyResponseSchema,
  type NonceRequest,
  type VerifyRequest,
} from '@ibt/shared';
import { useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { apiFetch, isApiError } from '../lib/api';
import { clearToken, getSession, setToken, subscribeSession, type Session } from '../lib/auth';

export function useSession(): Session | null {
  return useSyncExternalStore(subscribeSession, getSession, getSession);
}

/** Wallet the current session belongs to, or `null` when signed out. */
export function useSessionWallet(): string | null {
  return useSession()?.wallet ?? null;
}

/** Drops the session as soon as its wallet disconnects or another one connects. */
export function useSessionWalletSync(): void {
  const session = useSession();
  const { publicKey } = useWallet();
  const connected = publicKey?.toBase58() ?? null;
  useEffect(() => {
    if (session !== null && session.wallet !== connected) clearToken();
  }, [session, connected]);
}

const SIGN_IN_MESSAGE =
  /^(.+) wants you to sign in with your Solana account:\n.+\n\nURI: (.+)\nVersion: 1\nChain ID: (.+)\nNonce: .+\nIssued At: (.+)$/;

/** The template's variable parts, in the shape the Wallet Standard `signIn` takes. */
interface SignInFields {
  domain: string;
  address: string;
  uri: string;
  version: '1';
  chainId: string;
  nonce: string;
  issuedAt: string;
}

/**
 * Refuses to sign anything but the G22 template for this wallet and nonce, so
 * a compromised API cannot make the wallet sign arbitrary text.
 */
function expectedMessageFields(
  message: string,
  wallet: string,
  nonce: string,
): SignInFields | null {
  const [, domain, uri, chainId, issuedAt] = SIGN_IN_MESSAGE.exec(message) ?? [];
  if (!domain || !uri || !chainId || !issuedAt || !URL.canParse(uri)) return null;
  const fields: SignInFields = {
    domain,
    address: wallet,
    uri,
    version: '1',
    chainId,
    nonce,
    issuedAt,
  };
  const expected = buildSignInMessage({ uri, chainId, wallet, nonce, issuedAt });
  return expected === message ? fields : null;
}

type WalletSignIn = NonNullable<ReturnType<typeof useWallet>['signIn']>;
type WalletSignMessage = NonNullable<ReturnType<typeof useWallet>['signMessage']>;
type Signer = (fields: SignInFields, message: string) => Promise<Uint8Array>;

/**
 * Wallet Standard sign-in: the wallet builds the Sign-In-With-Solana text from the
 * fields itself. Phantom refused the very same text through `signMessage` as
 * "invalid formatting" (2026-10-02). The api verifies our template, so the wallet
 * must have signed exactly that.
 */
async function signInWithWallet(
  signIn: WalletSignIn,
  fields: SignInFields,
  message: string,
): Promise<Uint8Array> {
  const output = await signIn(fields);
  if (output.account.address !== fields.address) {
    throw new SignInError(
      'The wallet signed in with a different account. Connect that account and try again.',
    );
  }
  if (new TextDecoder().decode(output.signedMessage) !== message) {
    throw new SignInError('The wallet changed the sign-in message.');
  }
  return output.signature;
}

function pickSigner(
  signIn: WalletSignIn | undefined,
  signMessage: WalletSignMessage | undefined,
): Signer | null {
  if (signIn) return (fields, message) => signInWithWallet(signIn, fields, message);
  if (signMessage) return (_fields, message) => signMessage(new TextEncoder().encode(message));
  return null;
}

export type SignInStatus = 'idle' | 'requesting' | 'signing' | 'verifying' | 'error';

class SignInError extends Error {}

function signInErrorMessage(error: unknown): string {
  if (error instanceof SignInError) return error.message;
  if (isApiError(error)) return error.message;
  if (error instanceof Error && /reject|denied|declined|cancel/i.test(error.message)) {
    return 'You declined the sign-in request in your wallet.';
  }
  if (error instanceof Error && error.name.startsWith('WalletSign')) {
    return `Your wallet refused the sign-in request: ${error.message}`;
  }
  return 'Sign-in failed. Please try again.';
}

export interface UseSignIn {
  signIn: () => Promise<boolean>;
  status: SignInStatus;
  error: string | null;
}

/** nonce → `signMessage` → verify → in-memory JWT (spec L490, P3-T3). */
export function useSignIn(): UseSignIn {
  const { publicKey, signMessage, signIn: walletSignIn } = useWallet();
  const [status, setStatus] = useState<SignInStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async (): Promise<boolean> => {
    setError(null);
    try {
      if (!publicKey) throw new SignInError('Connect a wallet first.');
      const signer = pickSigner(walletSignIn, signMessage);
      if (!signer) throw new SignInError('This wallet cannot sign messages.');
      const wallet = publicKey.toBase58();

      setStatus('requesting');
      const nonceBody: NonceRequest = { wallet };
      const { nonce, message } = NonceResponseSchema.parse(
        await apiFetch('/api/auth/nonce', { method: 'POST', body: JSON.stringify(nonceBody) }),
      );
      const fields = expectedMessageFields(message, wallet, nonce);
      if (!fields) throw new SignInError('The sign-in message from the server was not recognised.');

      setStatus('signing');
      const signature = await signer(fields, message);

      setStatus('verifying');
      const verifyBody: VerifyRequest & { nonce: string } = {
        wallet,
        nonce,
        signature: bs58.encode(signature),
      };
      const { token } = VerifyResponseSchema.parse(
        await apiFetch('/api/auth/verify', { method: 'POST', body: JSON.stringify(verifyBody) }),
      );
      setToken(token, wallet);
      setStatus('idle');
      return true;
    } catch (cause) {
      setError(signInErrorMessage(cause));
      setStatus('error');
      return false;
    }
  }, [publicKey, signMessage, walletSignIn]);

  return { signIn, status, error };
}
