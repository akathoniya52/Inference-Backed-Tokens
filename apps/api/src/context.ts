import { AppError, type UserRole } from '@ibt/shared';

// Per-request state lives in WeakMaps keyed by the request object, so it is
// typed without augmenting Express globals and is readable from pino-http's
// `IncomingMessage` view of the same request.

export type Clock = () => Date;

export interface AuthUser {
  userId: string;
  wallet: string;
  role: UserRole;
}

export interface ApiKeyContext {
  apiKeyId: string;
  userId: string;
  /** The key owner's wallet, for the holder discount (L186). */
  wallet: string;
  dailyCapMicroUsdc: bigint;
}

const requestIds = new WeakMap<object, string>();
const users = new WeakMap<object, AuthUser>();
const apiKeys = new WeakMap<object, ApiKeyContext>();

export function setRequestId(req: object, id: string): void {
  requestIds.set(req, id);
}

export function getRequestId(req: object): string | undefined {
  return requestIds.get(req);
}

export function setAuthUser(req: object, user: AuthUser): void {
  users.set(req, user);
}

export function getAuthUser(req: object): AuthUser | undefined {
  return users.get(req);
}

/** For handlers mounted behind `jwtAuth`. */
export function requireAuthUser(req: object): AuthUser {
  const user = users.get(req);
  if (!user) throw new AppError('unauthorized');
  return user;
}

export function setApiKeyContext(req: object, ctx: ApiKeyContext): void {
  apiKeys.set(req, ctx);
}

export function getApiKeyContext(req: object): ApiKeyContext | undefined {
  return apiKeys.get(req);
}

/** For handlers mounted behind `apiKeyAuth`. */
export function requireApiKeyContext(req: object): ApiKeyContext {
  const ctx = apiKeys.get(req);
  if (!ctx) throw new AppError('invalid_api_key');
  return ctx;
}
