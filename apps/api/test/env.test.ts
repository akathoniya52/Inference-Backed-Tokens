import { describe, expect, it } from 'vitest';

import { clientsShareProxyIp, loadEnv } from '../src/env.js';
import {
  allowlistTrustsAnyHop,
  loopbackAllowlistBehindProxy,
} from '../src/middleware/adminAuth.js';

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
    expect(env.ALLOW_PRIVATE_UPSTREAMS).toBe(false);
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

  it('normalizes WEB_ORIGIN to a bare origin', () => {
    for (const raw of ['https://app.example.com/', 'https://app.example.com/some/path']) {
      expect(loadEnv({ ...base, WEB_ORIGIN: raw }).WEB_ORIGIN).toBe('https://app.example.com');
    }
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

  it('parses ALLOW_PRIVATE_UPSTREAMS and refuses it on mainnet', () => {
    expect(loadEnv({ ...base, ALLOW_PRIVATE_UPSTREAMS: 'true' }).ALLOW_PRIVATE_UPSTREAMS).toBe(
      true,
    );
    expect(loadEnv({ ...base, ALLOW_PRIVATE_UPSTREAMS: 'false' }).ALLOW_PRIVATE_UPSTREAMS).toBe(
      false,
    );
    expect(() => loadEnv({ ...base, ALLOW_PRIVATE_UPSTREAMS: '1' })).toThrow(
      'ALLOW_PRIVATE_UPSTREAMS',
    );
    expect(() =>
      loadEnv({ ...base, CLUSTER: 'mainnet-beta', ALLOW_PRIVATE_UPSTREAMS: 'true' }),
    ).toThrow('ALLOW_PRIVATE_UPSTREAMS');
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

describe('loopbackAllowlistBehindProxy (startup warning)', () => {
  const flagged = (extra: Record<string, string>) =>
    loopbackAllowlistBehindProxy(loadEnv({ ...base, ...extra }));

  it('flags a loopback-only allowlist while trust proxy is on (the default)', () => {
    expect(flagged({ ADMIN_IP_ALLOWLIST: '127.0.0.1' })).toBe(true);
    expect(flagged({ ADMIN_IP_ALLOWLIST: '127.0.0.1, ::1, ::ffff:127.0.0.1' })).toBe(true);
    expect(flagged({ ADMIN_IP_ALLOWLIST: '::1', TRUST_PROXY: 'true' })).toBe(true);
  });

  it('stays quiet without trust proxy, with no allowlist, or with a non-loopback entry', () => {
    expect(flagged({ ADMIN_IP_ALLOWLIST: '127.0.0.1', TRUST_PROXY: 'false' })).toBe(false);
    expect(flagged({ ADMIN_IP_ALLOWLIST: '127.0.0.1', TRUST_PROXY: '0' })).toBe(false);
    expect(flagged({})).toBe(false);
    expect(flagged({ ADMIN_IP_ALLOWLIST: '127.0.0.1, 10.0.0.5' })).toBe(false);
  });
});

describe('production proxy and admin settings (API-01)', () => {
  const mainnet = {
    ...base,
    CLUSTER: 'mainnet-beta',
    USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    TRUST_PROXY: '1',
    ADMIN_IP_ALLOWLIST: '203.0.113.7',
    API_PUBLIC_URL: 'https://api.example.com/',
  };

  it('requires an explicit TRUST_PROXY other than `true` in production and on mainnet', () => {
    const { TRUST_PROXY: _trust, ...unset } = mainnet;
    expect(() => loadEnv(unset)).toThrow('TRUST_PROXY');
    expect(() => loadEnv({ ...mainnet, TRUST_PROXY: 'true' })).toThrow('TRUST_PROXY');
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow('TRUST_PROXY');
    expect(
      loadEnv({ ...base, NODE_ENV: 'production', TRUST_PROXY: '10.0.0.0/8' }).TRUST_PROXY,
    ).toBe('10.0.0.0/8');
    expect(loadEnv(mainnet).TRUST_PROXY).toBe(1);
    expect(loadEnv({ ...mainnet, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    // Dev keeps its default.
    expect(loadEnv(base).TRUST_PROXY).toBe(1);
  });

  it('refuses an empty ADMIN_IP_ALLOWLIST and a missing API_PUBLIC_URL on mainnet', () => {
    const { ADMIN_IP_ALLOWLIST: _allow, ...noAllowlist } = mainnet;
    expect(() => loadEnv(noAllowlist)).toThrow('ADMIN_IP_ALLOWLIST');
    const { API_PUBLIC_URL: _url, ...noUrl } = mainnet;
    expect(() => loadEnv(noUrl)).toThrow('API_PUBLIC_URL');
    expect(loadEnv(mainnet).API_PUBLIC_URL).toBe('https://api.example.com');
  });

  it('warns for any allowlist while TRUST_PROXY trusts a hop count or every hop', () => {
    const flagged = (extra: Record<string, string>) =>
      allowlistTrustsAnyHop(loadEnv({ ...base, ...extra }));
    expect(flagged({ ADMIN_IP_ALLOWLIST: '203.0.113.7' })).toBe(true);
    expect(flagged({ ADMIN_IP_ALLOWLIST: '203.0.113.7', TRUST_PROXY: 'true' })).toBe(true);
    expect(flagged({ ADMIN_IP_ALLOWLIST: '203.0.113.7', TRUST_PROXY: '10.0.0.0/8' })).toBe(false);
    expect(flagged({ ADMIN_IP_ALLOWLIST: '203.0.113.7', TRUST_PROXY: 'false' })).toBe(false);
    expect(flagged({})).toBe(false);
  });

  it('warns when production runs without trust proxy, as clients share the proxy IP', () => {
    const shared = (extra: Record<string, string>) =>
      clientsShareProxyIp(loadEnv({ ...base, ...extra }));
    expect(shared({ NODE_ENV: 'production', TRUST_PROXY: 'false' })).toBe(true);
    expect(shared({ NODE_ENV: 'production', TRUST_PROXY: '1' })).toBe(false);
    expect(shared({ TRUST_PROXY: 'false' })).toBe(false);
  });
});
