// Creates the platform's DBC partner config (Plan.md L94–118, runbook 1 L574).
// Dry-run by default; `--send` is operator-only (work plan P8-T1, §7 H0/H4/H8).
import {
  ActivationType,
  buildCreateConfigTx,
  buildPartnerConfigParams,
  CollectFeeMode,
  type ConfigParameters,
  createRpc,
  DBC_PROGRAM_ID,
  MigrationFeeOption,
  MigrationOption,
  NATIVE_MINT,
  sendAndConfirm,
} from '@ibt/chain';
import { type Cluster, lamportsToSol } from '@ibt/shared';
import { Connection, Keypair, PublicKey, type Transaction } from '@solana/web3.js';
import bs58 from 'bs58';

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
  'usage: create-config.ts [--cluster devnet|mainnet-beta] [--dry-run | --send [--confirm-mainnet]] [--rpc-url <url>]\n' +
  '  --cluster defaults to env CLUSTER, --rpc-url to env RPC_URL';
const DEVNET_PUBLIC_RPC = 'https://api.devnet.solana.com';
/** 32 zero bytes: lets the dry-run serialize the unsigned tx without an RPC. */
const PLACEHOLDER_BLOCKHASH = PublicKey.default.toBase58();
/** Account names of `createConfig` in the DBC 1.5.13 IDL, in instruction order. */
const CREATE_CONFIG_ACCOUNTS = [
  'config',
  'feeClaimer',
  'leftoverReceiver',
  'quoteMint',
  'payer',
  'systemProgram',
  'eventAuthority',
  'program',
];

interface BNLike {
  toTwos: unknown;
  toString(base: number): string;
}
const isBN = (v: object): v is BNLike => 'toTwos' in v && typeof v.toTwos === 'function';

/** BN → decimal string (BN's own `toJSON` is hex), PublicKey → base58. */
function printable(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof PublicKey) return value.toBase58();
  if (isBN(value)) return value.toString(10);
  if (Array.isArray(value)) return value.map(printable);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, printable(v)]));
}

function keyParameters(params: ConfigParameters): string[] {
  const threshold = BigInt(params.migrationQuoteThreshold.toString(10));
  return [
    `migrationQuoteThreshold: ${threshold} lamports (${lamportsToSol(threshold)} SOL)`,
    `creatorTradingFeePercentage: ${params.creatorTradingFeePercentage}`,
    `partnerPermanentLockedLiquidityPercentage: ${params.partnerPermanentLockedLiquidityPercentage}`,
    `creatorPermanentLockedLiquidityPercentage: ${params.creatorPermanentLockedLiquidityPercentage}`,
    `migrationOption: ${params.migrationOption} (${MigrationOption[params.migrationOption]})`,
    `migrationFeeOption: ${params.migrationFeeOption} (${MigrationFeeOption[params.migrationFeeOption]})`,
    `collectFeeMode: ${params.collectFeeMode} (${CollectFeeMode[params.collectFeeMode]})`,
    `activationType: ${params.activationType} (${ActivationType[params.activationType]})`,
    `poolCreationFee: ${params.poolCreationFee.toString(10)}`,
  ];
}

function accountLines(tx: Transaction, labels: Map<string, string>): string[] {
  const [ix, ...rest] = tx.instructions;
  if (!ix || rest.length > 0) throw new Error('expected exactly one createConfig instruction');
  return ix.keys.map((meta, i) => {
    const name = (CREATE_CONFIG_ACCOUNTS[i] ?? `account${i}`).padEnd(17);
    const key = meta.pubkey.toBase58();
    const flags = [meta.isSigner && 'signer', meta.isWritable && 'writable'].filter(Boolean);
    return `  ${name} ${labels.get(key) ?? key}${flags.length ? `  (${flags.join(', ')})` : ''}`;
  });
}

function envLines(configKey: string): string[] {
  return [
    `  DBC_CONFIG=${configKey}        # apps/api, apps/keeper`,
    `  VITE_DBC_CONFIG=${configKey}   # apps/web`,
  ];
}

/** Read-only RPC use: checks the genesis hash and fetches a blockhash. Never prints the URL. */
async function dryRunBlockhash(
  cluster: Cluster,
  rpcFlag: string | undefined,
): Promise<{ connection: Connection; blockhash: string; source: string }> {
  const rpcUrl = resolveRpcUrl(rpcFlag);
  if (!rpcUrl) {
    return {
      // buildCreateConfigTx makes no RPC call; this connection is never contacted.
      connection: new Connection('http://127.0.0.1:8899'),
      blockhash: PLACEHOLDER_BLOCKHASH,
      source: 'placeholder, no RPC_URL or --rpc-url',
    };
  }
  const rpc = createRpc({ rpcUrl });
  await assertRpcCluster(rpc.primary, cluster);
  const { blockhash } = await rpc.read.getLatestBlockhash();
  return {
    connection: rpc.primary,
    blockhash,
    source: `latest on ${cluster}, genesis hash checked`,
  };
}

