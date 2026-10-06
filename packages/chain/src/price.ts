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
  /** Abort the request after this long (default `JUPITER_TIMEOUT_MS`). */
  timeoutMs?: number;
  /**
   * Current slot (e.g. `connection.getSlot('confirmed')`). When set, a quote must carry a
   * v3 `blockId` no more than `maxSlotLag` slots behind it, or it is rejected as stale.
   */
  currentSlot?: () => Promise<number>;
  /** Default `JUPITER_MAX_SLOT_LAG`. */
  maxSlotLag?: number;
}

export const JUPITER_TIMEOUT_MS = 10_000;
/** ~5 minutes of slots; SOL's price updates every few slots. */
export const JUPITER_MAX_SLOT_LAG = 750;

export interface JupiterQuote {
  usd: number;
  /** Slot of the last update (v3 `blockId`); null when the response has none. */
  blockId: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function priceOf(entry: unknown): number | null {
  if (!isRecord(entry)) return null;
  const raw = entry.usdPrice ?? entry.price;
  const price = typeof raw === 'string' ? Number(raw) : raw;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
}

function blockIdOf(entry: unknown): number | null {
  if (!isRecord(entry)) return null;
  const { blockId } = entry;
  return typeof blockId === 'number' && Number.isSafeInteger(blockId) && blockId > 0
    ? blockId
    : null;
}

/** Accepts the v3 body `{ [mint]: { usdPrice, blockId } }` and the older `{ data: { [mint]: { price } } }`. */
export function parseJupiterQuote(body: unknown, mint: string): JupiterQuote | null {
  if (!isRecord(body)) return null;
  const table = isRecord(body.data) ? body.data : body;
  const usd = priceOf(table[mint]);
  return usd === null ? null : { usd, blockId: blockIdOf(table[mint]) };
}

export function parseJupiterPrice(body: unknown, mint: string): number | null {
  return parseJupiterQuote(body, mint)?.usd ?? null;
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
    const res = await this.fetchFn(url, {
      headers,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? JUPITER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Jupiter SOL price request failed: HTTP ${res.status}`);
    const quote = parseJupiterQuote(await res.json(), mint);
    if (quote === null) throw new Error('Jupiter returned no usable SOL price');
    if (this.opts.currentSlot) {
      const slot = await this.opts.currentSlot();
      const maxLag = this.opts.maxSlotLag ?? JUPITER_MAX_SLOT_LAG;
      if (quote.blockId === null || slot - quote.blockId > maxLag) {
        throw new Error('Jupiter returned a stale SOL price');
      }
    }
    return quote.usd;
  }
}

export class FakePriceSource implements PriceSource {
  constructor(private readonly fixed: number) {}

  solUsd(): Promise<number> {
    return Promise.resolve(this.fixed);
  }
}
