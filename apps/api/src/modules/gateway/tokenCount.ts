import {
  AUDIO_PART_HOLD_TOKENS,
  AppError,
  FILE_PART_HOLD_TOKENS,
  IMAGE_PART_HOLD_TOKENS,
  MAX_PROMPT_CHARS,
  MAX_PROMPT_STRING_CHARS,
  type ChatCompletionRequest,
  type ChatMessage,
} from '@ibt/shared';
import { get_encoding, type Tiktoken } from 'tiktoken';

export const encoderFactory = {
  create: (): Tiktoken => get_encoding('cl100k_base'),
};

// Shared for the process lifetime; never freed.
let encoder: Tiktoken | undefined;

function getEncoder(): Tiktoken {
  encoder ??= encoderFactory.create();
  return encoder;
}

// tiktoken's BPE is quadratic on long runs without whitespace; counting in
// bounded chunks keeps it linear and only ever overcounts slightly.
const CHUNK_CHARS = 2_000;

function chunkEnd(text: string, start: number): number {
  const limit = start + CHUNK_CHARS;
  if (limit >= text.length) return text.length;
  // Split before whitespace so " word" stays one token in the next chunk.
  for (let i = limit; i > start; i -= 1) {
    if (/\s/.test(text.charAt(i))) return i;
  }
  const code = text.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}

export function count(text: string): number {
  if (text.length === 0) return 0;
  const enc = getEncoder();
  let total = 0;
  for (let start = 0; start < text.length;) {
    const end = chunkEnd(text, start);
    // User text is never special: `<|endoftext|>` counts as plain text instead of throwing.
    total += enc.encode_ordinary(text.slice(start, end)).length;
    start = end;
  }
  return total;
}

type MediaKind = 'image' | 'audio' | 'file';

function mediaKind(type: string): MediaKind | undefined {
  switch (type) {
    case 'image_url':
    case 'image':
    case 'input_image':
      return 'image';
    case 'input_audio':
    case 'audio':
      return 'audio';
    case 'file':
    case 'input_file':
      return 'file';
    default:
      return undefined;
  }
}

/** GW-02: media parts per request; each one may cost the upstream many tokens. */
export const MAX_MEDIA_PARTS = 16;
/** Inline payload characters (base64 or URL) per held token for audio and files. */
export const MEDIA_CHARS_PER_TOKEN = 4;

/**
 * Hold tokens for a media part. GW-02: audio and files (a PDF in `file_data`, say)
 * cost the upstream in proportion to their size, so their surcharge grows with
 * the inline payload, never below the flat minimum. Images keep the flat
 * surcharge: providers resize them, which bounds their tokens whatever the bytes.
 */
function mediaPartTokens(part: { type: string }): number | undefined {
  const kind = mediaKind(part.type);
  if (kind === undefined) return undefined;
  if (kind === 'image') return IMAGE_PART_HOLD_TOKENS;
  const flat = kind === 'audio' ? AUDIO_PART_HOLD_TOKENS : FILE_PART_HOLD_TOKENS;
  return Math.max(flat, Math.ceil(JSON.stringify(part).length / MEDIA_CHARS_PER_TOKEN));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function countContent(content: ChatMessage['content']): number {
  if (typeof content === 'string') return count(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      total += count(part.text);
      continue;
    }
    // Any other part reaches the upstream too: a flat surcharge for media,
    // the serialized part for everything else.
    total += mediaPartTokens(part) ?? count(JSON.stringify(part));
  }
  return total;
}

function countJson(value: unknown): number {
  return value === undefined || value === null ? 0 : count(JSON.stringify(value));
}

export type CountableMessage = Pick<ChatMessage, 'content' | 'name'> & {
  role: string;
  tool_calls?: unknown;
  function_call?: unknown;
  tool_call_id?: unknown;
};

// total = Σ(3 + tokens(role) + tokens(content) + tokens(name) + tokens(tool calls)) + 3 reply priming.
export function countMessages(messages: readonly CountableMessage[]): number {
  let total = 3;
  for (const message of messages) {
    total += 3 + count(message.role) + countContent(message.content);
    if (message.name !== undefined) total += count(message.name);
    total += countJson(message.tool_calls) + countJson(message.function_call);
    if (typeof message.tool_call_id === 'string') total += count(message.tool_call_id);
  }
  return total;
}

/** Request fields besides `messages` that reach the upstream's prompt. */
const PROMPT_FIELDS = ['tools', 'functions', 'tool_choice', 'function_call', 'response_format'];

/** Prompt tokens for the hold: the messages plus tool definitions and output schemas. */
export function countPrompt(body: ChatCompletionRequest): number {
  let total = countMessages(body.messages);
  for (const field of PROMPT_FIELDS) total += countJson(body[field]);
  return total;
}

const MAX_PROMPT_DEPTH = 64;

function tooLarge(message: string): AppError {
  return new AppError('invalid_request', { message });
}

/** Exactly the values `countPrompt` tokenizes; media part payloads are not among them. */
function countedValues(body: ChatCompletionRequest): unknown[] {
  const values: unknown[] = [];
  for (const message of body.messages) {
    const { role, content, name, tool_calls, function_call, tool_call_id } = message;
    values.push(role, name, tool_calls, function_call, tool_call_id);
    if (!Array.isArray(content)) {
      values.push(content);
      continue;
    }
    for (const part of content) {
      if (part.type === 'text' && typeof part.text === 'string') values.push(part.text);
      else if (mediaKind(part.type) === undefined) values.push(part);
    }
  }
  for (const field of PROMPT_FIELDS) values.push(body[field]);
  return values;
}

/**
 * A5: rejects a prompt too large to count before tiktoken sees it: every
 * counted string at most `MAX_PROMPT_STRING_CHARS`, all of them together
 * `MAX_PROMPT_CHARS`, and at most `MAX_MEDIA_PARTS` media parts (GW-02).
 */
export function assertPromptSize(body: ChatCompletionRequest): void {
  const mediaParts = body.messages.reduce(
    (sum, message) =>
      sum +
      (Array.isArray(message.content)
        ? message.content.filter((part) => mediaKind(part.type) !== undefined).length
        : 0),
    0,
  );
  if (mediaParts > MAX_MEDIA_PARTS) {
    throw tooLarge(`a request may carry at most ${MAX_MEDIA_PARTS} image, audio or file parts`);
  }
  let total = 0;
  const stack = countedValues(body).map((value) => ({ value, depth: 0 }));
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { value, depth } = item;
    if (typeof value === 'string') {
      if (value.length > MAX_PROMPT_STRING_CHARS) {
        throw tooLarge(`a prompt string exceeds ${MAX_PROMPT_STRING_CHARS} characters`);
      }
      total += value.length;
      if (total > MAX_PROMPT_CHARS) {
        throw tooLarge(`the prompt exceeds ${MAX_PROMPT_CHARS} characters`);
      }
      continue;
    }
    if (!isRecord(value)) continue;
    if (depth >= MAX_PROMPT_DEPTH) throw tooLarge('the prompt is nested too deeply');
    for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
  }
}