async function dryRun(cluster: Cluster, rpcFlag: string | undefined): Promise<number> {
  const config = Keypair.generate();
  const treasuryEnv = readPublicKeyEnv('TREASURY_WALLET');
  // Stand-in so the instruction can be built; shown as a placeholder below.
  const treasury = treasuryEnv ?? Keypair.generate().publicKey;
  const labels = new Map([
    [config.publicKey.toBase58(), `${config.publicKey.toBase58()} (throwaway)`],
  ]);
  if (!treasuryEnv) labels.set(treasury.toBase58(), '<TREASURY_WALLET unset>');

  const { connection, blockhash, source } = await dryRunBlockhash(cluster, rpcFlag);
  const tx = await buildCreateConfigTx({
    connection,
    configPubkey: config.publicKey,
    treasury,
    cluster,
  });
  tx.feePayer = treasury;
  tx.recentBlockhash = blockhash;
  // Also enforces the 1232-byte packet limit ("Transaction too large").
  const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const params = buildPartnerConfigParams(cluster);

  console.log(
    [
      `create-config DRY RUN on ${cluster}: nothing is signed, sent or written.`,
      '',
      `DBC program:  ${DBC_PROGRAM_ID.toBase58()}`,
      `config:       ${config.publicKey.toBase58()} (throwaway; --send generates its own keypair)`,
      `treasury:     ${treasuryEnv ? `${treasuryEnv.toBase58()} (TREASURY_WALLET)` : '<TREASURY_WALLET unset>'}`,
      `quote mint:   ${NATIVE_MINT.toBase58()} (WSOL)`,
      '',
      'derived accounts (createConfig instruction):',
      ...accountLines(tx, labels),
      '',
      'key parameters:',
      ...keyParameters(params).map((line) => `  ${line}`),
      '',
      `buildPartnerConfigParams('${cluster}'):`,
      JSON.stringify(printable(params), null, 2),
      '',
      `unsigned tx, base64 (${unsigned.length} bytes; fee payer: treasury; blockhash ${blockhash}: ${source}):`,
      unsigned.toString('base64'),
      '',
      'after --send, set in all three apps (runbook 1):',
      ...envLines('<config key printed by --send>'),
    ].join('\n'),
  );
  return EXIT_OK;
}

async function send(cluster: Cluster, rpcFlag: string | undefined): Promise<number> {
  const rpcUrl = resolveRpcUrl(rpcFlag) ?? (cluster === 'devnet' ? DEVNET_PUBLIC_RPC : null);
  if (!rpcUrl) throw new CliError('mainnet-beta needs --rpc-url or RPC_URL');

  const treasury = readSecretKeypair('TREASURY_SECRET_KEY');
  const treasuryEnv = readPublicKeyEnv('TREASURY_WALLET');
  if (treasuryEnv && !treasuryEnv.equals(treasury.publicKey)) {
    throw new CliError('TREASURY_SECRET_KEY does not belong to TREASURY_WALLET');
  }

  const rpc = createRpc({ rpcUrl });
  await assertRpcCluster(rpc.primary, cluster);
  const config = Keypair.generate();
  const tx = await buildCreateConfigTx({
    connection: rpc.primary,
    configPubkey: config.publicKey,
    treasury: treasury.publicKey,
    cluster,
  });

  console.log(
    [
      `create-config SEND on ${cluster}`,
      `treasury (payer, fee claimer, leftover receiver): ${treasury.publicKey.toBase58()}`,
      `config: ${config.publicKey.toBase58()}`,
      '',
      'WARNING: config keypair secret, printed once and never written to disk.',
      'Store it in the secret manager now; it is not shown again:',
      `  ${bs58.encode(config.secretKey)}`,
      '',
      ...keyParameters(buildPartnerConfigParams(cluster)),
    ].join('\n'),
  );

  try {
    const { signature } = await sendAndConfirm({
      connection: rpc.primary,
      tx,
      signers: [treasury],
      extraSigners: [config],
      commitment: rpc.commitment,
      simulate: true,
      // A retry after an ambiguous failure would hit the already-created account.
      maxAttempts: 1,
      onSigned: (sig) => console.log(`signed ${sig}; sending...`),
    });
    console.log(
      [
        '',
        `config created: ${config.publicKey.toBase58()}`,
        `signature: ${signature}`,
        '',
        'set in all three apps (runbook 1):',
        ...envLines(config.publicKey.toBase58()),
      ].join('\n'),
    );
    return EXIT_OK;
  } catch (err) {
    const cause =
      err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
    console.error(`send failed${cause}`);
    console.error(`check the signed signature above (if any) before re-running.`);
    return EXIT_ERROR;
  }
}

runMain(async () => {
  const flags = parseCli(
    {
      cluster: { type: 'string' },
      'dry-run': { type: 'boolean' },
      send: { type: 'boolean' },
      'confirm-mainnet': { type: 'boolean' },
      'rpc-url': { type: 'string' },
    },
    USAGE,
  );
  const cluster = resolveCluster(flags.cluster, USAGE);
  if (resolveMode(flags) === 'dry-run') return dryRun(cluster, flags['rpc-url']);

  // Gate order matters: both refusals happen before any key is read.
  requireHuman();
  requireMainnetConfirm(cluster, flags['confirm-mainnet']);
  return send(cluster, flags['rpc-url']);
});
