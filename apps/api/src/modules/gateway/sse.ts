import { ChatCompletionChunkSchema, type ChatCompletionResponse, type Usage } from '@ibt/shared';

const EVENT_SEPARATOR = /\r?\n\r?\n/;
const DONE = '[DONE]';

interface ChoiceState {
  content: string;
  toolCalls: unknown[];
  finishReason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Incremental parser over the forwarded SSE bytes. It only observes: the
 * gateway forwards the upstream's raw bytes and never re-serializes them.
 */
export class SseCompletionParser {
  done = false;
  usage: Usage | null = null;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private id = '';
  private created = 0;
  private model = '';
  private readonly choices = new Map<number, ChoiceState>();

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const events = this.buffer.split(EVENT_SEPARATOR);
    this.buffer = events.pop() ?? '';
    for (const event of events) this.onEvent(event);
  }

  /** Flushes a trailing event that arrived without its blank-line terminator. */
  end(): void {
    this.buffer += this.decoder.decode();
    if (this.buffer.trim().length > 0) this.onEvent(this.buffer);
    this.buffer = '';
  }

  /** Concatenated deltas (content plus serialized tool calls) for tiktoken. */
  completionText(): string {
    return [...this.choices.values()]
      .map((c) => (c.toolCalls.length > 0 ? c.content + JSON.stringify(c.toolCalls) : c.content))
      .join('');
  }

  /** True once a billable delta (content, tool calls) or usage went through the parser. */
  hasOutput(): boolean {
    if (this.usage !== null) return true;
    return [...this.choices.values()].some((c) => c.content.length > 0 || c.toolCalls.length > 0);
  }

  /** The stream folded into one non-streamed completion (idempotent replay, L148). */
  assemble(usage: Usage): ChatCompletionResponse {
    const choices = [...this.choices.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({
        index,
        message: {
          role: 'assistant' as const,
          content: c.content,
          ...(c.toolCalls.length > 0 ? { tool_calls: c.toolCalls } : {}),
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

  private onEvent(event: string): void {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
      .join('\n');
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

  private onChoice(choice: Record<string, unknown> & { index: number }): void {
    let state = this.choices.get(choice.index);
    if (!state) {
      state = { content: '', toolCalls: [], finishReason: null };
      this.choices.set(choice.index, state);
    }
    if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason;
    const { delta } = choice;
    if (!isRecord(delta)) return;
    if (typeof delta.content === 'string') state.content += delta.content;
    if (Array.isArray(delta.tool_calls)) state.toolCalls.push(...(delta.tool_calls as unknown[]));
  }
}
