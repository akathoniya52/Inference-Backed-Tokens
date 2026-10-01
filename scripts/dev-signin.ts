// Signs in to a local api with an ephemeral in-memory keypair (work plan P8-T2, §9), the same
// nonce → sign → verify flow a wallet runs. The secret key never leaves this process.
import { NonceResponseSchema, VerifyResponseSchema } from '@ibt/shared';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { z } from 'zod';

import { CliError, EXIT_OK, parseCli, runMain } from './lib/cli.js';

const USAGE =
  'usage: dev-signin.ts [--export]\n' +
  '  env: API_URL (default http://localhost:4000)\n' +
  '  --export prints `export WALLET=... JWT=...` for eval instead of JSON';
const DEFAULT_API_URL = 'http://localhost:4000';

async function postJson<S extends z.ZodType>(
  apiUrl: string,
  path: string,
  body: unknown,
  schema: S,
): Promise<z.output<S>> {
  const url = new URL(path, apiUrl);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
    throw new CliError(`cannot reach the api at ${url.origin}${cause ? ` (${cause})` : ''}`);
  }
  const text = await res.text();
  if (!res.ok) throw new CliError(`POST ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new CliError(`POST ${path} returned an unexpected body`);
  return parsed.data;
}

runMain(async () => {
  const flags = parseCli({ export: { type: 'boolean' } }, USAGE);
  const apiUrl = process.env.API_URL?.trim() || DEFAULT_API_URL;
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();

  const { nonce, message } = await postJson(
    apiUrl,
    '/api/auth/nonce',
    { wallet },
    NonceResponseSchema,
  );
  // The api rebuilds the G22 message from the stored nonce and verifies these exact bytes.
  const signature = nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey);
  const { token } = await postJson(
    apiUrl,
    '/api/auth/verify',
    { wallet, nonce, signature: bs58.encode(signature) },
    VerifyResponseSchema,
  );

  console.log(
    flags.export
      ? `export WALLET=${wallet} JWT=${token}`
      : JSON.stringify({ wallet, jwt: token }, null, 2),
  );
  return EXIT_OK;
});
