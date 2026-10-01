// Shared CLI plumbing for the operator scripts: argument parsing, the human and
// mainnet gates (P8-T1), secret-key loading and RPC cluster checks.
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { CLUSTERS, type Cluster } from '@ibt/shared';
import { type Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_SEND_FAILED = 2;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_REFUSED,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function runMain(main: () => Promise<number>): void {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      if (err instanceof CliError) {
        console.error(`error: ${err.message}`);
        process.exitCode = err.exitCode;
        return;
      }
      console.error('error:', err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_REFUSED;
    },
  );
}

type Options = NonNullable<ParseArgsConfig['options']>;
type CliConfig<O extends Options> = { options: O; strict: true; allowPositionals: false };
export type CliValues<O extends Options> = ReturnType<typeof parseArgs<CliConfig<O>>>['values'];

export function parseCli<O extends Options>(options: O, usage: string): CliValues<O> {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    throw new CliError(`${err instanceof Error ? err.message : String(err)}\n${usage}`);
  }
}

export const clusterSchema = z.enum(CLUSTERS);

export function parseCluster(value: string | undefined, usage: string): Cluster {
  const parsed = clusterSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError(`--cluster must be one of ${CLUSTERS.join(', ')}\n${usage}`);
  }
  return parsed.data;
}

export function resolveMode(flags: { send?: boolean; 'dry-run'?: boolean }): 'send' | 'dry-run' {
  if (flags.send && flags['dry-run']) throw new CliError('--send and --dry-run are exclusive');
  return flags.send ? 'send' : 'dry-run';
}

/** Gate 1 for every `--send`: only an operator shell sets `I_AM_HUMAN=1` (§7). */
export function requireHuman(): void {
  if (process.env.I_AM_HUMAN !== '1') {
    throw new CliError(
      'refusing --send: I_AM_HUMAN=1 is not set. Sending is operator-only (work plan §7); ' +
        'no key was read.',
    );
  }
}

export function requireMainnetConfirm(cluster: Cluster, confirmed: boolean | undefined): void {
  if (cluster === 'mainnet-beta' && !confirmed) {
    throw new CliError(
      'refusing --send on mainnet-beta without --confirm-mainnet; no key was read.',
    );
  }
}

const byteArraySchema = z.array(z.number().int().min(0).max(255)).length(64);

/**
 * Loads a 64-byte secret key (base58 or a JSON byte array) from env. Error
 * messages name the variable only; the value and parser errors (which can echo
 * input) are never printed.
 */
export function readSecretKeypair(name: string): Keypair {
  const raw = process.env[name]?.trim();
  if (!raw) throw new CliError(`${name} is not set`);
  let bytes: Uint8Array;
  try {
    bytes = raw.startsWith('[')
      ? Uint8Array.from(byteArraySchema.parse(JSON.parse(raw)))
      : bs58.decode(raw);
  } catch (_err) {
    throw new CliError(`${name} is neither base58 nor a JSON array of 64 bytes`);
  }
  if (bytes.length !== 64) throw new CliError(`${name} must decode to 64 bytes`);
  try {
    return Keypair.fromSecretKey(bytes);
  } catch (_err) {
    throw new CliError(`${name} is not a valid ed25519 secret key`);
  }
}

export function readPublicKeyEnv(name: string): PublicKey | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch (_err) {
    throw new CliError(`${name} is not a valid base58 public key`);
  }
}

const GENESIS_HASH: Readonly<Record<Cluster, string>> = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

export function resolveRpcUrl(flag: string | undefined): string | null {
  const url = flag ?? process.env.RPC_URL?.trim();
  if (!url) return null;
  if (!z.url().safeParse(url).success) throw new CliError('RPC URL is not a valid URL');
  return url;
}

/** Stops a `--cluster devnet` run from talking to a mainnet RPC (and vice versa). */
export async function assertRpcCluster(connection: Connection, cluster: Cluster): Promise<void> {
  const genesis = await connection.getGenesisHash();
  if (genesis !== GENESIS_HASH[cluster]) {
    throw new CliError(`RPC genesis hash ${genesis} does not belong to ${cluster}`);
  }
}
