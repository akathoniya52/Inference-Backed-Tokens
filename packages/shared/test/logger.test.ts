import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';

import {
  REDACT_PATHS,
  createLogAlerter,
  createLogger,
  decrypt,
  encrypt,
} from '../src/node/index.js';

// Deliberately fake; the only secret-shaped value in this file.
const FAKE_UPSTREAM_KEY = 'sk-fake-upstream-key-must-never-be-logged';

function capture(redact?: string[]) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({ level: 'info', name: 'gateway', redact }, destination);
  return {
    logger,
    output: () => lines.join(''),
    records: () => lines.map((line): unknown => JSON.parse(line)),
  };
}

function upstreamFailure() {
  const masterKey = randomBytes(32).toString('hex');
  const apiKey = decrypt(encrypt(FAKE_UPSTREAM_KEY, masterKey), masterKey);
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  const req = { method: 'POST', url: 'https://upstream.test/v1/chat/completions', headers };
  const err = Object.assign(new Error('upstream responded 401'), { status: 401, headers });
  return { apiKey, req, err };
}

describe('createLogger', () => {
  it('redacts exactly the documented paths', () => {
    expect(REDACT_PATHS).toEqual([
      'req.headers.authorization',
      'err.headers',
      '*.apiKey',
      '*.apiKeyEnc',
      'MASTER_KEY',
      'JWT_SECRET',
      'ADMIN_TOKEN',
      'KEEPER_SECRET_KEY',
      'TREASURY_SECRET_KEY',
      'err.headers.authorization',
      'headers.authorization',
      '*.headers.authorization',
      'err.config.headers.authorization',
    ]);
  });

  const placements: [string, (logger: Logger, key: string) => void][] = [
    [
      'req.headers.authorization (bearer token)',
      (log, key) => log.info({ req: { headers: { authorization: `Bearer ${key}` } } }, 'request'),
    ],
    [
      'err.headers on an error logged as the first argument',
      (log, key) =>
        log.error(Object.assign(new Error('401'), { headers: { authorization: key } }), 'failed'),
    ],
    [
      'err.config.headers.authorization',
      (log, key) =>
        log.error(
          {
            err: Object.assign(new Error('timeout'), {
              config: { headers: { authorization: key } },
            }),
          },
          'failed',
        ),
    ],
    [
      'a nested upstream.apiKey',
      (log, key) =>
        log.info({ upstream: { baseUrl: 'https://upstream.test', apiKey: key } }, 'call'),
    ],
    [
      'top-level headers.authorization',
      (log, key) => log.info({ headers: { authorization: key } }, 'headers'),
    ],
    [
      'headers.authorization under any top-level key',
      (log, key) => log.info({ upstreamRequest: { headers: { authorization: key } } }, 'call'),
    ],
  ];

  it.each(placements)('keeps the key out of %s', (_label, logSecret) => {
    const { logger, output } = capture();
    logSecret(logger, FAKE_UPSTREAM_KEY);
    expect(output()).toContain('[Redacted]');
    expect(output()).not.toContain(FAKE_UPSTREAM_KEY);
  });

  it('an upstream-error record built from the outgoing request never contains the decrypted key', () => {
    const { logger, output, records } = capture();
    const { apiKey, req, err } = upstreamFailure();
    const apiKeyEnc = encrypt(apiKey, randomBytes(32).toString('hex'));

    logger.error(
      {
        requestId: 'req_1',
        req,
        err,
        upstream: { baseUrl: 'https://upstream.test', apiKey, apiKeyEnc },
      },
      'upstream error',
    );

    expect(output()).not.toContain(FAKE_UPSTREAM_KEY);
    expect(output()).not.toContain(apiKeyEnc);
    expect(records()).toEqual([
      expect.objectContaining({
        msg: 'upstream error',
        requestId: 'req_1',
        req: {
          method: 'POST',
          url: 'https://upstream.test/v1/chat/completions',
          headers: { authorization: '[Redacted]', 'content-type': 'application/json' },
        },
        err: expect.objectContaining({
          message: 'upstream responded 401',
          status: 401,
          headers: '[Redacted]',
        }) as unknown,
        upstream: {
          baseUrl: 'https://upstream.test',
          apiKey: '[Redacted]',
          apiKeyEnc: '[Redacted]',
        },
      }) as unknown,
    ]);
  });

  it('leaves the logged objects intact for the caller', () => {
    const { logger } = capture();
    const { apiKey, req, err } = upstreamFailure();
    logger.error({ req, err, upstream: { apiKey } }, 'upstream error');
    expect(req.headers.authorization).toBe(`Bearer ${FAKE_UPSTREAM_KEY}`);
    expect(err.headers).toBe(req.headers);
  });

  it('censors secret env names logged at the top level', () => {
    const { logger, output, records } = capture();
    const secretNames = [
      'MASTER_KEY',
      'JWT_SECRET',
      'ADMIN_TOKEN',
      'KEEPER_SECRET_KEY',
      'TREASURY_SECRET_KEY',
    ];
    const env = Object.fromEntries(secretNames.map((name) => [name, FAKE_UPSTREAM_KEY]));

    logger.info({ ...env, CLUSTER: 'devnet' }, 'config loaded');

    expect(output()).not.toContain(FAKE_UPSTREAM_KEY);
    expect(records()[0]).toMatchObject({
      CLUSTER: 'devnet',
      ...Object.fromEntries(secretNames.map((name) => [name, '[Redacted]'])),
    });
  });

  it('appends caller redact paths to the defaults', () => {
    const { logger, output } = capture(['wallet.seed']);
    logger.info({ wallet: { seed: FAKE_UPSTREAM_KEY }, upstream: { apiKey: FAKE_UPSTREAM_KEY } });
    expect(output()).not.toContain(FAKE_UPSTREAM_KEY);
  });

  it('applies the level threshold and stamps the name', () => {
    const { logger, records } = capture();
    logger.debug('dropped');
    logger.info('kept');
    expect(records()).toEqual([expect.objectContaining({ name: 'gateway', msg: 'kept' })]);
  });
});

describe('createLogAlerter', () => {
  it('logs each alert at its level with the body fields and an alert marker', async () => {
    const { logger, records } = capture();
    const alerter = createLogAlerter(logger);

    await alerter.alert('info', 'settlement done', { modelId: 'm1' });
    await alerter.alert('warn', 'keeper float low', { sol: 0.4 });
    await alerter.alert('error', 'settlement stuck');

    expect(records()).toEqual([
      expect.objectContaining({ level: 30, msg: 'settlement done', alert: true, modelId: 'm1' }),
      expect.objectContaining({ level: 40, msg: 'keeper float low', alert: true, sol: 0.4 }),
      expect.objectContaining({ level: 50, msg: 'settlement stuck', alert: true }),
    ]);
  });

  it('redacts secrets in the alert body', async () => {
    const { logger, output } = capture();
    await createLogAlerter(logger).alert('error', 'upstream down', {
      upstream: { apiKey: FAKE_UPSTREAM_KEY },
    });
    expect(output()).not.toContain(FAKE_UPSTREAM_KEY);
  });
});
