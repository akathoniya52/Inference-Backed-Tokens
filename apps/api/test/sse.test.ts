import { describe, expect, it } from 'vitest';

import {
  MAX_COMPLETION_CHARS,
  MAX_SSE_EVENT_CHARS,
  SseCompletionParser,
} from '../src/modules/gateway/sse.js';

const encoder = new TextEncoder();

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  });
}

function feed(parser: SseCompletionParser, ...parts: string[]): SseCompletionParser {
  for (const part of parts) parser.push(encoder.encode(part));
  return parser;
}

describe('SseCompletionParser', () => {
  it('counts reasoning, refusal and function_call deltas as output (GW-01)', () => {
    const reasoning = feed(
      new SseCompletionParser(),
      `data: ${chunk({ role: 'assistant' })}\n\n`,
      `data: ${chunk({ reasoning_content: 'thinking…' })}\n\n`,
    );
    expect(reasoning.hasOutput()).toBe(true);
    expect(reasoning.completionText()).toBe('thinking…');

    const roleOnly = feed(new SseCompletionParser(), `data: ${chunk({ role: 'assistant' })}\n\n`);
    expect(roleOnly.hasOutput()).toBe(false);
    const empty = feed(
      new SseCompletionParser(),
      `data: ${chunk({ content: '', tool_calls: [], refusal: null })}\n\n`,
    );
    expect(empty.hasOutput()).toBe(false);

    const legacy = feed(
      new SseCompletionParser(),
      `data: ${chunk({ function_call: { name: 'get_weather', arguments: '{"ci' } })}\n\n`,
      `data: ${chunk({ function_call: { arguments: 'ty":"Oslo"}' } })}\n\n`,
      `data: ${chunk({ refusal: 'no' })}\n\ndata: [DONE]\n\n`,
    );
    expect(legacy.hasOutput()).toBe(true);
    expect(legacy.completionText()).toBe('noget_weather{"city":"Oslo"}');
    const message = legacy.assemble({ prompt_tokens: 1, completion_tokens: 2 }).choices[0]?.message;
    expect(message).toMatchObject({
      role: 'assistant',
      refusal: 'no',
      function_call: { name: 'get_weather', arguments: '{"city":"Oslo"}' },
    });
  });

  it('accepts CR, LF and CRLF line endings, split anywhere (GW-12)', () => {
    for (const eol of ['\n', '\r', '\r\n']) {
      const text = `data: ${chunk({ content: 'Hi' })}${eol}${eol}data: [DONE]${eol}${eol}`;
      const whole = feed(new SseCompletionParser(), text);
      const bytewise = feed(new SseCompletionParser(), ...text.split(''));
      for (const parser of [whole, bytewise]) {
        expect(parser.done).toBe(true);
        expect(parser.completionText()).toBe('Hi');
      }
    }
  });

  it('treats an `event: error` frame as an upstream error (GW-12)', () => {
    const parser = feed(
      new SseCompletionParser(),
      `data: ${chunk({ content: 'Hi' })}\n\n`,
      'event: error\ndata: {"error":{"message":"overloaded"}}\n\n',
    );
    expect(parser.failure).toBe('upstream_error_event');
    expect(parser.hasOutput()).toBe(true);
  });

  it('caps a pending event and the accumulated output (GW-04)', () => {
    const endless = new SseCompletionParser();
    const piece = `data: ${'x'.repeat(64 * 1024)}`;
    for (let sent = 0; sent <= MAX_SSE_EVENT_CHARS && !endless.failure; sent += piece.length) {
      feed(endless, piece);
    }
    expect(endless.failure).toBe('event_too_large');

    const huge = new SseCompletionParser();
    const content = 'y'.repeat(512 * 1024);
    for (let sent = 0; sent <= MAX_COMPLETION_CHARS && !huge.failure; sent += content.length) {
      feed(huge, `data: ${chunk({ content })}\n\n`);
    }
    expect(huge.failure).toBe('output_too_large');
    expect(huge.completionText().length).toBeLessThanOrEqual(MAX_COMPLETION_CHARS);
  });

  it('scans each byte once, so a large event in small chunks stays linear (GW-04)', () => {
    const parser = new SseCompletionParser();
    const content = 'z'.repeat(400 * 1024);
    const event = `data: ${chunk({ content })}\n\n`;
    const started = performance.now();
    for (let at = 0; at < event.length; at += 64) feed(parser, event.slice(at, at + 64));
    expect(parser.completionText()).toBe(content);
    // Re-splitting the whole buffer per chunk took seconds here; linear scanning takes ms.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
