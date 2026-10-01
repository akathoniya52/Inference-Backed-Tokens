import type { ChatMessage } from '@ibt/shared';
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

export function count(text: string): number {
  return text.length === 0 ? 0 : getEncoder().encode(text).length;
}

function contentText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

export type CountableMessage = Pick<ChatMessage, 'content' | 'name'> & { role: string };

// total = Σ(3 + tokens(role) + tokens(content) + tokens(name)) + 3 reply priming.
export function countMessages(messages: readonly CountableMessage[]): number {
  let total = 3;
  for (const message of messages) {
    total += 3 + count(message.role) + count(contentText(message.content));
    if (message.name !== undefined) total += count(message.name);
  }
  return total;
}
