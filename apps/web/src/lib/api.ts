import { ErrorEnvelopeSchema } from '@ibt/shared';

import { env } from '../env';
import { clearToken, getToken } from './auth';

export interface ApiErrorInit {
  code: string;
  message: string;
  requestId: string | null;
  /** HTTP status; `0` when the request never got a response. */
  status: number;
}

export class ApiError extends Error {
  readonly code: string;
  readonly requestId: string | null;
  readonly status: number;

  constructor({ code, message, requestId, status }: ApiErrorInit, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiError';
    this.code = code;
    this.requestId = requestId;
    this.status = status;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

function apiUrl(path: string): string {
  const base = env.VITE_API_URL.replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

async function toApiError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null);
  const envelope = ErrorEnvelopeSchema.safeParse(body);
  const headerRequestId = response.headers.get('x-request-id');
  if (envelope.success) {
    const { code, message, requestId } = envelope.data.error;
    return new ApiError({
      code,
      message,
      requestId: requestId ?? headerRequestId,
      status: response.status,
    });
  }
  return new ApiError({
    code: 'http_error',
    message: `request failed with HTTP ${response.status}`,
    requestId: headerRequestId,
    status: response.status,
  });
}

/**
 * `fetch` against `VITE_API_URL` with the in-memory JWT attached. Resolves the
 * parsed JSON body (`undefined` for 204) and throws `ApiError` otherwise.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const jwt = getToken();
  if (jwt !== null && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${jwt}`);
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(path), { ...init, headers });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(
      { code: 'network_error', message: 'could not reach the API', requestId: null, status: 0 },
      { cause },
    );
  }

  // An expired or revoked JWT signs the user out so `WalletGate` asks again.
  if (response.status === 401 && jwt !== null && getToken() === jwt) clearToken();
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
