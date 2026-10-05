import { CLUSTERS } from '@ibt/shared';
import { parseEnv } from '@ibt/shared/node';
import { z } from 'zod';

const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

export const KeeperEnvSchema = z.object({
  CLUSTER: z.enum(CLUSTERS),
  RPC_URL: z.url(),
  RPC_URL_FALLBACK: optional,
  CHAIN_MODE: z.enum(['real', 'fake']).default('real'),
  USDC_MINT: z.string().min(32),
  DBC_CONFIG: z.string().min(1),
  DAMM_V2_FEE_CONFIG: z.string().min(1),
  TREASURY_WALLET: z.string().min(1),
  TREASURY_SECRET_KEY: optional,
  KEEPER_SECRET_KEY: optional,
  MONGODB_URI: z.string().min(1),
  SETTLEMENT_CRON: z.string().default('5 * * * *'),
  RECONCILE_CRON: z.string().default('0 3 * * *'),
  MAX_SLICE_SOL_PER_RUN: decimal.default('2'),
  MAX_PAYOUT_USDC_PER_RUN: decimal.default('500'),
  FLOAT_MIN_SOL: decimal.default('0.5'),
  API_INTERNAL_URL: z.url().default('http://localhost:4000'),
  ADMIN_TOKEN: optional,
  KEEPER_PORT: z.coerce.number().int().min(0).max(65535).default(4001),
  /** Self-ping target; Render sets `RENDER_EXTERNAL_URL` on every web service. */
  SELF_PING_URL: optional.pipe(z.url().optional()),
  RENDER_EXTERNAL_URL: optional.pipe(z.url().optional()),
  JUPITER_PRICE_URL: z.url(),
  JUPITER_API_KEY: optional,
  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_CHAT_ID: optional,
  DEVNET_E2E: z.enum(['0', '1']).default('0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type KeeperEnv = z.infer<typeof KeeperEnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): KeeperEnv {
  return parseEnv(KeeperEnvSchema, source);
}
