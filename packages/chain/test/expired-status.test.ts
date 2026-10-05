import { Keypair, type SignatureStatus } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

import { RealChainClient } from '../src/client.js';
import { USDC_MINT } from '../src/sdk.js';
import { createFakeChain } from '../src/testing.js';

const treasury = Keypair.generate();
const provider = Keypair.generate().publicKey;
const LAST_VALID = 10_000;

function realClient(reads: {
  finalizedHeight: number;
  status: Pick<SignatureStatus, 'err' | 'confirmationStatus'> | null;
  firstSlot: number;
}) {
  const client = new RealChainClient({ rpcUrl: 'http://127.0.0.1:1', usdcMint: USDC_MINT.devnet });
  const conn = client.rpc.primary;
  const height = vi.spyOn(conn, 'getBlockHeight').mockResolvedValue(reads.finalizedHeight);
  vi.spyOn(conn, 'getSignatureStatuses').mockResolvedValue({
    context: { slot: 1 },
    value: [reads.status && { slot: 1, confirmations: null, ...reads.status }],
  });
  vi.spyOn(conn, 'getMinimumLedgerSlot').mockResolvedValue(reads.firstSlot);
  return { client, height };
}

describe('expiredSignatureStatus', () => {
  it('fake chain: landed, absent, and unknown once history is unavailable', async () => {
    const chain = createFakeChain();
    chain.setUsdc(treasury.publicKey, 5_000_000n);
    const { signature } = await chain.transferUsdc(treasury, provider, 1_000_000n);

    expect(await chain.expiredSignatureStatus(signature, LAST_VALID)).toBe('landed');
    expect(await chain.expiredSignatureStatus('never-sent', LAST_VALID)).toBe('absent');

    chain.setHistoryAvailable(false);
    expect(await chain.signatureStatus(signature)).toBe('unknown');
    expect(await chain.expiredSignatureStatus(signature, LAST_VALID)).toBe('unknown');
    expect(await chain.expiredSignatureStatus('never-sent', LAST_VALID)).toBe('unknown');
  });

  it('real client: absent only when the finalized chain passed expiry and the ledger covers the window', async () => {
    const covered = realClient({ finalizedHeight: LAST_VALID + 1, status: null, firstSlot: 0 });
    expect(await covered.client.expiredSignatureStatus('sig', LAST_VALID)).toBe('absent');
    expect(covered.height).toHaveBeenCalledWith('finalized');

    const pruned = realClient({
      finalizedHeight: LAST_VALID + 1,
      status: null,
      firstSlot: LAST_VALID,
    });
    expect(await pruned.client.expiredSignatureStatus('sig', LAST_VALID)).toBe('unknown');

    const notFinal = realClient({ finalizedHeight: LAST_VALID, status: null, firstSlot: 0 });
    expect(await notFinal.client.expiredSignatureStatus('sig', LAST_VALID)).toBe('unknown');
  });

  it('real client: a status counts only once finalized', async () => {
    const landed = realClient({
      finalizedHeight: LAST_VALID + 1,
      status: { err: null, confirmationStatus: 'finalized' },
      firstSlot: LAST_VALID,
    });
    expect(await landed.client.expiredSignatureStatus('sig', LAST_VALID)).toBe('landed');

    const failed = realClient({
      finalizedHeight: LAST_VALID + 1,
      status: { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'finalized' },
      firstSlot: 0,
    });
    expect(await failed.client.expiredSignatureStatus('sig', LAST_VALID)).toBe('failed');

    const confirmed = realClient({
      finalizedHeight: LAST_VALID + 1,
      status: { err: null, confirmationStatus: 'confirmed' },
      firstSlot: 0,
    });
    expect(await confirmed.client.expiredSignatureStatus('sig', LAST_VALID)).toBe('unknown');
  });
});
