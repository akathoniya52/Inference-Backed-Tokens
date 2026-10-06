import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import express, { type NextFunction, type Request, type Response } from 'express';

export const MOCK_MODES = [
  'ok',
  'stream',
  'error500',
  'slow-first-byte',
  'slow-stream',
  'no-usage',
  'malformed',
  'stream-no-done',
] as const;

export type MockMode = (typeof MOCK_MODES)[number];

export const DEFAULT_MOCK_API_KEY = 'mock-key';
export const DEFAULT_MAX_CALLS = 1000;
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'x-api-key', 'cookie'];

export interface MockUpstreamOptions {
  /** Port to bind; `0` (default) picks a free port. */
  port?: number;
  /** Host to bind (default `127.0.0.1`). */
  host?: string;
  /** Server-wide mode; overridden per request by `x-mock-mode` or a `model:<mode>` suffix. */
  mode?: MockMode;
  /** Expected bearer key (default `mock-key`); `null` accepts any non-empty bearer. */
  apiKey?: string | null;
  /** Delay before headers in `slow-first-byte` mode (default 2000 ms). */
  firstByteDelayMs?: number;
  /** Delay between SSE chunks in `slow-stream` mode (default 500 ms). */
  chunkDelayMs?: number;
  /** How many of the latest requests `calls` keeps (default 1000); older ones are dropped. */
  maxCalls?: number;
}

export interface MockCall {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface MockUpstream {
  url: string;
  port: number;
  server: Server;
  /** The latest `maxCalls` requests, oldest first, with credential headers redacted. */
  calls: MockCall[];
  close: () => Promise<void>;
}

/**
 * Stored instead of a credential: a SHA-256 prefix, so equal secrets still compare equal.
 * The public dev key `mock-key` is kept as sent, so tests can see which key was forwarded.
 */
function redactCredential(value: string): string {
  const match = /^(Bearer\s+)(.*)$/i.exec(value);
  const secret = match?.[2] ?? value;
  if (secret === DEFAULT_MOCK_API_KEY) return value;
  const digest = createHash('sha256').update(secret).digest('hex').slice(0, 12);
  return `${match?.[1] ?? ''}[redacted sha256:${digest}]`;
}

function redactHeaders(headers: MockCall['headers']): MockCall['headers'] {
  const copy = { ...headers };
  for (const name of CREDENTIAL_HEADERS) {
    const value = copy[name];
    if (typeof value === 'string') copy[name] = redactCredential(value);
    else if (Array.isArray(value)) copy[name] = value.map(redactCredential);
  }
  return copy;
}

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

interface ChatBody {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  stream_options?: { include_usage?: unknown } | null;
}

function isMockMode(value: unknown): value is MockMode {
  return typeof value === 'string' && (MOCK_MODES as readonly string[]).includes(value);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) =>
        part !== null &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
}

/** Deterministic token count used for every `usage` field: ceil(chars / 4). */
export function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messagesOf(body: ChatBody): ChatMessage[] {
  return Array.isArray(body.messages)
    ? body.messages.filter((m): m is ChatMessage => m !== null && typeof m === 'object')
    : [];
}

/** Completion text is `Echo: <last user message>`. */
export function completionFor(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  return `Echo: ${lastUser ? contentText(lastUser.content) : ''}`;
}

function usageFor(messages: ChatMessage[], completion: string) {
  const promptTokens = countTokens(messages.map((m) => contentText(m.content)).join(''));
  const completionTokens = countTokens(completion);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function chunksOf(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function resolveMode(req: Request, model: string, fallback: MockMode): MockMode {
  const header = req.get('x-mock-mode');
  if (isMockMode(header)) return header;
  const suffix = model.slice(model.lastIndexOf(':') + 1);
  if (model.includes(':') && isMockMode(suffix)) return suffix;
  return fallback;
}

export async function createMockUpstream(options: MockUpstreamOptions = {}): Promise<MockUpstream> {
  const {
    port = 0,
    host = '127.0.0.1',
    mode: serverMode = 'ok',
    firstByteDelayMs = 2000,
    chunkDelayMs = 500,
    maxCalls = DEFAULT_MAX_CALLS,
  } = options;
  const apiKey = options.apiKey === undefined ? DEFAULT_MOCK_API_KEY : options.apiKey;
  const calls: MockCall[] = [];
  let seq = 0;

  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(express.json({ limit: '1mb' }));

  app.use((req, _res, next) => {
    calls.push({
      method: req.method,
      path: req.path,
      headers: redactHeaders(req.headers),
      body: req.body,
    });
    if (calls.length > maxCalls) calls.splice(0, calls.length - maxCalls);
    next();
  });

  app.use('/v1', (req, res, next) => {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
    const token = match?.[1]?.trim();
    if (!token || (apiKey !== null && token !== apiKey)) {
      res.status(401).json({
        error: {
          message: 'Invalid API key',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
      return;
    }
    next();
  });

  app.get('/v1/models', (_req, res) => {
    res.json({
      object: 'list',
      data: [{ id: 'mock-model', object: 'model', created: 0, owned_by: 'mock-upstream' }],
    });
  });

  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    const body: ChatBody =
      req.body !== null && typeof req.body === 'object' ? (req.body as ChatBody) : {};
    const model = typeof body.model === 'string' ? body.model : 'mock-model';
    const mode = resolveMode(req, model, serverMode);
    const messages = messagesOf(body);
    const completion = completionFor(messages);
    const usage = usageFor(messages, completion);
    const id = `chatcmpl-mock-${++seq}`;
    const created = Math.floor(Date.now() / 1000);

    let closed = false;
    res.on('close', () => {
      closed = true;
    });

    if (mode === 'slow-first-byte') await sleep(firstByteDelayMs);
    if (closed) return;

    if (mode === 'error500') {
      res.status(500).json({
        error: { message: 'Mock upstream failure', type: 'server_error', code: 'mock_error' },
      });
      return;
    }

    if (mode === 'malformed') {
      res.status(200).type('application/json').send('{"id":"chatcmpl-mock","choices":[{');
      return;
    }

    const streaming =
      body.stream === true ||
      mode === 'stream' ||
      mode === 'slow-stream' ||
      mode === 'stream-no-done';

    if (!streaming) {
      res.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: completion },
            finish_reason: 'stop',
          },
        ],
        ...(mode === 'no-usage' ? {} : { usage }),
      });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const includeUsage = body.stream_options?.include_usage === true && mode !== 'no-usage';
    const base = { id, object: 'chat.completion.chunk', created, model };
    const events: unknown[] = [
      {
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      },
      ...chunksOf(completion).map((piece) => ({
        ...base,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      })),
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ...(includeUsage ? [{ ...base, choices: [], usage }] : []),
    ];

    for (const event of events) {
      if (closed) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (mode === 'slow-stream') await sleep(chunkDelayMs);
    }
    if (closed) return;
    if (mode !== 'stream-no-done') res.write('data: [DONE]\n\n');
    res.end();
  });

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status =
      err !== null &&
      typeof err === 'object' &&
      typeof (err as { status?: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 500;
    res.status(status).json({
      error: {
        message: err instanceof Error ? err.message : 'Internal error',
        type: status < 500 ? 'invalid_request_error' : 'server_error',
      },
    });
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, host, (error?: Error) => {
      if (error) reject(error);
      else resolve(s);
    });
  });
  const boundPort = (server.address() as AddressInfo).port;

  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    server,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
