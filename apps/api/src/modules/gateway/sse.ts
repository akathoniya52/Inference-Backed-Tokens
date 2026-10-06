import { ChatCompletionChunkSchema, type ChatCompletionResponse, type Usage } from '@ibt/shared';

const DONE = '[DONE]';
const LF = 0x0a;
const CR = 0x0d;

/** GW-04: one SSE event (its lines plus the unterminated tail) may not grow past this. */
export const MAX_SSE_EVENT_CHARS = 1024 * 1024;
/** GW-04: all output text kept for counting and replay may not grow past this. */
export const MAX_COMPLETION_CHARS = 4 * 1024 * 1024;

/** Why the parser stopped accepting input; the gateway ends the stream as an upstream error. */
export type SseFailure = 'event_too_large' | 'output_too_large' | 'upstream_error_event';

interface ChoiceState {
  content: string;
  toolCalls: unknown[];
  functionCall: { name: string; arguments: string } | null;
  /** Any other non-empty delta field (`reasoning_content`, `refusal`, `audio`, …). */
  extra: Map<string, string>;
  finishReason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** GW-01: anything but null, '', [] and {} is model output. */
function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Incremental parser over the forwarded SSE bytes. It only observes: the
 * gateway forwards the upstream's raw bytes and never re-serializes them.
 * Lines end in CR, LF or CRLF; each character is scanned once (GW-04, GW-12).
 */
export class SseCompletionParser {
  done = false;
  usage: Usage | null = null;
  failure: SseFailure | null = null;
  private readonly decoder = new TextDecoder();
  private line = '';
  private afterCr = false;
  private eventChars = 0;
  private eventType = '';
  private dataLines: string[] = [];
  private outputChars = 0;
  private id = '';
  private created = 0;
  private model = '';
  private readonly choices = new Map<number, ChoiceState>();

  push(chunk: Uint8Array): void {
    if (this.failure) return;
    this.feed(this.decoder.decode(chunk, { stream: true }));
  }

  /** Flushes a trailing event that arrived without its blank-line terminator. */
  end(): void {
    if (this.failure) return;
    this.feed(this.decoder.decode());
    if (this.failure) return;
    if (this.line.length > 0) this.onLine(this.line);
    this.line = '';
    if (!this.failure) this.dispatch();
  }

  /** Concatenated output (content, other delta text, serialized tool/function calls) for tiktoken. */
  completionText(): string {
    return [...this.choices.values()]
      .map((c) => {
        let text = c.content + [...c.extra.values()].join('');
        if (c.toolCalls.length > 0) text += JSON.stringify(c.toolCalls);
        if (c.functionCall) text += c.functionCall.name + c.functionCall.arguments;
        return text;
      })
      .join('');
  }

  /** True once any billable delta (GW-01) or usage went through the parser. */
  hasOutput(): boolean {
    if (this.usage !== null) return true;
    return [...this.choices.values()].some(
      (c) =>
        c.content.length > 0 ||
        c.toolCalls.length > 0 ||
        c.functionCall !== null ||
        c.extra.size > 0,
    );
  }

  /** The stream folded into one non-streamed completion (idempotent replay, L148). */
  assemble(usage: Usage): ChatCompletionResponse {
    const choices = [...this.choices.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({
        index,
        message: {
          ...Object.fromEntries(c.extra),
          role: 'assistant' as const,
          content: c.content,
          ...(c.toolCalls.length > 0 ? { tool_calls: c.toolCalls } : {}),
          ...(c.functionCall ? { function_call: c.functionCall } : {}),
        },
        finish_reason: c.finishReason,
      }));
    return {
      id: this.id,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices,
      usage,
    };
  }

  private feed(text: string): void {
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code === LF && this.afterCr) {
        // Second half of a CRLF whose CR ended the previous line.
        this.afterCr = false;
        start = i + 1;
        continue;
      }
      this.afterCr = false;
      if (code !== CR && code !== LF) continue;
      this.onLine(this.line + text.slice(start, i));
      this.line = '';
      if (this.failure) return;
      start = i + 1;
      this.afterCr = code === CR;
    }
    this.line += text.slice(start);
    if (this.eventChars + this.line.length > MAX_SSE_EVENT_CHARS) this.failure = 'event_too_large';
  }

  private onLine(line: string): void {
    if (line.length === 0) {
      this.dispatch();
      return;
    }
    this.eventChars += line.length;
    if (this.eventChars > MAX_SSE_EVENT_CHARS) {
      this.failure = 'event_too_large';
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventType = value;
  }

  private dispatch(): void {
    const { eventType, dataLines } = this;
    this.eventType = '';
    this.dataLines = [];
    this.eventChars = 0;
    if (eventType === 'error') {
      this.failure = 'upstream_error_event';
      return;
    }
    const data = dataLines.join('\n');
    if (data.length === 0) return;
    if (data.trim() === DONE) {
      this.done = true;
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ChatCompletionChunkSchema.safeParse(json);
    if (!parsed.success) return;
    const chunk = parsed.data;
    this.id ||= chunk.id;
    this.created ||= chunk.created;
    this.model ||= chunk.model;
    if (chunk.usage) this.usage = chunk.usage;
    for (const choice of chunk.choices) this.onChoice(choice);
  }

  private grow(chars: number): boolean {
    this.outputChars += chars;
    if (this.outputChars > MAX_COMPLETION_CHARS) this.failure = 'output_too_large';
    return this.failure === null;
  }

  private onChoice(choice: Record<string, unknown> & { index: number }): void {
    let state = this.choices.get(choice.index);
    if (!state) {
      state = {
        content: '',
        toolCalls: [],
        functionCall: null,
        extra: new Map(),
        finishReason: null,
      };
      this.choices.set(choice.index, state);
    }
    if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason;
    const { delta } = choice;
    if (!isRecord(delta)) return;
    for (const [field, value] of Object.entries(delta)) {
      if (field === 'role' || !isNonEmpty(value)) continue;
      if (field === 'content' && typeof value === 'string') {
        if (this.grow(value.length)) state.content += value;
      } else if (field === 'tool_calls' && Array.isArray(value)) {
        if (this.grow(JSON.stringify(value).length)) state.toolCalls.push(...(value as unknown[]));
      } else if (field === 'function_call' && isRecord(value)) {
        const name = typeof value.name === 'string' ? value.name : '';
        const args = typeof value.arguments === 'string' ? value.arguments : '';
        if (this.grow(name.length + args.length)) {
          state.functionCall ??= { name: '', arguments: '' };
          state.functionCall.name += name;
          state.functionCall.arguments += args;
        }
      } else {
        const text = asText(value);
        if (this.grow(text.length)) state.extra.set(field, (state.extra.get(field) ?? '') + text);
      }
      if (this.failure) return;
    }
  }
}
