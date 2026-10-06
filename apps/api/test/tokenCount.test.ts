import {
  ChatCompletionRequestSchema,
  FILE_PART_HOLD_TOKENS,
  IMAGE_PART_HOLD_TOKENS,
  MAX_PROMPT_STRING_CHARS,
  type ChatCompletionRequest,
} from '@ibt/shared';
import { describe, expect, it, vi } from 'vitest';

import type * as TokenCount from '../src/modules/gateway/tokenCount.js';

async function freshModule(): Promise<typeof TokenCount> {
  vi.resetModules();
  return import('../src/modules/gateway/tokenCount.js');
}

describe('tokenCount', () => {
  it('counts "Hello" as 1 cl100k_base token', async () => {
    const { count } = await freshModule();
    expect(count('Hello')).toBe(1);
    expect(count('')).toBe(0);
  });

  it('counts special-token text such as <|endoftext|> as ordinary text', async () => {
    const { count, countPrompt } = await freshModule();
    for (const special of ['<|endoftext|>', '<|fim_prefix|>', '<|im_start|>']) {
      expect(count(special)).toBeGreaterThan(1);
      expect(count(`Hello ${special} world`)).toBeGreaterThan(count('Hello  world'));
    }
    const body = ChatCompletionRequestSchema.parse({
      model: 'm',
      messages: [{ role: 'user', content: 'end <|endoftext|> here' }],
    });
    expect(countPrompt(body)).toBeGreaterThan(0);
  });

  it('counts role and string content with per-message overhead', async () => {
    const { count, countMessages } = await freshModule();
    const n = countMessages([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello', name: 'alice' },
    ]);
    const expected =
      3 +
      count('system') +
      count('You are helpful.') +
      3 +
      count('user') +
      count('Hello') +
      count('alice') +
      3;
    expect(n).toBe(expected);
  });

  it('counts text parts of array content; an image part adds the flat surcharge', async () => {
    const { count, countMessages } = await freshModule();
    const n = countMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          { type: 'text', text: 'world' },
        ],
      },
      { role: 'assistant', content: null },
    ]);
    const expected =
      3 +
      count('user') +
      count('Hello') +
      IMAGE_PART_HOLD_TOKENS +
      count('world') +
      3 +
      count('assistant') +
      3;
    expect(n).toBe(expected);
  });

  it('scales the file and audio surcharge with the inline payload (GW-02)', async () => {
    const { countMessages, MEDIA_CHARS_PER_TOKEN } = await freshModule();
    const file = (data: string) => ({
      type: 'file',
      file: { filename: 'doc.pdf', file_data: `data:application/pdf;base64,${data}` },
    });
    const small = countMessages([{ role: 'user', content: [file('AAAA')] }]);
    const big = countMessages([{ role: 'user', content: [file('A'.repeat(600_000))] }]);
    // The flat minimum for a small file, about one token per 4 payload chars for a large one.
    expect(small).toBeGreaterThanOrEqual(FILE_PART_HOLD_TOKENS);
    expect(big).toBeGreaterThanOrEqual(600_000 / MEDIA_CHARS_PER_TOKEN);
    const image = countMessages([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'A'.repeat(600_000) } }] },
    ]);
    expect(image).toBeLessThan(IMAGE_PART_HOLD_TOKENS + 20);
  });

  it(`rejects more media parts than the cap (GW-02)`, async () => {
    const { assertPromptSize, MAX_MEDIA_PARTS } = await freshModule();
    const withImages = (n: number) =>
      ChatCompletionRequestSchema.parse({
        model: 'm',
        messages: [
          {
            role: 'user',
            content: Array.from({ length: n }, () => ({
              type: 'image_url',
              image_url: { url: 'https://example.com/a.png' },
            })),
          },
        ],
      });
    expect(() => {
      assertPromptSize(withImages(MAX_MEDIA_PARTS));
    }).not.toThrow();
    expect(() => {
      assertPromptSize(withImages(MAX_MEDIA_PARTS + 1));
    }).toThrow(/at most/);
  });

  it('counts unknown parts, tool calls and tool definitions (A4)', async () => {
    const { count, countMessages, countPrompt } = await freshModule();
    const part = { type: 'refusal', refusal: 'no' };
    const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }];
    expect(countMessages([{ role: 'user', content: [part] }])).toBe(
      3 + 3 + count('user') + count(JSON.stringify(part)),
    );
    expect(countMessages([{ role: 'assistant', content: null, tool_calls: toolCalls }])).toBe(
      3 + 3 + count('assistant') + count(JSON.stringify(toolCalls)),
    );

    const messages = [{ role: 'user' as const, content: 'Hi' }];
    const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }];
    const responseFormat = { type: 'json_schema', json_schema: { name: 's', schema: {} } };
    expect(countPrompt({ model: 'm', messages, tools, response_format: responseFormat })).toBe(
      countMessages(messages) +
        count(JSON.stringify(tools)) +
        count(JSON.stringify(responseFormat)),
    );
  });

  it('counts a 200 KB run without whitespace in chunks, quickly (A5)', async () => {
    const { count } = await freshModule();
    count('warm up');
    const started = performance.now();
    const n = count('a'.repeat(200_000));
    expect(performance.now() - started).toBeLessThan(1_500);
    // Chunking may only overcount, never undercount: 'a' × 8 is one token at best.
    expect(n).toBeGreaterThanOrEqual(200_000 / 8);
    expect(count(`${'word '.repeat(1_000)}end`)).toBeGreaterThanOrEqual(1_001);
  });

  it('assertPromptSize rejects oversized strings and totals but skips media payloads', async () => {
    const { assertPromptSize } = await freshModule();
    const body = (content: unknown, extra: object = {}): ChatCompletionRequest =>
      ChatCompletionRequestSchema.parse({
        model: 'm',
        messages: [{ role: 'user', content }],
        ...extra,
      });
    const big = 'a'.repeat(MAX_PROMPT_STRING_CHARS + 1);
    const stringTooLarge = /a prompt string exceeds/;

    expect(() => assertPromptSize(body(big))).toThrow(stringTooLarge);
    expect(() =>
      assertPromptSize(body('hi', { tools: [{ type: 'function', description: big }] })),
    ).toThrow(stringTooLarge);
    const many = Array.from({ length: 5 }, () => ({ type: 'text', text: 'b'.repeat(60_000) }));
    expect(() => assertPromptSize(body(many))).toThrow(/the prompt exceeds/);
    // A message that pretends to be an image part is still checked.
    expect(() =>
      assertPromptSize(
        ChatCompletionRequestSchema.parse({
          model: 'm',
          messages: [{ role: 'user', type: 'image_url', content: big }],
        }),
      ),
    ).toThrow(stringTooLarge);

    const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${big}` } };
    expect(() =>
      assertPromptSize(body([image, { type: 'text', text: 'what is this?' }])),
    ).not.toThrow();
  });

  it('constructs the encoder exactly once across 1,000 calls', async () => {
    const mod = await freshModule();
    const spy = vi.spyOn(mod.encoderFactory, 'create');
    for (let i = 0; i < 1000; i++) {
      mod.count(`message number ${i}`);
    }
    mod.countMessages([{ role: 'user', content: 'Hello' }]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
