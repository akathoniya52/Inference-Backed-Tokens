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

  it('counts text parts of array content; non-text parts count 0', async () => {
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
      3 + count('user') + count('Hello') + count('world') + 3 + count('assistant') + 3;
    expect(n).toBe(expected);
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
