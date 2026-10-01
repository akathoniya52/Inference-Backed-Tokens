import { vi, type MockInstance } from 'vitest';

export interface MockRoute {
  /** Matched against `pathname + search` of the request URL. */
  path: string | RegExp;
  status?: number;
  body: unknown;
}

function matches(route: MockRoute, target: string): boolean {
  return typeof route.path === 'string' ? route.path === target : route.path.test(target);
}

/**
 * Stubs `fetch` with JSON responses for the given API routes; unmatched
 * requests get a 404 `not_found` envelope. Restore with `vi.restoreAllMocks()`.
 */
export function mockApi(routes: MockRoute[]): MockInstance<typeof fetch> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const target = `${url.pathname}${url.search}`;
    const route = routes.find((candidate) => matches(candidate, target));
    const status = route?.status ?? (route ? 200 : 404);
    const body = route
      ? route.body
      : {
          error: { code: 'not_found', message: `no fixture for ${target}`, requestId: 'req_test' },
        };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

export function requestedPaths(spy: MockInstance<typeof fetch>): string[] {
  return spy.mock.calls.map(([input]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return `${url.pathname}${url.search}`;
  });
}
