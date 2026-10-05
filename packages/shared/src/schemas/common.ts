import bs58 from 'bs58';
import { z } from 'zod';

import {
  BPS_DENOMINATOR,
  CLUSTERS,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  USDC_DECIMALS,
} from '../constants.js';

function base58OfLength(bytes: number, label: string) {
  // Longest base58 text of `bytes` bytes (44 for a key, 88 for a signature),
  // checked first and aborting, so oversized input never reaches the decoder.
  const maxChars = Math.ceil((bytes * Math.log(256)) / Math.log(58));
  return z
    .string()
    .max(maxChars, { message: `${label} must be at most ${maxChars} characters`, abort: true })
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, `${label} must be base58`)
    .refine((value) => bs58.decodeUnsafe(value)?.length === bytes, {
      message: `${label} must decode to ${bytes} bytes`,
    });
}

export const PublicKeySchema = base58OfLength(32, 'public key');
export const TxSignatureSchema = base58OfLength(64, 'signature');
export const ObjectIdSchema = z.string().regex(/^[a-f0-9]{24}$/, 'must be a 24-hex ObjectId');
export const ClusterSchema = z.enum(CLUSTERS);
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Non-negative base units (lamports, token base units) as an integer string. */
export const BaseUnitsSchema = z.string().regex(/^\d+$/, 'must be an integer string');
/** Any decimal amount for display, e.g. `"4.2"` SOL or `"14.30"` USDC. */
export const DecimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');
/** USDC as produced by `microToUsdcString`: always 6 decimals, may be negative. */
export const UsdcAmountSchema = z
  .string()
  .regex(new RegExp(`^-?\\d+\\.\\d{${USDC_DECIMALS}}$`), 'must be USDC with 6 decimals');
/** USDC typed by a user: non-negative, up to 6 decimals. */
export const UsdcInputSchema = z
  .string()
  .regex(new RegExp(`^\\d+(\\.\\d{1,${USDC_DECIMALS}})?$`), 'must be USDC with up to 6 decimals');

export const BpsSchema = z.int().min(0).max(BPS_DENOMINATOR);
export const SplitsSchema = z
  .object({ providerBps: BpsSchema, liquidityBps: BpsSchema, platformBps: BpsSchema })
  .refine((s) => s.providerBps + s.liquidityBps + s.platformBps === BPS_DENOMINATOR, {
    message: `splits must sum to ${BPS_DENOMINATOR} bps`,
  });

export const IdParamsSchema = z.object({ id: ObjectIdSchema });

export const PaginationQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

export function paginated<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().min(1).nullable() });
}

/**
 * `{error: {code, message, requestId}}` (L260, L457). Extra keys such as
 * `shortfallUsdc` on 402 travel inside `error`. `requestId` is added by the
 * api error handler, so it is optional here.
 */
export const ErrorEnvelopeSchema = z.object({
  error: z.looseObject({
    code: z.string().min(1),
    message: z.string(),
    requestId: z.string().min(1).optional(),
  }),
});

export type PublicKey = z.infer<typeof PublicKeySchema>;
export type Splits = z.infer<typeof SplitsSchema>;
export type IdParams = z.infer<typeof IdParamsSchema>;
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
