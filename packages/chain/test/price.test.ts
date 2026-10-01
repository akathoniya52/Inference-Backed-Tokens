import { describe, expect, it, vi } from 'vitest';

import { FakePriceSource, JupiterPriceSource } from '../src/price.js';
import { WSOL_MINT } from '../src/sdk.js';

const SOL = WSOL_MINT.toBase58();
const URL_V3 = 'https://price.example.invalid/price/v3';

function stubFetch(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

describe('JupiterPriceSource', () => {
  it('parses the v3 shape and requests the WSOL id without a key', async () => {
    const fetchFn = stubFetch({ [SOL]: { usdPrice: 151.25, decimals: 9 } });
    await expect(new JupiterPriceSource({ url: URL_V3, fetch: fetchFn }).solUsd()).resolves.toBe(
      151.25,
    );
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe(`${URL_V3}?ids=${SOL}`);
    expect(new Headers(init?.headers).has('x-api-key')).toBe(false);
  });

  it('parses the { data } shape with a string price and sends x-api-key', async () => {
    const fetchFn = stubFetch({ data: { [SOL]: { id: SOL, price: '149.5' } } });
    const source = new JupiterPriceSource({ url: URL_V3, apiKey: 'k1', fetch: fetchFn });
    await expect(source.solUsd()).resolves.toBe(149.5);
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get('x-api-key')).toBe('k1');
  });

  it.each([
    ['a missing mint', {}, 200],
    ['a non-positive price', { [SOL]: { usdPrice: 0 } }, 200],
    ['an HTTP error', { error: 'unauthorized' }, 401],
  ])('rejects %s', async (_label, body, status) => {
    const source = new JupiterPriceSource({ url: URL_V3, fetch: stubFetch(body, status) });
    await expect(source.solUsd()).rejects.toThrow(/SOL price/);
  });
});

describe('FakePriceSource', () => {
  it('returns the fixed price', async () => {
    await expect(new FakePriceSource(150).solUsd()).resolves.toBe(150);
  });
});
