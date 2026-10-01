import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env.js';

const WALLET = '11111111111111111111111111111111';

const base: Record<string, string> = {
  CLUSTER: 'devnet',
  RPC_URL: 'http://127.0.0.1:8899',
  CHAIN_MODE: 'real',
  USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  DBC_CONFIG: WALLET,
  TREASURY_WALLET: WALLET,
  KEEPER_WALLET: WALLET,
  MONGODB_URI: 'mongodb://db.example.com:27017/ibt?replicaSet=rs0',
  JWT_SECRET: 'x'.repeat(32),
  MASTER_KEY: 'ab'.repeat(32),
  ADMIN_TOKEN: 'y'.repeat(32),
  WEB_ORIGIN: 'http://localhost:5173',
};

describe('api env', () => {
  it('parses a valid env and applies defaults', () => {
    const env = loadEnv({ ...base, JUPITER_API_KEY: '', TELEGRAM_BOT_TOKEN: '' });
    expect(env.TRUST_PROXY).toBe(1);
    expect(env.PORT).toBe(4000);
    expect(env.CHAIN_MODE).toBe('real');
    expect(env.RATE_LIMIT_PER_MIN).toBeUndefined();
    expect(env.DAILY_CAP_USDC).toBeUndefined();
    expect(env.ADMIN_IP_ALLOWLIST).toEqual([]);
    expect(env.JUPITER_API_KEY).toBeUndefined();
  });

  it('parses the optional overrides', () => {
    const env = loadEnv({
      ...base,
      TRUST_PROXY: 'loopback, 10.0.0.0/8',
      RATE_LIMIT_PER_MIN: '120',
      DAILY_CAP_USDC: '12.5',
      ADMIN_IP_ALLOWLIST: '127.0.0.1, ::1',
    });
    expect(env.TRUST_PROXY).toBe('loopback, 10.0.0.0/8');
    expect(env.RATE_LIMIT_PER_MIN).toBe(120);
    expect(env.DAILY_CAP_USDC).toBe('12.5');
    expect(env.ADMIN_IP_ALLOWLIST).toEqual(['127.0.0.1', '::1']);
    expect(loadEnv({ ...base, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(loadEnv({ ...base, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
  });

  it.each(['TREASURY_SECRET_KEY', 'KEEPER_SECRET_KEY'])('rejects startup when %s is set', (key) => {
    const secret = 'super-secret-material';
    expect(() => loadEnv({ ...base, [key]: secret })).toThrow(key);
    try {
      loadEnv({ ...base, [key]: secret });
    } catch (err) {
      expect(String(err)).not.toContain(secret);
    }
  });

  it('refuses CHAIN_MODE=fake unless MONGODB_URI is local', () => {
    expect(() => loadEnv({ ...base, CHAIN_MODE: 'fake' })).toThrow('CHAIN_MODE');
    for (const host of ['localhost', '127.0.0.1']) {
      const env = loadEnv({
        ...base,
        CHAIN_MODE: 'fake',
        MONGODB_URI: `mongodb://${host}:27017/ibt?replicaSet=rs0&directConnection=true`,
      });
      expect(env.CHAIN_MODE).toBe('fake');
    }
  });

  it('refuses CHAIN_MODE=fake on mainnet', () => {
    expect(() =>
      loadEnv({
        ...base,
        CLUSTER: 'mainnet-beta',
        CHAIN_MODE: 'fake',
        MONGODB_URI: 'mongodb://localhost:27017/ibt',
      }),
    ).toThrow('CHAIN_MODE');
  });

  it('rejects missing or malformed required values without echoing them', () => {
    const { JWT_SECRET: _jwt, ...rest } = base;
    expect(() => loadEnv(rest)).toThrow('JWT_SECRET');
    expect(() => loadEnv({ ...base, MASTER_KEY: 'too-short-key' })).toThrow('MASTER_KEY');
    try {
      loadEnv({ ...base, MASTER_KEY: 'too-short-key' });
    } catch (err) {
      expect(String(err)).not.toContain('too-short-key');
    }
  });
});
