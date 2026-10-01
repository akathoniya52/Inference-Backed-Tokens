import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  buildCreateConfigTx,
  buildPartnerConfigParams,
  MIGRATION_QUOTE_THRESHOLD_SOL,
  partnerCurveInput,
} from '../src/config.js';
import { DBC_PROGRAM_ID, NATIVE_MINT, type Cluster } from '../src/sdk.js';

interface BNLike {
  toTwos: unknown;
  toString(base: number): string;
}
const isBN = (v: object): v is BNLike => 'toTwos' in v && typeof v.toTwos === 'function';

function bnAndKeysToStrings(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof PublicKey) return value.toBase58();
  if (isBN(value)) return value.toString(10);
  if (Array.isArray(value)) return value.map(bnAndKeysToStrings);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bnAndKeysToStrings(v)]));
}

const CLUSTERS: Cluster[] = ['devnet', 'mainnet-beta'];

describe('buildPartnerConfigParams', () => {
  it.each(CLUSTERS)('matches the committed snapshot for %s', (cluster) => {
    expect({
      input: partnerCurveInput(cluster),
      params: bnAndKeysToStrings(buildPartnerConfigParams(cluster)),
    }).toMatchSnapshot();
  });

  it('graduates at 1 SOL on devnet and 10 SOL on mainnet', () => {
    expect(MIGRATION_QUOTE_THRESHOLD_SOL).toEqual({ devnet: 1, 'mainnet-beta': 10 });
    expect(buildPartnerConfigParams('devnet').migrationQuoteThreshold.toString()).toBe(
      '1000000000',
    );
    expect(buildPartnerConfigParams('mainnet-beta').migrationQuoteThreshold.toString()).toBe(
      '10000000000',
    );
  });

  it.each(CLUSTERS)('encodes the spec fee and LP split for %s', (cluster) => {
    const params = buildPartnerConfigParams(cluster);
    expect(params.creatorTradingFeePercentage).toBe(50);
    expect(params.migrationFeeOption).toBe(2);
    expect(params.poolCreationFee.toString()).toBe('0');
    expect(params.partnerPermanentLockedLiquidityPercentage).toBe(50);
    expect(params.creatorPermanentLockedLiquidityPercentage).toBe(50);
    expect(params.partnerLiquidityPercentage).toBe(0);
    expect(params.creatorLiquidityPercentage).toBe(0);
    expect(params.migrationFee).toEqual({ feePercentage: 0, creatorFeePercentage: 0 });
    expect(params.tokenType).toBe(0);
    expect(params.tokenDecimal).toBe(6);
    expect(params.tokenUpdateAuthority).toBe(1);
    expect(params.activationType).toBe(1);
    expect(params.collectFeeMode).toBe(0);
    expect(params.migrationOption).toBe(1);
  });

  it('is deterministic', () => {
    expect(bnAndKeysToStrings(buildPartnerConfigParams('devnet'))).toEqual(
      bnAndKeysToStrings(buildPartnerConfigParams('devnet')),
    );
  });
});

describe('buildCreateConfigTx', () => {
  it('builds one createConfig instruction owned by the treasury, offline', async () => {
    const connection = new Connection('http://127.0.0.1:1');
    const configPubkey = Keypair.generate().publicKey;
    const treasury = Keypair.generate().publicKey;

    const tx = await buildCreateConfigTx({ connection, configPubkey, treasury, cluster: 'devnet' });

    expect(tx.instructions).toHaveLength(1);
    const [ix] = tx.instructions;
    expect(ix?.programId.toBase58()).toBe(DBC_PROGRAM_ID.toBase58());
    const keys = ix?.keys.map((k) => k.pubkey.toBase58()) ?? [];
    expect(keys).toContain(configPubkey.toBase58());
    expect(keys).toContain(treasury.toBase58());
    expect(keys).toContain(NATIVE_MINT.toBase58());
    const signers = ix?.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58());
    expect(signers?.sort()).toEqual([configPubkey.toBase58(), treasury.toBase58()].sort());
  });
});
