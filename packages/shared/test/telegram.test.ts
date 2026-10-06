import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  TELEGRAM_BODY_LIMIT,
  createAlerter,
  createLogger,
  createTelegramAlerter,
  type TelegramFetch,
  type TelegramRequestInit,
} from '../src/node/index.js';

// Deliberately fake; must never reach a log line.
const FAKE_BOT_TOKEN = '123456:fake-telegram-bot-token-never-logged';
const CHAT_ID = '-100987654321';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({ level: 'info', name: 'alerts' }, destination);
  return {
    logger,
    output: () => lines.join(''),
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

interface Call {
  url: string;
  init: TelegramRequestInit;
}

function stubFetch(respond: () => Promise<{ ok: boolean; status: number }>) {
  const calls: Call[] = [];
  const fetch: TelegramFetch = (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { fetch, calls };
}

const ok = () => Promise.resolve({ ok: true, status: 200 });

function sentBody(call: Call | undefined): { chat_id: string; text: string } {
  if (!call) throw new Error('fetch was not called');
  return JSON.parse(call.init.body) as { chat_id: string; text: string };
}

describe('createTelegramAlerter', () => {
  it('POSTs sendMessage with level, title and body, and still logs the alert', async () => {
    const { logger, records } = capture();
    const { fetch, calls } = stubFetch(ok);
    const alerter = createTelegramAlerter({
      botToken: FAKE_BOT_TOKEN,
      chatId: CHAT_ID,
      logger,
      fetch,
    });

    await alerter.alert('error', 'float below floor', { lamports: 42 });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(new URL(call?.url ?? '').pathname).toBe(`/bot${FAKE_BOT_TOKEN}/sendMessage`);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.headers['content-type']).toBe('application/json');
    const body = sentBody(call);
    expect(body.chat_id).toBe(CHAT_ID);
    expect(body.text).toContain('[ERROR] float below floor');
    expect(body.text).toContain('"lamports": 42');
    expect(JSON.parse(call?.init.body ?? '{}')).toMatchObject({ disable_web_page_preview: true });

    const logged = records().find((r) => r.msg === 'float below floor');
    expect(logged).toMatchObject({ level: 50, alert: true, lamports: 42 });
  });

  it('sends bigint and Error body fields instead of rejecting, with URLs scrubbed (DB-06)', async () => {
    const { logger } = capture();
    const { fetch, calls } = stubFetch(ok);
    const alerter = createTelegramAlerter({
      botToken: FAKE_BOT_TOKEN,
      chatId: CHAT_ID,
      logger,
      fetch,
    });

    await expect(
      alerter.alert('error', 'settlement failed', {
        lamports: 2n ** 64n,
        err: new TypeError('RPC down: https://rpc.test/?api-key=k3y'),
      }),
    ).resolves.toBeUndefined();

    const { text } = sentBody(calls[0]);
    expect(text).toContain('"lamports": "18446744073709551616"');
    expect(text).toContain('"name": "TypeError"');
    expect(text).toContain('RPC down: https://rpc.test/?***');
    expect(text).not.toContain('k3y');
  });

  it('uses apiBase when given', async () => {
    const { logger } = capture();
    const { fetch, calls } = stubFetch(ok);
    const alerter = createTelegramAlerter({
      botToken: FAKE_BOT_TOKEN,
      chatId: CHAT_ID,
      logger,
      fetch,
      apiBase: 'http://telegram.test',
    });
    await alerter.alert('info', 'hello');
    expect(calls[0]?.url).toBe(`http://telegram.test/bot${FAKE_BOT_TOKEN}/sendMessage`);
    expect(sentBody(calls[0]).text).toBe('[INFO] hello');
  });

  it('resolves and warns on a non-2xx response', async () => {
    const { logger, records, output } = capture();
    const { fetch } = stubFetch(() => Promise.resolve({ ok: false, status: 500 }));
    const alerter = createTelegramAlerter({
      botToken: FAKE_BOT_TOKEN,
      chatId: CHAT_ID,
      logger,
      fetch,
    });

    await expect(alerter.alert('warn', 'reconcile drift')).resolves.toBeUndefined();

    const warn = records().find((r) => r.msg === 'telegram alert failed');
    expect(warn).toMatchObject({ level: 40, status: 500, chatId: CHAT_ID });
    expect(output()).not.toContain(FAKE_BOT_TOKEN);
  });

  it('resolves and warns when fetch throws, scrubbing the token from the error', async () => {
    const { logger, records, output } = capture();
    const { fetch } = stubFetch(() =>
      Promise.reject(
        new Error(`connect failed for https://api.telegram.org/bot${FAKE_BOT_TOKEN}/sendMessage`),
      ),
    );
    const alerter = createTelegramAlerter({
      botToken: FAKE_BOT_TOKEN,
      chatId: CHAT_ID,
      logger,
      fetch,
    });

    await expect(alerter.alert('error', 'boom', { a: 1 })).resolves.toBeUndefined();

    const warn = records().find((r) => r.msg === 'telegram alert failed');
    expect(warn).toMatchObject({ level: 40, apiBase: 'https://api.telegram.org' });
    expect((warn?.err as { message: string }).message).toContain('/bot***/sendMessage');
    expect(output()).not.toContain(FAKE_BOT_TOKEN);
  });

  it(`truncates the body at ${TELEGRAM_BODY_LIMIT} chars with an ellipsis`, async () => {
    const { logger } = capture();
    const { fetch, calls } = stubFetch(ok);
    const alerter = createTelegramAlerter({
      botToken: FAKE_BOT_TOKEN,
      chatId: CHAT_ID,
      logger,
      fetch,
    });

    await alerter.alert('info', 'big', { blob: 'x'.repeat(10_000) });

    const { text } = sentBody(calls[0]);
    const [header, ...rest] = text.split('\n');
    const bodyText = rest.join('\n');
    expect(header).toBe('[INFO] big');
    expect(bodyText).toHaveLength(TELEGRAM_BODY_LIMIT + 1);
    expect(bodyText.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThan(4096);
  });
});

describe('createAlerter', () => {
  it('picks the log transport when token or chat id is missing', async () => {
    for (const env of [
      {},
      { botToken: '', chatId: '' },
      { botToken: FAKE_BOT_TOKEN },
      { chatId: CHAT_ID },
    ]) {
      const { logger, records } = capture();
      const { fetch, calls } = stubFetch(ok);
      const alerter = createAlerter({ ...env, logger, fetch });
      await alerter.alert('warn', 'logged only');
      expect(calls).toHaveLength(0);
      expect(records()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ msg: 'alerter transport selected', transport: 'log' }),
          expect.objectContaining({ msg: 'logged only', alert: true }),
        ]),
      );
    }
  });

  it('picks Telegram when both are set and never logs the token', async () => {
    const { logger, records, output } = capture();
    const { fetch, calls } = stubFetch(ok);
    const alerter = createAlerter({ botToken: FAKE_BOT_TOKEN, chatId: CHAT_ID, logger, fetch });
    await alerter.alert('info', 'sent');
    expect(calls).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      msg: 'alerter transport selected',
      transport: 'telegram',
      chatId: CHAT_ID,
    });
    expect(output()).not.toContain(FAKE_BOT_TOKEN);
  });
});
