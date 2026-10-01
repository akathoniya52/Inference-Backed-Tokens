// The session JWT lives in module memory only (spec L489): a reload signs the
// user out, and nothing readable by other scripts persists it.

let token: string | null = null;

export function getToken(): string | null {
  return token;
}

export function setToken(next: string): void {
  token = next;
}

export function clearToken(): void {
  token = null;
}
