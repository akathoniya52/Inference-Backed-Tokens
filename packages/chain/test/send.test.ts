import { AppError } from '@ibt/shared';
import {
  Connection,
  Keypair,
  SendTransactionError,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

import { sendAndConfirm, type SendConnection } from '../src/send.js';
import { FakeConnection } from '../src/testing/fake-connection.js';

const payer = Keypair.generate();
const nft = Keypair.generate();

function transferTx(): Transaction {
  return new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
}

describe('sendAndConfirm', () => {
  it('accepts a real Connection', () => {
    const connection: SendConnection = new Connection('http://127.0.0.1:1');
    expect(connection).toBeInstanceOf(Connection);
  });

  it('succeeds on the first try', async () => {
    const connection = new FakeConnection();
    const result = await sendAndConfirm({
      connection,
      tx: transferTx(),
      signers: [payer],
      commitment: 'confirmed',
    });
    expect(result).toEqual({ signature: connection.sent[0]?.signature, landed: true, attempts: 1 });
    expect(connection.count('getLatestBlockhash')).toBe(1);
    expect(connection.count('sendRawTransaction')).toBe(1);
    expect(connection.confirmed[0]).toMatchObject({
      signature: result.signature,
      blockhash: connection.blockhashes[0]?.blockhash,
      lastValidBlockHeight: connection.blockhashes[0]?.lastValidBlockHeight,
    });
  });

  it('re-signs with a fresh blockhash after expiry, then succeeds', async () => {
    const connection = new FakeConnection();
    connection.queueConfirm('expired', 'confirmed');
    const buildTx = vi.fn(transferTx);
    const result = await sendAndConfirm({
      connection,
      buildTx,
      signers: [payer],
      commitment: 'confirmed',
    });
    expect(result.attempts).toBe(2);
    expect(buildTx).toHaveBeenCalledTimes(2);
    expect(connection.count('getSignatureStatuses')).toBe(1);
    expect(connection.count('sendRawTransaction')).toBe(2);
    expect(connection.blockhashes[0]?.blockhash).not.toBe(connection.blockhashes[1]?.blockhash);
    expect(connection.sent[0]?.signature).not.toBe(connection.sent[1]?.signature);
    expect(result.signature).toBe(connection.sent[1]?.signature);
  });

  it('returns without resending when the expired tx had landed', async () => {
    const connection = new FakeConnection();
    connection.queueConfirm('expired-landed');
    const result = await sendAndConfirm({
      connection,
      tx: transferTx(),
      signers: [payer],
      commitment: 'confirmed',
    });
    expect(result).toEqual({ signature: connection.sent[0]?.signature, landed: true, attempts: 1 });
    expect(connection.count('sendRawTransaction')).toBe(1);
    expect(connection.count('getSignatureStatuses')).toBe(1);
  });

  it('throws AppError chain_send_failed after 3 failed attempts', async () => {
    const connection = new FakeConnection();
    connection.queueConfirm('expired', 'expired', 'expired', 'confirmed');
    const err = await sendAndConfirm({
      connection,
      tx: transferTx(),
      signers: [payer],
      commitment: 'confirmed',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'chain_send_failed' });
    expect((err as AppError).cause).toBeInstanceOf(Error);
    expect(connection.count('sendRawTransaction')).toBe(3);
  });

  it('never re-signs after a network error on send: the first tx may still land', async () => {
    const connection = new FakeConnection();
    connection.queueSendError(new TypeError('fetch failed'));
    const onSigned = vi.fn();
    const err = await sendAndConfirm({
      connection,
      tx: transferTx(),
      signers: [payer],
      onSigned,
      commitment: 'confirmed',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'chain_send_failed' });
    expect((err as AppError).cause).toEqual(new TypeError('fetch failed'));
    expect(connection.count('sendRawTransaction')).toBe(1);
    expect(connection.count('getLatestBlockhash')).toBe(1);
    expect(onSigned).toHaveBeenCalledTimes(1);
  });

  it('never re-signs after a network error on confirm', async () => {
    const connection = new FakeConnection();
    connection.queueConfirm(new Error('ECONNRESET'));
    const err = await sendAndConfirm({
      connection,
      tx: transferTx(),
      signers: [payer],
      commitment: 'confirmed',
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'chain_send_failed' });
    expect(connection.count('sendRawTransaction')).toBe(1);
  });

  it('re-signs after the RPC rejects the send with SendTransactionError', async () => {
    const connection = new FakeConnection();
    connection.queueSendError(
      new SendTransactionError({
        action: 'send',
        signature: 'x',
        transactionMessage: 'Blockhash not found',
      }),
    );
    const buildTx = vi.fn(transferTx);
    const result = await sendAndConfirm({
      connection,
      buildTx,
      signers: [payer],
      commitment: 'confirmed',
    });
    expect(result.attempts).toBe(2);
    expect(buildTx).toHaveBeenCalledTimes(2);
    expect(connection.count('sendRawTransaction')).toBe(2);
    expect(connection.sent).toHaveLength(1);
    expect(result.signature).toBe(connection.sent[0]?.signature);
  });

  it('awaits onSigned before sendRawTransaction on every attempt', async () => {
    const connection = new FakeConnection();
    connection.queueConfirm('expired', 'confirmed');
    const onSigned = vi.fn(async (signature: string, lastValidBlockHeight: number) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      connection.log.push(`onSigned:${signature}:${lastValidBlockHeight}`);
    });
    await sendAndConfirm({
      connection,
      tx: transferTx(),
      signers: [payer],
      onSigned,
      commitment: 'confirmed',
    });
    const [first, second] = connection.sent;
    const [bh1, bh2] = connection.blockhashes;
    expect(connection.log.filter((e) => !e.startsWith('getLatestBlockhash'))).toEqual([
      `onSigned:${first?.signature}:${bh1?.lastValidBlockHeight}`,
      `sendRawTransaction:${first?.signature}`,
      `confirmTransaction:${first?.signature}`,
      'getBlockHeight',
      'getSignatureStatuses',
      'getMinimumLedgerSlot',
      `onSigned:${second?.signature}:${bh2?.lastValidBlockHeight}`,
      `sendRawTransaction:${second?.signature}`,
      `confirmTransaction:${second?.signature}`,
    ]);
  });

  describe('after a blockhash expiry (CHN-01)', () => {
    const fast = { expiryChecks: 3, expiryCheckMs: 0 };

    async function unresolved(connection: FakeConnection, buildTx = vi.fn(transferTx)) {
      const err = await sendAndConfirm({
        connection,
        buildTx,
        signers: [payer],
        commitment: 'confirmed',
        ...fast,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({
        code: 'chain_send_failed',
        details: {
          signature: connection.sent[0]?.signature,
          lastValidBlockHeight: connection.blockhashes[0]?.lastValidBlockHeight,
        },
      });
      expect(buildTx).toHaveBeenCalledTimes(1);
      expect(connection.count('sendRawTransaction')).toBe(1);
      return err;
    }

    it('never re-signs while the status is only processed', async () => {
      const connection = new FakeConnection();
      connection.queueConfirm('expired-processed');
      await unresolved(connection);
      expect(connection.count('getSignatureStatuses')).toBe(fast.expiryChecks);
    });

    it('never re-signs while the expiry is not finalized, polling a bounded number of times', async () => {
      const connection = new FakeConnection();
      connection.finalizedHeight = 0;
      connection.queueConfirm('expired');
      await unresolved(connection);
      expect(connection.count('getBlockHeight')).toBe(fast.expiryChecks);
      expect(connection.count('getSignatureStatuses')).toBe(0);
    });

    it('never re-signs when the node history does not cover the validity window', async () => {
      const connection = new FakeConnection();
      connection.minimumLedgerSlot = Number.MAX_SAFE_INTEGER;
      connection.queueConfirm('expired');
      await unresolved(connection);
    });

    it('never re-signs on a status that is confirmed but not finalized', async () => {
      const connection = new FakeConnection();
      connection.statusCommitment = 'confirmed';
      connection.queueConfirm('expired-landed');
      await unresolved(connection);
    });

    it('returns the expired signature once it is finalized as landed', async () => {
      const connection = new FakeConnection();
      connection.queueConfirm('expired-landed');
      const result = await sendAndConfirm({
        connection,
        tx: transferTx(),
        signers: [payer],
        commitment: 'confirmed',
        ...fast,
      });
      expect(result).toEqual({
        signature: connection.sent[0]?.signature,
        landed: true,
        attempts: 1,
      });
    });

    it('does not resend a fixed tx that expired after failing on-chain', async () => {
      const connection = new FakeConnection();
      connection.queueConfirm('expired-failed');
      const err = await sendAndConfirm({
        connection,
        tx: transferTx(),
        signers: [payer],
        commitment: 'confirmed',
        ...fast,
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: 'chain_send_failed',
        details: { signature: connection.sent[0]?.signature, landed: true },
      });
      expect(connection.count('sendRawTransaction')).toBe(1);
    });
  });

  describe('after an on-chain error (CHN-04)', () => {
    it('does not resend an identical fixed tx', async () => {
      const connection = new FakeConnection();
      connection.queueConfirm('failed', 'confirmed');
      const err = await sendAndConfirm({
        connection,
        tx: transferTx(),
        signers: [payer],
        commitment: 'confirmed',
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: 'chain_send_failed',
        details: { signature: connection.sent[0]?.signature, landed: true },
      });
      expect(connection.count('sendRawTransaction')).toBe(1);
    });

    it('rebuilds through buildTx and retries', async () => {
      const connection = new FakeConnection();
      connection.queueConfirm('failed', 'confirmed');
      const buildTx = vi.fn(transferTx);
      const result = await sendAndConfirm({
        connection,
        buildTx,
        signers: [payer],
        commitment: 'confirmed',
      });
      expect(result.attempts).toBe(2);
      expect(buildTx).toHaveBeenCalledTimes(2);
    });
  });

  it('sends nothing when onSigned throws', async () => {
    const connection = new FakeConnection();
    const err = await sendAndConfirm({
      connection,
      tx: transferTx(),
      signers: [payer],
      onSigned: () => Promise.reject(new Error('mongo down')),
      commitment: 'confirmed',
    }).catch((e: unknown) => e);
    expect(err).toEqual(new Error('mongo down'));
    expect(connection.count('sendRawTransaction')).toBe(0);
  });

  it('co-signs with extra signers', async () => {
    const connection = new FakeConnection();
    const tx = transferTx();
    tx.instructions[0]?.keys.push({ pubkey: nft.publicKey, isSigner: true, isWritable: false });
    await sendAndConfirm({
      connection,
      tx,
      signers: [payer],
      extraSigners: [nft],
      commitment: 'confirmed',
    });
    const signed = Transaction.from(connection.sent[0]?.raw ?? new Uint8Array());
    expect(signed.verifySignatures()).toBe(true);
    expect(signed.signatures.map((s) => s.publicKey.toBase58())).toContain(
      nft.publicKey.toBase58(),
    );
  });

  it('simulates first when asked and fails without sending on a simulation error', async () => {
    const connection = new FakeConnection();
    connection.simulationError = { InstructionError: [0, 'Custom'] };
    const err = await sendAndConfirm({
      connection,
      tx: transferTx(),
      signers: [payer],
      simulate: true,
      commitment: 'confirmed',
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'chain_send_failed' });
    expect(connection.count('simulateTransaction')).toBe(1);
    expect(connection.count('sendRawTransaction')).toBe(0);
  });
});
