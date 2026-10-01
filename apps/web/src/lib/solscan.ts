import type { Cluster } from '@ibt/shared';

import { env } from '../env';

const SOLSCAN = 'https://solscan.io';

function clusterQuery(cluster: Cluster): string {
  return cluster === 'devnet' ? '?cluster=devnet' : '';
}

export function txUrl(signature: string, cluster: Cluster = env.VITE_CLUSTER): string {
  return `${SOLSCAN}/tx/${signature}${clusterQuery(cluster)}`;
}

export function addressUrl(address: string, cluster: Cluster = env.VITE_CLUSTER): string {
  return `${SOLSCAN}/account/${address}${clusterQuery(cluster)}`;
}
