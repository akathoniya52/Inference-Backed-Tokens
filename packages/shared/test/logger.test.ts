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
  redactSecrets,
} from '../src/node/index.js';

describe('redactSecrets', () => {
  it('scrubs URL userinfo, query strings and key-shaped path segments', () => {
    expect(redactSecrets('RPC 429 from https://mainnet.helius-rpc.com/?api-key=abc123')).toBe(
      'RPC 429 from https://mainnet.helius-rpc.com/?***',
    );
    expect(
      redactSecrets('connect mongodb+srv://ibt:hunter2@cluster0.x.net/ibt?retryWrites=1'),
    ).toBe('connect mongodb+srv://***@cluster0.x.net/ibt?***');
    expect(
      redactSecrets('POST https://sol.g.alchemy.com/v2/AbCdEf0123456789AbCdEf0123 failed'),
    ).toBe('POST https://sol.g.alchemy.com/v2/*** failed');
  });

  it('scrubs key parameters and authorization credentials outside URLs', () => {
    expect(redactSecrets('bad api_key=s3cr3t&x=1')).toBe('bad api_key=***&x=1');
    expect(redactSecrets('header Bearer sk-abc.def')).toBe('header Bearer ***');
  });

  it('leaves text without credentials unchanged', () => {
    const text = 'model 6650aa not found at https://api.example.com/v1/models (502)';
    expect(redactSecrets(text)).toBe(text);
  });
});

// Deliberately fake; the only secret-shaped value in this file.
const FAKE_UPSTREAM_KEY = 'sk-fake-upstream-key-must-never-be-logged';

const SECRET_ENV_NAMES = [
  'MASTER_KEY',
  'JWT_SECRET',
  'ADMIN_TOKEN',
  'KEEPER_SECRET_KEY',
  'TREASURY_SECRET_KEY',
  'TELEGRAM_BOT_TOKEN',
  'RPC_URL',
  'RPC_URL_FALLBACK',
  'MONGODB_URI',
  'JUPITER_API_KEY',
  'DEVNET_FUNDER_SECRET_KEY',
];

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
  it('redacts every documented path, each once', () => {
    expect(new Set(REDACT_PATHS).size).toBe(REDACT_PATHS.length);
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        'err.headers',
        '*.apiKey',
        '*.apiKeyEnc',
        'MASTER_KEY',
        'JWT_SECRET',
        'ADMIN_TOKEN',
        'KEEPER_SECRET_KEY',
        'TREASURY_SECRET_KEY',
        'TELEGRAM_BOT_TOKEN',
        '*.MASTER_KEY',
        '*.JWT_SECRET',
        '*.ADMIN_TOKEN',
        '*.KEEPER_SECRET_KEY',
        '*.TREASURY_SECRET_KEY',
        '*.TELEGRAM_BOT_TOKEN',
        'err.headers.authorization',
        'headers.authorization',
        '*.headers.authorization',
        'err.config.headers.authorization',
        '*.*.apiKey',
        '*.*.*.*.apiKey',
        '*.*.headers.authorization',
        'RPC_URL',
        '*.RPC_URL_FALLBACK',
        '*.MONGODB_URI',
        '*.JUPITER_API_KEY',
        '*.DEVNET_FUNDER_SECRET_KEY',
      ]),
    );
  });

  it('censors apiKey and secret env names nested several levels deep (DB-07)', () => {
    const { logger, output } = capture();
    logger.info(
      {
        a: { b: { apiKey: FAKE_UPSTREAM_KEY } },
        c: { d: { e: { f: { apiKey: FAKE_UPSTREAM_KEY } } } },
        cfg: { env: { RPC_URL: FAKE_UPSTREAM_KEY, MONGODB_URI: FAKE_UPSTREAM_KEY } },
        x: { y: { headers: { authorization: FAKE_UPSTREAM_KEY } } },
        DEVNET_FUNDER_SECRET_KEY: FAKE_UPSTREAM_KEY,
      },
      'deep',
    );
    expect(output()).not.toContain(FAKE_UPSTREAM_KEY);
  });

  it('scrubs credentials from logged error messages and stacks', () => {
    const { logger, output } = capture();
    const err = new Error(`fetch failed: https://rpc.helius.test/?api-key=${FAKE_UPSTREAM_KEY}`);
    logger.error({ err }, 'rpc');
    logger.error(new Error(`mongodb+srv://u:${FAKE_UPSTREAM_KEY}@db.test/x failed`), 'mongo');
    expect(output()).not.toContain(FAKE_UPSTREAM_KEY);
    expect(output()).toContain('https://rpc.helius.test/?***');
  });

  const placements: [string, (logger: Logger, key: string) => void][] = [
    [
      'req.headers.authorization (bearer token)',
      (log, key) => log.info({ req: { headers: { authorization: `Bearer ${key}` } } }, 'request'),
    ],
    [
      'req.headers.cookie',
      (log, key) => log.info({ req: { headers: { cookie: `session=${key}` } } }, 'request'),
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
    const env = Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, FAKE_UPSTREAM_KEY]));

    logger.info({ ...env, CLUSTER: 'devnet' }, 'config loaded');

    expect(output()).not.toContain(FAKE_UPSTREAM_KEY);
    expect(records()[0]).toMatchObject({
      CLUSTER: 'devnet',
      ...Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, '[Redacted]'])),
    });
  });

  it('censors secret env names nested one level down', () => {
    const { logger, output, records } = capture();
    const env = Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, FAKE_UPSTREAM_KEY]));

    logger.info({ env: { ...env, CLUSTER: 'devnet' } }, 'config loaded');

    expect(output()).not.toContain(FAKE_UPSTREAM_KEY);
    expect(records()[0]).toMatchObject({
      env: {
        CLUSTER: 'devnet',
        ...Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, '[Redacted]'])),
      },
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
