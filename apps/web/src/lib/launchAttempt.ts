import { ObjectIdSchema, PublicKeySchema, TokenSymbolSchema, TxSignatureSchema } from '@ibt/shared';
import { z } from 'zod';

// WEB-02: a launch attempt survives a reload so a pool that already landed is
// confirmed, never paid for twice. Only public data is stored: the mint
// address and the pool signature. The mint keypair's secret stays in memory.

const PendingLaunchSchema = z.object({
  v: z.literal(1),
  modelId: ObjectIdSchema,
  mint: PublicKeySchema,
  symbol: TokenSymbolSchema,
  /** Set as soon as the pool transaction is sent. */
  signature: TxSignatureSchema.nullable(),
});

export type PendingLaunch = z.infer<typeof PendingLaunchSchema>;

const storageKey = (slug: string) => `ibt:launch:${slug}`;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch (error) {
    // Blocked storage (privacy mode, sandboxed frame) throws on access.
    if (error instanceof DOMException) return null;
    throw error;
  }
}

export function loadPendingLaunch(slug: string): PendingLaunch | null {
  const store = storage();
  const raw = store?.getItem(storageKey(slug)) ?? null;
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    value = null;
  }
  const parsed = PendingLaunchSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  store?.removeItem(storageKey(slug));
  return null;
}

export function savePendingLaunch(slug: string, launch: Omit<PendingLaunch, 'v'>): PendingLaunch {
  const record = PendingLaunchSchema.parse({ v: 1, ...launch });
  storage()?.setItem(storageKey(slug), JSON.stringify(record));
  return record;
}

export function clearPendingLaunch(slug: string): void {
  storage()?.removeItem(storageKey(slug));
}
