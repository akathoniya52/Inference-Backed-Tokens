import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  CreateApiKeyRequestSchema,
  CreateModelRequestSchema,
  DepositRequestSchema,
  DepositResponseSchema,
  ErrorEnvelopeSchema,
  LaunchConfirmRequestSchema,
  LaunchConfirmResponseSchema,
  ModelSchema,
  NonceRequestSchema,
  PaginationQuerySchema,
  PublicKeySchema,
  QuoteQuerySchema,
  SplitsSchema,
  TokenStateResponseSchema,
  TxSignatureSchema,
  UpdateModelRequestSchema,
  UsageQuerySchema,
  VerifyRequestSchema,
  buildSignInMessage,
  effectiveMaxTokens,
  type ChatCompletionRequest,
} from '../src/index.js';

const key = (seed: number) => bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => seed + i));
const sig = (seed: number) => bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => seed + i));

const MINT = key(1);
const POOL = key(2);
const WALLET = key(3);
const MODEL_ID = '66f1a2b3c4d5e6f708192a3b';

/** Parse the JSON text and require the result to re-serialize to the same JSON. */
function roundTrip(schema: z.ZodType, json: string): void {
  const input: unknown = JSON.parse(json);
  const parsed = schema.parse(input);
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(input);
}

describe('spec examples round-trip (L409–455)', () => {
  // Abbreviated spec values ("9xQe...", "5Yx...") are replaced with valid base58.
  it('chat completion request (L412)', () => {
    roundTrip(
      ChatCompletionRequestSchema,
      '{"model": "llama-3.1-8b-fast", "messages": [{"role": "user", "content": "Hello"}], "max_tokens": 256, "stream": false}',
    );
  });

  it('deposit request and 200 (L434–435)', () => {
    roundTrip(DepositRequestSchema, JSON.stringify({ txSignature: sig(5) }));
    roundTrip(
      DepositResponseSchema,
      '{"credited": true, "amountUsdc": "25.000000", "balanceUsdc": "31.420000"}',
    );
  });

  it('deposit errors (L436–437) once the handler fills message and requestId', () => {
    roundTrip(
      ErrorEnvelopeSchema,
      '{"error": {"code": "deposit_already_credited", "message": "deposit already credited", "requestId": "req_1"}}',
    );
    roundTrip(
      ErrorEnvelopeSchema,
      '{"error": {"code": "deposit_invalid", "message": "memo does not match depositRef", "requestId": "req_2"}}',
    );
  });

  it('launch confirm request, 200 and 422 (L444–446)', () => {
    roundTrip(
      LaunchConfirmRequestSchema,
      JSON.stringify({ modelId: MODEL_ID, mint: MINT, signature: sig(3) }),
    );
    roundTrip(
      LaunchConfirmResponseSchema,
      JSON.stringify({ token: { status: 'curve', mint: MINT, dbcPool: POOL, progress: 0 } }),
    );
    roundTrip(
      ErrorEnvelopeSchema,
      '{"error": {"code": "pool_mismatch", "message": "pool creator is not the model owner", "requestId": "r"}}',
    );
  });

  it('token state (L453–454)', () => {
    roundTrip(
      TokenStateResponseSchema,
      JSON.stringify({
        phase: 'curve',
        progress: 0.42,
        quoteReserveSol: '4.2',
        priceSolPerToken: '0.0000000061',
        dbcPool: POOL,
        dammV2Pool: null,
        lockedLiquiditySol: '0.8',
        stats: { requests24h: 1180, successRate: 0.992, revenueUsdc24h: '14.30' },
      }),
    );
  });

  it('402 carries shortfallUsdc inside error', () => {
    roundTrip(
      ErrorEnvelopeSchema,
      '{"error": {"code": "insufficient_credits", "message": "m", "requestId": "r", "shortfallUsdc": "0.120000"}}',
    );
  });
});

