import { AppError } from '@ibt/shared';
import {
  Keypair,
  type ParsedTransactionWithMeta,
  PublicKey,
  type SignatureStatus,
  SystemProgram,
  type TokenBalance,
  Transaction,
} from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RealChainClient } from '../src/client.js';
import { type DammPool, deriveDammPool } from '../src/damm.js';
import { parseLiquidityFill, parseSwapFill } from '../src/fill.js';
import { decodeMetadata, metadataAddress } from '../src/metadata.js';
import { JupiterPriceSource } from '../src/price.js';
import { CpAmm, type DammPoolState, NATIVE_MINT, toBN, USDC_MINT, WSOL_MINT } from '../src/sdk.js';
import { createFakeChain } from '../src/testing.js';

const keeper = Keypair.generate();
const mint = Keypair.generate().publicKey;
const vaultA = Keypair.generate().publicKey;
const vaultB = Keypair.generate().publicKey;

afterEach(() => {
  vi.restoreAllMocks();
});

function balance(index: number, tokenMint: PublicKey, owner: PublicKey, amount: bigint) {
  return {
    accountIndex: index,
    mint: tokenMint.toBase58(),
    owner: owner.toBase58(),
    uiTokenAmount: { amount: amount.toString(), decimals: 0, uiAmount: null },
  } satisfies TokenBalance;
}

function balancesTx(
  keys: PublicKey[],
  pre: TokenBalance[],
  post: TokenBalance[],
  err: ParsedTransactionWithMeta['meta'] extends infer M
    ? M extends { err: infer E }
      ? E
      : null
    : null = null,
): ParsedTransactionWithMeta {
  return {
    slot: 1,
    blockTime: null,
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: true })),
        instructions: [],
        recentBlockhash: 'x',
      },
    },
    meta: {
      err,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: pre,
      postTokenBalances: post,
    },
  };
}

const poolAuthority = Keypair.generate().publicKey;
const keeperAta = Keypair.generate().publicKey;

describe('parseSwapFill (CHN-03)', () => {
  const keys = [keeper.publicKey, vaultA, vaultB, keeperAta];
  const accounts = {
    owner: keeper.publicKey,
    inputVault: vaultB,
    outputVault: vaultA,
    outputMint: mint,
  };

  it('reads the SOL the vault took and the tokens the owner got, not the quote', () => {
    const tx = balancesTx(
      keys,
      [balance(1, mint, poolAuthority, 1_000_000n), balance(2, WSOL_MINT, poolAuthority, 50n)],
      [
        balance(1, mint, poolAuthority, 600_000n),
        balance(2, WSOL_MINT, poolAuthority, 350n),
        balance(3, mint, keeper.publicKey, 399_000n),
      ],
    );
    expect(parseSwapFill(tx, accounts)).toEqual({ amountIn: 300n, amountOut: 399_000n });
  });

  it('reads a SOL output from the output vault', () => {
    const tx = balancesTx(
      keys,
      [balance(1, mint, poolAuthority, 10n), balance(2, WSOL_MINT, poolAuthority, 900n)],
      [balance(1, mint, poolAuthority, 30n), balance(2, WSOL_MINT, poolAuthority, 700n)],
    );
    expect(
      parseSwapFill(tx, {
        owner: keeper.publicKey,
        inputVault: vaultA,
        outputVault: vaultB,
        outputMint: NATIVE_MINT,
      }),
    ).toEqual({ amountIn: 20n, amountOut: 200n });
  });

  it('is null for a failed tx or one that moved nothing', () => {
    expect(parseSwapFill(null, accounts)).toBeNull();
    expect(
      parseSwapFill(balancesTx(keys, [], [], { InstructionError: [0, 'Custom'] }), accounts),
    ).toBeNull();
    expect(parseSwapFill(balancesTx(keys, [], []), accounts)).toBeNull();
  });

  it('parseLiquidityFill reads both vault deltas', () => {
    const tx = balancesTx(
      keys,
      [balance(1, mint, poolAuthority, 5n)],
      [balance(1, mint, poolAuthority, 105n), balance(2, WSOL_MINT, poolAuthority, 7n)],
    );
    expect(parseLiquidityFill(tx, { tokenAVault: vaultA, tokenBVault: vaultB })).toEqual({
      amountA: 100n,
      amountB: 7n,
    });
  });
});

