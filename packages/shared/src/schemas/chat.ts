import { z } from 'zod';

import { DEFAULT_MAX_TOKENS, MAX_TOKENS_CAP } from '../constants.js';
import { UsdcAmountSchema } from './common.js';

// Gateway surface (`/v1`). Objects are loose: the gateway forwards OpenAI
// fields it does not know about (`tools`, `response_format`, ...) unchanged.

export const ChatRoleSchema = z.enum([
  'system',
  'developer',
  'user',
  'assistant',
  'tool',
  'function',
]);

export const ChatContentPartSchema = z.looseObject({ type: z.string().min(1) });

export const ChatMessageSchema = z.looseObject({
  role: ChatRoleSchema,
  content: z.union([z.string(), z.array(ChatContentPartSchema), z.null()]).optional(),
  name: z.string().optional(),
});

const MaxTokensSchema = z.int().min(1).max(MAX_TOKENS_CAP);

export const ChatCompletionRequestSchema = z.looseObject({
  model: z.string().min(1).max(128),
  messages: z.array(ChatMessageSchema).min(1),
  max_tokens: MaxTokensSchema.nullish(),
  max_completion_tokens: MaxTokensSchema.nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  // The hold estimate covers a single choice.
  n: z.literal(1).nullish(),
  stream: z.boolean().nullish(),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).nullish(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).nullish(),
  tools: z.array(z.looseObject({ type: z.string() })).optional(),
  user: z.string().optional(),
});

export function effectiveMaxTokens(request: ChatCompletionRequest): number {
  return request.max_completion_tokens ?? request.max_tokens ?? DEFAULT_MAX_TOKENS;
}

export const UsageSchema = z.looseObject({
  prompt_tokens: z.int().min(0),
  completion_tokens: z.int().min(0),
  total_tokens: z.int().min(0).optional(),
});

export const ChatChoiceSchema = z.looseObject({
  index: z.int().min(0),
  message: ChatMessageSchema,
  finish_reason: z.string().nullable(),
});

/** Billable only when the upstream body parses and carries a `choices` array (L146). */
export const ChatCompletionResponseSchema = z.looseObject({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.int(),
  model: z.string(),
  choices: z.array(ChatChoiceSchema),
  usage: UsageSchema.nullish(),
});

export const ChatCompletionChunkSchema = z.looseObject({
  id: z.string(),
  object: z.literal('chat.completion.chunk'),
  created: z.int(),
  model: z.string(),
  choices: z.array(z.looseObject({ index: z.int().min(0) })),
  usage: UsageSchema.nullish(),
});

export const GatewayModelSchema = z.object({
  id: z.string(),
  object: z.literal('model'),
  created: z.int(),
  owned_by: z.string(),
  pricing: z.object({
    input_per_mtok_usdc: UsdcAmountSchema,
    output_per_mtok_usdc: UsdcAmountSchema,
  }),
});

export const GatewayModelListSchema = z.object({
  object: z.literal('list'),
  data: z.array(GatewayModelSchema),
});

export const GATEWAY_RESPONSE_HEADERS = Object.freeze({
  requestId: 'X-Request-Id',
  costUsdc: 'X-Cost-Usdc',
  balanceUsdc: 'X-Balance-Usdc',
  discountBps: 'X-Discount-Bps',
  idempotencyReplayed: 'Idempotency-Replayed',
});

export const GATEWAY_REQUEST_HEADERS = Object.freeze({
  requestId: 'X-Request-Id',
  idempotencyKey: 'Idempotency-Key',
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;
export type ChatCompletionChunk = z.infer<typeof ChatCompletionChunkSchema>;
export type GatewayModel = z.infer<typeof GatewayModelSchema>;
export type GatewayModelList = z.infer<typeof GatewayModelListSchema>;
