import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PublicKey, type Connection, type Keypair, type Transaction } from '@solana/web3.js';

import { env } from '../env';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The token's metadata URI: the one `/launch/prepare` returned, which is what
 * confirm checks on chain (API-06), else one built from `VITE_API_URL`. A
 * returned URI must be this mint's `/metadata/<mint>.json` over https (http
 * only on localhost); anything else is refused before the wallet signs.
 */
export function metadataUri(mint: PublicKey, fromApi?: string): string {
  const path = `/metadata/${mint.toBase58()}.json`;
  if (fromApi === undefined) return `${env.VITE_API_URL.replace(/\/+$/, '')}${path}`;
  let url: URL | null = null;
  try {
    url = new URL(fromApi);
  } catch {
    // Refused below.
  }
  const secure =
    url?.protocol === 'https:' || (url?.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  if (!url || !secure || !url.pathname.endsWith(path) || url.search !== '' || url.hash !== '') {
    throw new Error('the api returned an unexpected token metadata URI');
  }
  return fromApi;
}

export interface LaunchTxInput {
  connection: Connection;
  creator: PublicKey;
  mint: Keypair;
  name: string;
  symbol: string;
  blockhash: string;
  /** `metadataUri` from `/launch/prepare`. */
  apiMetadataUri?: string;
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
  apiMetadataUri,
}: LaunchTxInput): Promise<Transaction> {
  const uri = metadataUri(mint.publicKey, apiMetadataUri);
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const tx = await client.creator.createPool({
    name,
    symbol,
    uri,
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
