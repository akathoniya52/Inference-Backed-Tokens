// Moves SOL from the treasury to the keeper float (runbook 3, Plan.md L576).
// Dry-run by default; `--send` is operator-only (work plan P8-T3, §7 H8).
import { createRpc, type Rpc, sendAndConfirm } from '@ibt/chain';
import { type Cluster, lamportsToSol, solToLamports } from '@ibt/shared';
import { type Connection, type PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { z } from 'zod';

import {
  assertRpcCluster,
  CliError,
  EXIT_ERROR,
  EXIT_OK,
  parseCli,
  readPublicKeyEnv,
  readSecretKeypair,
  requireHuman,
  requireMainnetConfirm,
  resolveCluster,
  resolveMode,
  resolveRpcUrl,
  runMain,
} from './lib/cli.js';

const USAGE =
  'usage: refill-float.ts --sol <n> [--cluster devnet|mainnet-beta] [--dry-run | --send [--confirm-mainnet]] [--rpc-url <url>]\n' +
  '  --cluster defaults to env CLUSTER, then devnet; --rpc-url to env RPC_URL';
const DEVNET_PUBLIC_RPC = 'https://api.devnet.solana.com';

const solAmount = z
  .string()
  .regex(/^\d+(\.\d{1,9})?$/, 'a positive SOL amount with at most 9 decimals')
  .transform((sol) => solToLamports(sol));

function parseSol(name: string, value: string | undefined): bigint {
  const parsed = solAmount.safeParse(value);
  if (!parsed.success) throw new CliError(`${name} must be ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

const sol = (lamports: bigint | null) =>
  lamports === null ? 'unknown' : `${lamportsToSol(lamports)} SOL`;

interface Plan {
  cluster: Cluster;
  lamports: bigint;
  floatMin: bigint;
  treasury: PublicKey | null;
  keeper: PublicKey | null;
  treasuryBalance: bigint | null;
  keeperBalance: bigint | null;
  balanceSource: string;
}

function floatStatus(float: bigint | null, min: bigint): string {
  if (float === null) return 'unknown';
  return float < min ? `BREACHED (${sol(float)} < ${sol(min)})` : 'ok';
}

function planLines(plan: Plan): string[] {
  const keeperAfter = plan.keeperBalance === null ? null : plan.keeperBalance + plan.lamports;
  // With the keeper balance unknown, the transfer alone is a lower bound of the result.
  const keeperAfterFloor = keeperAfter ?? (plan.lamports >= plan.floatMin ? plan.lamports : null);
  const treasuryAfter = plan.treasuryBalance === null ? null : plan.treasuryBalance - plan.lamports;
  const shortfall = treasuryAfter !== null && treasuryAfter < 0n ? '  INSUFFICIENT' : '';
  return [
    `transfer:       ${lamportsToSol(plan.lamports)} SOL (${plan.lamports} lamports)`,
    `  from treasury ${plan.treasury?.toBase58() ?? '<TREASURY_WALLET unset>'}`,
    `  to keeper     ${plan.keeper?.toBase58() ?? '<KEEPER_WALLET unset>'}`,
    `balances from:  ${plan.balanceSource}`,
    `treasury:       ${sol(plan.treasuryBalance)} → ${sol(treasuryAfter)} (plus the tx fee)${shortfall}`,
    `keeper float:   ${sol(plan.keeperBalance)} → ${sol(keeperAfter)}`,
    `FLOAT_MIN_SOL:  ${sol(plan.floatMin)}`,
    `  now:          ${floatStatus(plan.keeperBalance, plan.floatMin)}`,
    `  after refill: ${floatStatus(keeperAfterFloor, plan.floatMin)}`,
  ];
}

async function balanceOf(rpc: Rpc<Connection>, key: PublicKey | null): Promise<bigint | null> {
  return key ? BigInt(await rpc.read.getBalance(key)) : null;
}

async function connect(rpcUrl: string, cluster: Cluster): Promise<Rpc<Connection>> {
  const rpc = createRpc({ rpcUrl });
  await assertRpcCluster(rpc.primary, cluster);
  return rpc;
}

runMain(async () => {
  const flags = parseCli(
    {
      sol: { type: 'string' },
      cluster: { type: 'string' },
      'dry-run': { type: 'boolean' },
      send: { type: 'boolean' },
      'confirm-mainnet': { type: 'boolean' },
      'rpc-url': { type: 'string' },
    },
    USAGE,
  );
  if (flags.sol === undefined) throw new CliError(`--sol is required\n${USAGE}`);
  const lamports = parseSol('--sol', flags.sol);
  if (lamports === 0n) throw new CliError('--sol must be greater than 0');
  const floatMin = parseSol('FLOAT_MIN_SOL', process.env.FLOAT_MIN_SOL?.trim() || '0.5');
  const cluster = resolveCluster(flags.cluster, USAGE, 'devnet');
  const mode = resolveMode(flags);

  if (mode === 'dry-run') {
    const treasury = readPublicKeyEnv('TREASURY_WALLET');
    const keeper = readPublicKeyEnv('KEEPER_WALLET');
    const rpcUrl = resolveRpcUrl(flags['rpc-url']);
    const rpc = rpcUrl ? await connect(rpcUrl, cluster) : null;
    const plan: Plan = {
      cluster,
      lamports,
      floatMin,
      treasury,
      keeper,
      treasuryBalance: rpc ? await balanceOf(rpc, treasury) : null,
      keeperBalance: rpc ? await balanceOf(rpc, keeper) : null,
      balanceSource: rpc ? `${cluster} RPC` : 'none (RPC_URL unset)',
    };
    console.log(
      [`refill-float DRY RUN on ${cluster}: nothing is signed or sent.`, ...planLines(plan)].join(
        '\n',
      ),
    );
    return EXIT_OK;
  }

  // Gate order matters: both refusals happen before any key is read.
  requireHuman();
  requireMainnetConfirm(cluster, flags['confirm-mainnet']);
  const rpcUrl =
    resolveRpcUrl(flags['rpc-url']) ?? (cluster === 'devnet' ? DEVNET_PUBLIC_RPC : null);
  if (!rpcUrl) throw new CliError('mainnet-beta needs --rpc-url or RPC_URL');
  const keeper = readPublicKeyEnv('KEEPER_WALLET');
  if (!keeper) throw new CliError('KEEPER_WALLET is not set');

  const treasury = readSecretKeypair('TREASURY_SECRET_KEY');
  const treasuryEnv = readPublicKeyEnv('TREASURY_WALLET');
  if (treasuryEnv && !treasuryEnv.equals(treasury.publicKey)) {
    throw new CliError('TREASURY_SECRET_KEY does not belong to TREASURY_WALLET');
  }
  if (treasury.publicKey.equals(keeper)) throw new CliError('treasury and keeper are the same key');

  const rpc = await connect(rpcUrl, cluster);
  const plan: Plan = {
    cluster,
    lamports,
    floatMin,
    treasury: treasury.publicKey,
    keeper,
    treasuryBalance: await balanceOf(rpc, treasury.publicKey),
    keeperBalance: await balanceOf(rpc, keeper),
    balanceSource: `${cluster} RPC`,
  };
  console.log([`refill-float SEND on ${cluster}`, ...planLines(plan)].join('\n'));
  if (plan.treasuryBalance !== null && plan.treasuryBalance <= lamports) {
    throw new CliError('treasury balance does not cover the transfer plus fee');
  }

  try {
    const { signature } = await sendAndConfirm({
      connection: rpc.primary,
      tx: new Transaction().add(
        SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: keeper, lamports }),
      ),
      signers: [treasury],
      commitment: rpc.commitment,
      simulate: true,
      // A retry after an ambiguous failure could transfer twice.
      maxAttempts: 1,
      onSigned: (sig) => console.log(`signed ${sig}; sending...`),
    });
    const after = await balanceOf(rpc, keeper);
    console.log(`transferred: ${signature}\nkeeper float now: ${sol(after)}`);
    console.log('confirm GET /api/admin/float is above FLOAT_MIN_SOL (runbook 3).');
    return EXIT_OK;
  } catch (err) {
    const cause =
      err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
    console.error(`send failed${cause}`);
    console.error('check the signed signature above (if any) before re-running.');
    return EXIT_ERROR;
  }
});
