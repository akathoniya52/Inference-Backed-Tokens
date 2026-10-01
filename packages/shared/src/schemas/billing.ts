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

export const UsageQuerySchema = z
  .object({ from: DateOrDateTimeSchema.optional(), to: DateOrDateTimeSchema.optional() })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), {
    message: '`from` must not be after `to`',
  });

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
