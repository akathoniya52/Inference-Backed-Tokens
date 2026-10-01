import { WSOL_MINT } from './sdk.js';

export interface PriceSource {
  /** USD per SOL. */
  solUsd(): Promise<number>;
}

export interface JupiterPriceOptions {
  /** `JUPITER_PRICE_URL`, read by the caller (e.g. `https://api.jup.ag/price/v3`). */
  url: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function priceOf(entry: unknown): number | null {
  if (!isRecord(entry)) return null;
  const raw = entry.usdPrice ?? entry.price;
  const price = typeof raw === 'string' ? Number(raw) : raw;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
}

/** Accepts the v3 body `{ [mint]: { usdPrice } }` and the older `{ data: { [mint]: { price } } }`. */
export function parseJupiterPrice(body: unknown, mint: string): number | null {
  if (!isRecord(body)) return null;
  const table = isRecord(body.data) ? body.data : body;
  return priceOf(table[mint]);
}

export class JupiterPriceSource implements PriceSource {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: JupiterPriceOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  async solUsd(): Promise<number> {
    const mint = WSOL_MINT.toBase58();
    const url = new URL(this.opts.url);
    url.searchParams.set('ids', mint);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.opts.apiKey) headers['x-api-key'] = this.opts.apiKey;
    const res = await this.fetchFn(url, { headers });
    if (!res.ok) throw new Error(`Jupiter SOL price request failed: HTTP ${res.status}`);
    const price = parseJupiterPrice(await res.json(), mint);
    if (price === null) throw new Error('Jupiter returned no usable SOL price');
    return price;
  }
}

export class FakePriceSource implements PriceSource {
  constructor(private readonly fixed: number) {}

  solUsd(): Promise<number> {
    return Promise.resolve(this.fixed);
  }
}