describe('decodeMetadata (API-06)', () => {
  function encoded(name: string, symbol: string, uri: string, tail: number[]) {
    const str = (text: string, padTo: number) => {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(padTo);
      const bytes = Buffer.alloc(padTo);
      Buffer.from(text).copy(bytes);
      return Buffer.concat([len, bytes]);
    };
    const authority = Keypair.generate().publicKey;
    const data = Buffer.concat([
      Buffer.from([4]),
      authority.toBuffer(),
      mint.toBuffer(),
      str(name, 32),
      str(symbol, 10),
      str(uri, 200),
      Buffer.from(tail),
    ]);
    return { data, authority };
  }

  it('trims NUL padding and reads is_mutable after the creators', () => {
    const creator = [...Keypair.generate().publicKey.toBytes(), 1, 100];
    const { data, authority } = encoded('Model', 'MDL', 'https://x.test/m.json', [
      0,
      0,
      1,
      1,
      0,
      0,
      0,
      ...creator,
      0,
      0,
    ]);
    expect(decodeMetadata(data, mint)).toEqual({
      address: metadataAddress(mint).toBase58(),
      updateAuthority: authority.toBase58(),
      name: 'Model',
      symbol: 'MDL',
      uri: 'https://x.test/m.json',
      isMutable: false,
    });
  });

  it('rejects another mint, a wrong key byte and truncated data', () => {
    const { data } = encoded('A', 'B', 'C', [0, 0, 0, 0, 1]);
    expect(decodeMetadata(data, mint)?.isMutable).toBe(true);
    expect(decodeMetadata(data, Keypair.generate().publicKey)).toBeNull();
    expect(decodeMetadata(Buffer.concat([Buffer.from([5]), data.subarray(1)]), mint)).toBeNull();
    expect(decodeMetadata(data.subarray(0, 100), mint)).toBeNull();
  });
});

function statusClient(status: Pick<SignatureStatus, 'err' | 'confirmationStatus'> | null) {
  const client = new RealChainClient({ rpcUrl: 'http://127.0.0.1:1', usdcMint: USDC_MINT.devnet });
  vi.spyOn(client.rpc.primary, 'getSignatureStatuses').mockResolvedValue({
    context: { slot: 1 },
    value: [status && { slot: 1, confirmations: null, ...status }],
  });
  return client;
}

describe('signatureStatus (CHN-07)', () => {
  it('reports processed as pending, and only confirmed/finalized as landed or failed', async () => {
    const err = { InstructionError: [0, 'Custom'] } as const;
    expect(await statusClient(null).signatureStatus('s')).toBe('unknown');
    expect(
      await statusClient({ err: null, confirmationStatus: 'processed' }).signatureStatus('s'),
    ).toBe('pending');
    expect(await statusClient({ err, confirmationStatus: 'processed' }).signatureStatus('s')).toBe(
      'pending',
    );
    expect(await statusClient({ err: null }).signatureStatus('s')).toBe('pending');
    expect(
      await statusClient({ err: null, confirmationStatus: 'confirmed' }).signatureStatus('s'),
    ).toBe('landed');
    expect(
      await statusClient({ err: null, confirmationStatus: 'finalized' }).signatureStatus('s'),
    ).toBe('landed');
    expect(await statusClient({ err, confirmationStatus: 'confirmed' }).signatureStatus('s')).toBe(
      'failed',
    );
  });
});

describe('JupiterPriceSource (CHN-06)', () => {
  const SOL = WSOL_MINT.toBase58();
  const url = 'https://price.example.invalid/price/v3';
  const respond = (body: unknown) =>
    vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body))));

  it('passes a timeout signal to fetch', async () => {
    const fetchFn = respond({ [SOL]: { usdPrice: 150, blockId: 1000 } });
    await new JupiterPriceSource({ url, fetch: fetchFn }).solUsd();
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a hung request after timeoutMs', async () => {
    const hung = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(
      new JupiterPriceSource({ url, fetch: hung, timeoutMs: 10 }).solUsd(),
    ).rejects.toThrow();
  });

  it('rejects stale or blockId-less quotes when a current slot is given', async () => {
    const currentSlot = () => Promise.resolve(10_000);
    const fresh = respond({ [SOL]: { usdPrice: 150, blockId: 9_500 } });
    await expect(new JupiterPriceSource({ url, fetch: fresh, currentSlot }).solUsd()).resolves.toBe(
      150,
    );
    const stale = respond({ [SOL]: { usdPrice: 150, blockId: 9_000 } });
    await expect(
      new JupiterPriceSource({ url, fetch: stale, currentSlot }).solUsd(),
    ).rejects.toThrow(/stale/);
    const none = respond({ [SOL]: { usdPrice: 150 } });
    await expect(
      new JupiterPriceSource({ url, fetch: none, currentSlot }).solUsd(),
    ).rejects.toThrow(/stale/);
  });
});

