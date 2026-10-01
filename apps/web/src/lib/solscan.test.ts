import { describe, expect, it } from 'vitest';

import { addressUrl, txUrl } from './solscan';

describe('solscan links', () => {
  it('adds ?cluster=devnet from VITE_CLUSTER', () => {
    expect(txUrl('5sig')).toBe('https://solscan.io/tx/5sig?cluster=devnet');
    expect(addressUrl('Addr1')).toBe('https://solscan.io/account/Addr1?cluster=devnet');
  });

  it('omits the query on mainnet-beta', () => {
    expect(txUrl('5sig', 'mainnet-beta')).toBe('https://solscan.io/tx/5sig');
    expect(addressUrl('Addr1', 'mainnet-beta')).toBe('https://solscan.io/account/Addr1');
  });
});
