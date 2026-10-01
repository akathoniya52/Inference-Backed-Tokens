import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PublicKey, type Connection, type Keypair, type Transaction } from '@solana/web3.js';

import { env } from '../env';

export function metadataUri(mint: PublicKey): string {
  return `${env.VITE_API_URL.replace(/\/+$/, '')}/metadata/${mint.toBase58()}.json`;
}

export interface LaunchTxInput {
  connection: Connection;
  creator: PublicKey;
  mint: Keypair;
  name: string;
  symbol: string;
  blockhash: string;
}

/**
 * DBC `createPool` on our config with the provider as payer and pool creator
 * (L122). The mint keypair co-signs here; the wallet signs afterwards.
 */
export async function buildLaunchTransaction({
  connection,
  creator,
  mint,
  name,
  symbol,
  blockhash,
}: LaunchTxInput): Promise<Transaction> {
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const tx = await client.creator.createPool({
    name,
    symbol,
    uri: metadataUri(mint.publicKey),
    payer: creator,
    poolCreator: creator,
    config: new PublicKey(env.VITE_DBC_CONFIG),
    baseMint: mint.publicKey,
  });
  tx.feePayer = creator;
  tx.recentBlockhash = blockhash;
  tx.partialSign(mint);
  return tx;
}
