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
  /^(.+) wants you to sign in with your Solana account:\n.+\n\nNonce: .+\nIssued At: (.+)$/;

/**
 * Refuses to sign anything but the G22 template for this wallet and nonce, so
 * a compromised API cannot make the wallet sign arbitrary text.
 */
function isExpectedMessage(message: string, wallet: string, nonce: string): boolean {
  const match = SIGN_IN_MESSAGE.exec(message);
  if (!match?.[1] || !match[2]) return false;
  return buildSignInMessage({ domain: match[1], wallet, nonce, issuedAt: match[2] }) === message;
}

export type SignInStatus = 'idle' | 'requesting' | 'signing' | 'verifying' | 'error';

class SignInError extends Error {}

function signInErrorMessage(error: unknown): string {
  if (error instanceof SignInError) return error.message;
  if (isApiError(error)) return error.message;
  if (error instanceof Error && /reject|denied|declined|cancel/i.test(error.message)) {
    return 'You declined the sign-in request in your wallet.';
  }
  return 'Sign-in failed. Please try again.';
}

export interface UseSignIn {
  signIn: () => Promise<boolean>;
  status: SignInStatus;
  error: string | null;
}

/** nonce → `signMessage` → verify → in-memory JWT (spec L489, P3-T3). */
export function useSignIn(): UseSignIn {
  const { publicKey, signMessage } = useWallet();
  const [status, setStatus] = useState<SignInStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async (): Promise<boolean> => {
    setError(null);
    try {
      if (!publicKey) throw new SignInError('Connect a wallet first.');
      if (!signMessage) throw new SignInError('This wallet cannot sign messages.');
      const wallet = publicKey.toBase58();

      setStatus('requesting');
      const nonceBody: NonceRequest = { wallet };
      const { nonce, message } = NonceResponseSchema.parse(
        await apiFetch('/api/auth/nonce', { method: 'POST', body: JSON.stringify(nonceBody) }),
      );
      if (!isExpectedMessage(message, wallet, nonce)) {
        throw new SignInError('The sign-in message from the server was not recognised.');
      }

      setStatus('signing');
      const signature = await signMessage(new TextEncoder().encode(message));

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
  }, [publicKey, signMessage]);

  return { signIn, status, error };
}