describe('ChatCompletionRequest', () => {
  const base = { model: 'mock-llm', messages: [{ role: 'user', content: 'Hello' }] };

  it('passes unknown OpenAI fields through', () => {
    const body = {
      ...base,
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      response_format: { type: 'json_object' },
      seed: 7,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], extra: 1 }],
    };
    expect(ChatCompletionRequestSchema.parse(body)).toEqual(body);
  });

  it('requires model and messages', () => {
    expect(ChatCompletionRequestSchema.safeParse({ messages: base.messages }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ model: 'm' }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, messages: [] }).success).toBe(false);
  });

  it('rejects a non-string model', () => {
    for (const model of [42, null, { id: 'x' }, ['m'], '']) {
      expect(ChatCompletionRequestSchema.safeParse({ ...base, model }).success).toBe(false);
    }
  });

  it('caps max_tokens at 8192', () => {
    expect(ChatCompletionRequestSchema.safeParse({ ...base, max_tokens: 8192 }).success).toBe(true);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, max_tokens: 8193 }).success).toBe(
      false,
    );
    expect(ChatCompletionRequestSchema.safeParse({ ...base, max_tokens: 0 }).success).toBe(false);
    expect(
      ChatCompletionRequestSchema.safeParse({ ...base, max_completion_tokens: 9000 }).success,
    ).toBe(false);
  });

  it('rejects unknown roles, bad temperature and n > 1', () => {
    const bad = [
      { ...base, messages: [{ role: 'robot', content: 'x' }] },
      { ...base, temperature: 3 },
      { ...base, n: 2 },
      { ...base, stream: 'yes' },
    ];
    for (const body of bad) expect(ChatCompletionRequestSchema.safeParse(body).success).toBe(false);
  });

  it('effectiveMaxTokens prefers max_completion_tokens, then max_tokens, then 1024', () => {
    const parse = (b: object): ChatCompletionRequest => ChatCompletionRequestSchema.parse(b);
    expect(effectiveMaxTokens(parse(base))).toBe(1024);
    expect(effectiveMaxTokens(parse({ ...base, max_tokens: 64 }))).toBe(64);
    expect(effectiveMaxTokens(parse({ ...base, max_tokens: 64, max_completion_tokens: 32 }))).toBe(
      32,
    );
  });
});

describe('ChatCompletionResponse', () => {
  it('requires a choices array and keeps upstream extras', () => {
    const body = {
      id: 'c1',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      system_fingerprint: 'fp',
    };
    expect(ChatCompletionResponseSchema.parse(body)).toEqual(body);
    const { choices: _choices, ...noChoices } = body;
    expect(ChatCompletionResponseSchema.safeParse(noChoices).success).toBe(false);
  });
});