describe('fake chain fills', () => {
  it('curveBuy reports lamportsSpent and swapFill reads it back', async () => {
    const chain = createFakeChain();
    const config = Keypair.generate().publicKey;
    const pool = chain.addPool({ mint, config, creator: keeper.publicKey });
    chain.migrateWhen(1_000n);
    chain.setSol(keeper.publicKey, 10_000n);
    const buy = await chain.curveBuy(keeper, pool, 5_000n);
    expect(buy.lamportsSpent).toBe(1_000n);
    await expect(
      chain.swapFill(buy.signature, { venue: 'curve', owner: keeper.publicKey, pool }),
    ).resolves.toEqual({ amountIn: 1_000n, amountOut: buy.outAmount });
    await expect(
      chain.swapFill('other', { venue: 'curve', owner: keeper.publicKey, pool }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('RealChainClient.addAndLock (CHN-04)', () => {
  const state = {
    tokenAMint: mint,
    tokenBMint: NATIVE_MINT,
    tokenAVault: vaultA,
    tokenBVault: vaultB,
    tokenAFlag: 0,
    tokenBFlag: 0,
    tokenAAmount: toBN(0n),
    tokenBAmount: toBN(0n),
    liquidity: toBN(1n),
    sqrtPrice: toBN(1n),
    sqrtMinPrice: toBN(1n),
    sqrtMaxPrice: toBN(2n),
    collectFeeMode: 1,
    activationType: 1,
  } as unknown as DammPoolState;
  const pool: DammPool = { address: deriveDammPool(mint), state };
  const tx = () =>
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: vaultB, lamports: 1 }),
    );

  it('buffers the thresholds within the caps, re-quotes after an on-chain error, and reports actual amounts', async () => {
    const client = new RealChainClient({
      rpcUrl: 'http://127.0.0.1:1',
      usdcMint: USDC_MINT.devnet,
    });
    const conn = client.rpc.primary;
    vi.spyOn(CpAmm.prototype, 'isPoolExist').mockResolvedValue(true);
    const fetchState = vi.spyOn(CpAmm.prototype, 'fetchPoolState').mockResolvedValue(pool.state);
    vi.spyOn(CpAmm.prototype, 'getDepositQuote').mockImplementation(({ inAmount, isTokenA }) => ({
      actualInputAmount: inAmount,
      consumedInputAmount: inAmount,
      outputAmount: isTokenA ? inAmount.divn(2) : inAmount.muln(2),
      liquidityDelta: toBN(7n),
    }));
    const add = vi
      .spyOn(CpAmm.prototype, 'addLiquidity')
      .mockImplementation(() => Promise.resolve(tx()));
    vi.spyOn(CpAmm.prototype, 'permanentLockPosition').mockImplementation(() =>
      Promise.resolve(tx()),
    );
    vi.spyOn(conn, 'getLatestBlockhash').mockImplementation(() =>
      Promise.resolve({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 10,
      }),
    );
    vi.spyOn(conn, 'sendRawTransaction').mockResolvedValue('sent');
    vi.spyOn(conn, 'confirmTransaction')
      .mockResolvedValueOnce({
        context: { slot: 1 },
        value: { err: { InstructionError: [0, 'Custom'] } },
      })
      .mockResolvedValue({ context: { slot: 1 }, value: { err: null } });
    vi.spyOn(conn, 'getParsedTransaction').mockResolvedValue(
      balancesTx(
        [keeper.publicKey, vaultA, vaultB],
        [],
        [balance(1, mint, poolAuthority, 1_900n), balance(2, WSOL_MINT, poolAuthority, 980n)],
      ),
    );

    const position = {
      position: Keypair.generate().publicKey,
      positionNftAccount: Keypair.generate().publicKey,
    };
    const result = await client.addAndLock(keeper, mint, {
      position,
      lamports: 1_000n,
      maxTokens: 10_000n,
    });

    expect(add).toHaveBeenCalledTimes(2);
    expect(fetchState.mock.calls.length).toBeGreaterThanOrEqual(3);
    const params = add.mock.calls[1]?.[0];
    const lamportsMax = BigInt(params?.tokenBAmountThreshold.toString() ?? '0');
    const tokensMax = BigInt(params?.tokenAAmountThreshold.toString() ?? '0');
    expect(lamportsMax).toBeGreaterThan(980n);
    expect(lamportsMax).toBeLessThanOrEqual(1_000n);
    expect(params?.maxAmountTokenB.toString()).toBe(lamportsMax.toString());
    expect(tokensMax).toBeGreaterThan(1_960n);
    expect(tokensMax).toBeLessThanOrEqual(10_000n);
    expect(result).toMatchObject({ lamportsUsed: 980n, tokensUsed: 1_900n, liquidityDelta: 7n });
  });
});
