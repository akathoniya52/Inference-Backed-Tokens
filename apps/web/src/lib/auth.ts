// The session JWT lives in module memory only (spec L490): a reload signs the
// user out, and nothing readable by other scripts persists it.

export interface Session {
  token: string;
  /** Wallet that signed in; the session is dropped when another one connects. */
  wallet: string | null;
}

let session: Session | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getToken(): string | null {
  return session?.token ?? null;
}

/** Stable reference between changes, as `useSyncExternalStore` requires. */
export function getSession(): Session | null {
  return session;
}

export function setToken(next: string, wallet: string | null = null): void {
  session = { token: next, wallet };
  emit();
}

export function clearToken(): void {
  if (session === null) return;
  session = null;
  emit();
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
