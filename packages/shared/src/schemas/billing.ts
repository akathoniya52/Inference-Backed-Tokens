import { z } from 'zod';

import {
  IsoDateTimeSchema,
  ObjectIdSchema,
  TxSignatureSchema,
  UsdcAmountSchema,
  paginated,
} from './common.js';

export const DepositRequestSchema = z.object({ txSignature: TxSignatureSchema });

export const DepositResponseSchema = z.object({
  credited: z.literal(true),
  amountUsdc: UsdcAmountSchema,
  balanceUsdc: UsdcAmountSchema,
});

export const LedgerTypeSchema = z.enum(['deposit', 'hold', 'capture', 'release', 'adjust']);
export const HoldStatusSchema = z.enum(['open', 'captured', 'released', 'expired']);

export const LedgerEntrySchema = z.object({
  id: ObjectIdSchema,
  type: LedgerTypeSchema,
  status: HoldStatusSchema.optional(),
  amountUsdc: UsdcAmountSchema,
  balanceAfterUsdc: UsdcAmountSchema.nullable(),
  ref: z.object({
    txSignature: z.string().optional(),
    requestId: z.string().optional(),
    holdId: z.string().optional(),
  }),
  createdAt: IsoDateTimeSchema,
});

export const LedgerResponseSchema = paginated(LedgerEntrySchema);

const DateOrDateTimeSchema = z.union([z.iso.date(), IsoDateTimeSchema]);

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Exclusive end of a usage range: a date-only `to` covers that whole UTC day. */
export function usageRangeEndMs(to: string): number {
  return Date.parse(to) + (DATE_ONLY.test(to) ? DAY_MS : 0);
}

export const UsageQuerySchema = z
  .object({ from: DateOrDateTimeSchema.optional(), to: DateOrDateTimeSchema.optional() })
  .refine(
    (q) => {
      if (!q.from || !q.to) return true;
      const from = Date.parse(q.from);
      return from < usageRangeEndMs(q.to) || from === Date.parse(q.to);
    },
    { message: '`from` must not be after `to`' },
  );

export const UsageRowSchema = z.object({
  date: z.iso.date(),
  modelId: ObjectIdSchema,
  modelSlug: z.string(),
  requests: z.int().min(0),
  promptTokens: z.int().min(0),
  completionTokens: z.int().min(0),
  costUsdc: UsdcAmountSchema,
});

export const UsageResponseSchema = z.object({
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  items: z.array(UsageRowSchema),
});

export type DepositRequest = z.infer<typeof DepositRequestSchema>;
export type DepositResponse = z.infer<typeof DepositResponseSchema>;
export type LedgerType = z.infer<typeof LedgerTypeSchema>;
export type HoldStatus = z.infer<typeof HoldStatusSchema>;
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
export type LedgerResponse = z.infer<typeof LedgerResponseSchema>;
export type UsageQuery = z.infer<typeof UsageQuerySchema>;
export type UsageRow = z.infer<typeof UsageRowSchema>;
export type UsageResponse = z.infer<typeof UsageResponseSchema>;
