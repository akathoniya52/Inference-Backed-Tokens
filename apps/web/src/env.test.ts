import { describe, expect, it } from 'vitest';

import { parseEnv } from './env';

const VALID = {
  VITE_API_URL: 'http://localhost:4000',
  VITE_RPC_URL: 'https://api.devnet.solana.com',
  VITE_CLUSTER: 'devnet',
  VITE_DBC_CONFIG: 'config',
  VITE_USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  VITE_TREASURY_USDC_ATA: 'ata',
};

describe('parseEnv', () => {
  it('accepts a complete environment', () => {
    expect(parseEnv(VALID).VITE_CLUSTER).toBe('devnet');
  });

  it('lists every missing key', () => {
    const { VITE_DBC_CONFIG: _dbc, VITE_USDC_MINT: _mint, ...rest } = VALID;
    expect(() => parseEnv({ ...rest, VITE_RPC_URL: '' })).toThrow(
      'missing: VITE_RPC_URL, VITE_DBC_CONFIG, VITE_USDC_MINT',
    );
  });

  it('names invalid keys separately', () => {
    expect(() => parseEnv({ ...VALID, VITE_CLUSTER: 'testnet', VITE_API_URL: 'nope' })).toThrow(
      'invalid: VITE_API_URL, VITE_CLUSTER',
    );
  });
});
