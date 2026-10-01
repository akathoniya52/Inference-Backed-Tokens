import { afterEach, describe, expect, it } from 'vitest';

import {
  MOCK_UPSTREAM_PORT,
  createMockUpstream,
  type MockUpstream,
  type MockUpstreamOptions,
} from '../src/index.js';

const AUTH = { Authorization: 'Bearer mock-key', 'Content-Type': 'application/json' };
const BODY = {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Hello there, mock!' },
  ],
};
// prompt chars = 9 + 18 = 27 -> 7 tokens; completion "Echo: Hello there, mock!" = 24 chars -> 6 tokens
const USAGE = { prompt_tokens: 7, completion_tokens: 6, total_tokens: 13 };

interface Completion {
  model: string;
  object: string;
  choices: { message: { role: string; content: string }; finish_reason: string }[];
  usage?: typeof USAGE;
}

interface Chunk {
  object: string;
  model: string;
  choices: { delta: { content?: string }; finish_reason: string | null }[];
  usage?: typeof USAGE;
}

let upstream: MockUpstream | undefined;

async function start(options: MockUpstreamOptions = {}): Promise<MockUpstream> {
  upstream = await createMockUpstream({ port: 0, ...options });
  return upstream;
}

afterEach(async () => {
  await upstream?.close();
  upstream = undefined;
});

async function chat(
  mock: MockUpstream,
  body: object = BODY,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${mock.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...AUTH, ...headers },
    body: JSON.stringify(body),
  });
}

function parseSse(text: string): string[] {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length));
}

describe('@ibt/mock-upstream', () => {
  it('uses port 4010 by default', () => {
    expect(MOCK_UPSTREAM_PORT).toBe(4010);
  });

  it('binds port 0 to a free port and serves /healthz without auth', async () => {
    const mock = await start();
    expect(mock.port).toBeGreaterThan(0);
    const res = await fetch(`${mock.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('lists models', async () => {
    const mock = await start();
    const res = await fetch(`${mock.url}/v1/models`, { headers: AUTH });
    const json = (await res.json()) as { object: string; data: { id: string }[] };
    expect(json.object).toBe('list');
    expect(json.data[0]?.id).toBe('mock-model');
  });

  it('returns a JSON completion with deterministic usage and echoes the model', async () => {
    const mock = await start();
    const res = await chat(mock);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Completion;
    expect(json.object).toBe('chat.completion');
    expect(json.model).toBe('test-model');
    expect(json.choices[0]?.message).toEqual({
      role: 'assistant',
      content: 'Echo: Hello there, mock!',
    });
    expect(json.choices[0]?.finish_reason).toBe('stop');
    expect(json.usage).toEqual(USAGE);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.body).toEqual(BODY);
  });

  it('rejects missing or wrong bearer keys with 401', async () => {
    const mock = await start();
    const missing = await fetch(`${mock.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(missing.status).toBe(401);
    const wrong = await chat(mock, BODY, { Authorization: 'Bearer nope' });
    expect(wrong.status).toBe(401);
  });

  it('accepts any bearer when apiKey is null and honours a custom key', async () => {
    const open = await start({ apiKey: null });
    expect((await chat(open, BODY, { Authorization: 'Bearer test' })).status).toBe(200);
    await open.close();
    const pinned = await start({ apiKey: 'secret' });
    expect((await chat(pinned)).status).toBe(401);
    expect((await chat(pinned, BODY, { Authorization: 'Bearer secret' })).status).toBe(200);
  });

  it('streams SSE chunks ending with [DONE] when stream is true', async () => {
    const mock = await start();
    const res = await chat(mock, { ...BODY, stream: true });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSse(await res.text());
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e) as Chunk);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe(
      'Echo: Hello there, mock!',
    );
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop');
    expect(chunks.some((c) => c.usage)).toBe(false);
  });

  it('emits a final usage chunk when stream_options.include_usage is set', async () => {
    const mock = await start();
    const res = await chat(mock, {
      ...BODY,
      stream: true,
      stream_options: { include_usage: true },
    });
    const events = parseSse(await res.text());
    expect(events.at(-1)).toBe('[DONE]');
    const last = JSON.parse(events.at(-2) ?? '') as Chunk;
    expect(last.choices).toEqual([]);
    expect(last.usage).toEqual(USAGE);
  });

  it('streams in stream mode selected by header even without stream: true', async () => {
    const mock = await start();
    const res = await chat(mock, BODY, { 'x-mock-mode': 'stream' });
    expect(parseSse(await res.text()).at(-1)).toBe('[DONE]');
  });

  it('returns 500 in error500 mode (server option)', async () => {
    const mock = await start({ mode: 'error500' });
    const res = await chat(mock);
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('server_error');
  });

  it('selects a mode via model name suffix', async () => {
    const mock = await start();
    const res = await chat(mock, { ...BODY, model: 'test-model:error500' });
    expect(res.status).toBe(500);
  });

  it('omits usage in no-usage mode, including in streams', async () => {
    const mock = await start();
    const json = (await (
      await chat(mock, BODY, { 'x-mock-mode': 'no-usage' })
    ).json()) as Completion;
    expect(json.choices[0]?.message.content).toBe('Echo: Hello there, mock!');
    expect(json).not.toHaveProperty('usage');

    const res = await chat(
      mock,
      { ...BODY, stream: true, stream_options: { include_usage: true } },
      { 'x-mock-mode': 'no-usage' },
    );
    const events = parseSse(await res.text());
    expect(events.at(-1)).toBe('[DONE]');
    expect(events.slice(0, -1).some((e) => (JSON.parse(e) as Chunk).usage)).toBe(false);
  });

  it('returns a body that is not valid JSON in malformed mode', async () => {
    const mock = await start();
    const res = await chat(mock, BODY, { 'x-mock-mode': 'malformed' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const text = await res.text();
    expect(() => JSON.parse(text) as unknown).toThrow();
  });

  it('ends the stream without [DONE] in stream-no-done mode', async () => {
    const mock = await start();
    const res = await chat(mock, BODY, { 'x-mock-mode': 'stream-no-done' });
    const events = parseSse(await res.text());
    expect(events.length).toBeGreaterThan(0);
    expect(events).not.toContain('[DONE]');
    expect((JSON.parse(events.at(-1) ?? '') as Chunk).choices[0]?.finish_reason).toBe('stop');
  });

  it('delays headers by firstByteDelayMs in slow-first-byte mode', async () => {
    const mock = await start({ firstByteDelayMs: 50 });
    const t0 = performance.now();
    const res = await chat(mock, BODY, { 'x-mock-mode': 'slow-first-byte' });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Completion).usage).toEqual(USAGE);
  });

  it('delays between chunks in slow-stream mode', async () => {
    const mock = await start({ chunkDelayMs: 10 });
    const t0 = performance.now();
    const res = await chat(mock, BODY, { 'x-mock-mode': 'slow-stream' });
    const events = parseSse(await res.text());
    expect(events.at(-1)).toBe('[DONE]');
    expect(performance.now() - t0).toBeGreaterThanOrEqual((events.length - 1) * 10 - 5);
  });

  it('answers invalid JSON request bodies with a 400 JSON error', async () => {
    const mock = await start();
    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: 'POST',
      headers: AUTH,
      body: '{nope',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
      'invalid_request_error',
    );
  });
});