describe('platform requests', () => {
  it('validates base58 keys and signatures by decoded length', () => {
    expect(PublicKeySchema.safeParse(MINT).success).toBe(true);
    expect(PublicKeySchema.safeParse(sig(1)).success).toBe(false);
    expect(PublicKeySchema.safeParse('0OIl' + MINT.slice(4)).success).toBe(false);
    expect(TxSignatureSchema.safeParse(sig(1)).success).toBe(true);
    expect(TxSignatureSchema.safeParse(MINT).success).toBe(false);
  });

  it('auth bodies', () => {
    expect(NonceRequestSchema.safeParse({ wallet: WALLET }).success).toBe(true);
    expect(NonceRequestSchema.safeParse({ wallet: 'nope' }).success).toBe(false);
    expect(VerifyRequestSchema.safeParse({ wallet: WALLET, signature: sig(9) }).success).toBe(true);
  });

  it('pagination coerces limit and caps it at 100', () => {
    expect(PaginationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(PaginationQuerySchema.parse({ limit: '100', cursor: 'abc' })).toEqual({
      limit: 100,
      cursor: 'abc',
    });
    expect(PaginationQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(PaginationQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('api key creation', () => {
    expect(CreateApiKeyRequestSchema.parse({ name: ' dev ' })).toEqual({ name: 'dev' });
    expect(CreateApiKeyRequestSchema.safeParse({ name: 'x', dailyCapUsdc: '1.5' }).success).toBe(
      true,
    );
    expect(CreateApiKeyRequestSchema.safeParse({ name: 'x', dailyCapUsdc: '-1' }).success).toBe(
      false,
    );
  });

  it('model registration and patch', () => {
    const create = {
      slug: 'mock-llm',
      name: 'Mock',
      upstream: { baseUrl: 'http://localhost:4010/v1', modelName: 'm', apiKey: 'sk-test' },
      pricing: { inputPerMTokUsdc: '0.2', outputPerMTokUsdc: '0.8' },
    };
    expect(CreateModelRequestSchema.parse(create)).toMatchObject({
      description: '',
      upstream: { supportsStreamUsage: false },
    });
    expect(
      CreateModelRequestSchema.safeParse({
        ...create,
        upstream: { ...create.upstream, baseUrl: 'ftp://x' },
      }).success,
    ).toBe(false);
    expect(CreateModelRequestSchema.safeParse({ ...create, slug: 'Bad Slug' }).success).toBe(false);
    expect(UpdateModelRequestSchema.safeParse({ status: 'paused' }).success).toBe(true);
    expect(UpdateModelRequestSchema.safeParse({ status: 'delisted' }).success).toBe(false);
    expect(UpdateModelRequestSchema.safeParse({}).success).toBe(false);
  });

  it('usage range and quote query', () => {
    expect(UsageQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-02' }).success).toBe(true);
    expect(UsageQuerySchema.safeParse({ from: '2026-10-03', to: '2026-10-02' }).success).toBe(
      false,
    );
    expect(QuoteQuerySchema.safeParse({ side: 'buy', amount: '100000000' }).success).toBe(true);
    expect(QuoteQuerySchema.safeParse({ side: 'buy', amount: '0' }).success).toBe(false);
    expect(QuoteQuerySchema.safeParse({ side: 'buy', amount: '1.5' }).success).toBe(false);
  });

  it('splits must sum to 10000', () => {
    expect(
      SplitsSchema.safeParse({ providerBps: 7000, liquidityBps: 2000, platformBps: 1000 }).success,
    ).toBe(true);
    expect(
      SplitsSchema.safeParse({ providerBps: 7000, liquidityBps: 2000, platformBps: 999 }).success,
    ).toBe(false);
  });
});

describe('model DTO', () => {
  it('strips stored secrets', () => {
    const stored = {
      id: MODEL_ID,
      slug: 'mock-llm',
      name: 'Mock',
      description: '',
      imageUrl: null,
      providerWallet: WALLET,
      status: 'active',
      pricing: { inputPerMTokUsdc: '0.200000', outputPerMTokUsdc: '0.800000' },
      splits: { providerBps: 7000, liquidityBps: 2000, platformBps: 1000 },
      health: { lastOkAt: null, p50LatencyMs: null, consecutiveFailures: 0 },
      token: {
        status: 'none',
        symbol: null,
        mint: null,
        dbcPool: null,
        dammV2Pool: null,
        launchSignature: null,
        migrationSignature: null,
        keeperPosition: null,
      },
      stats: { requests24h: 0, successRate: 1, revenueUsdc24h: '0.000000' },
      createdAt: '2026-10-02T00:00:00.000Z',
      upstream: { baseUrl: 'http://x', modelName: 'm', apiKeyEnc: 'c2VjcmV0' },
    };
    const json = JSON.stringify(ModelSchema.parse(stored));
    expect(json).not.toContain('apiKeyEnc');
    expect(json).not.toContain('upstream');
  });
});

describe('buildSignInMessage (G22)', () => {
  it('renders the fixed template', () => {
    expect(
      buildSignInMessage({
        domain: 'ibt.example',
        wallet: WALLET,
        nonce: 'abc123',
        issuedAt: new Date('2026-10-02T01:02:03.000Z'),
      }),
    ).toBe(
      `ibt.example wants you to sign in with your Solana account:\n${WALLET}\n\nNonce: abc123\nIssued At: 2026-10-02T01:02:03.000Z`,
    );
  });
});
