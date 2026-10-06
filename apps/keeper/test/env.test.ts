import { USDC_MINT } from '@ibt/shared';
import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env.js';

const BASE = {
  CLUSTER: 'devnet',
  RPC_URL: 'http://127.0.0.1:8899',
  USDC_MINT: USDC_MINT.devnet,
  MONGODB_URI: 'mongodb://localhost:27017/ibt',
  JUPITER_PRICE_URL: 'http://127.0.0.1:1/price',
};

describe('keeper env', () => {
  it('starts without DBC_CONFIG, DAMM_V2_FEE_CONFIG, TREASURY_WALLET or DEVNET_E2E', () => {
    const env = loadEnv(BASE);
    expect(env.USDC_MINT).toBe(USDC_MINT.devnet);
    expect(env).not.toHaveProperty('TREASURY_WALLET');
  });

  it('refuses a USDC_MINT that is not the cluster mint', () => {
    expect(() => loadEnv({ ...BASE, CLUSTER: 'mainnet-beta' })).toThrow(
      'invalid environment variables: USDC_MINT',
    );
    expect(() => loadEnv({ ...BASE, USDC_MINT: USDC_MINT['mainnet-beta'] })).toThrow(
      'invalid environment variables: USDC_MINT',
    );
    expect(
      loadEnv({ ...BASE, CLUSTER: 'mainnet-beta', USDC_MINT: USDC_MINT['mainnet-beta'] }).CLUSTER,
    ).toBe('mainnet-beta');
  });

  it('holds ADMIN_TOKEN to the api rule (32+ characters) and treats empty as unset', () => {
    expect(() => loadEnv({ ...BASE, ADMIN_TOKEN: 'replace-me' })).toThrow(
      'invalid environment variables: ADMIN_TOKEN',
    );
    expect(loadEnv({ ...BASE, ADMIN_TOKEN: '' }).ADMIN_TOKEN).toBeUndefined();
    const token = 'a'.repeat(32);
    expect(loadEnv({ ...BASE, ADMIN_TOKEN: token }).ADMIN_TOKEN).toBe(token);
  });

  it('validates RPC_URL_FALLBACK as a URL and treats empty as unset', () => {
    expect(() => loadEnv({ ...BASE, RPC_URL_FALLBACK: 'api.devnet.solana.com' })).toThrow(
      'invalid environment variables: RPC_URL_FALLBACK',
    );
    expect(loadEnv({ ...BASE, RPC_URL_FALLBACK: '' }).RPC_URL_FALLBACK).toBeUndefined();
    expect(
      loadEnv({ ...BASE, RPC_URL_FALLBACK: 'https://api.devnet.solana.com' }).RPC_URL_FALLBACK,
    ).toBe('https://api.devnet.solana.com');
  });
});
