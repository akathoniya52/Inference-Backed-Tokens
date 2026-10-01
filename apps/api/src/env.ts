import { ClusterSchema, PublicKeySchema, UsdcInputSchema } from '@ibt/shared';
import { parseEnv } from '@ibt/shared/node';
import { z } from 'zod';

const LOCAL_MONGO_HOSTS = new Set(['localhost', '127.0.0.1']);
const MASTER_KEY_FORMAT = /^(?:[0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=?)$/;

function mongoHost(uri: string): string | null {
  try {
    return new URL(uri).hostname;
  } catch {
    // Multi-host seed lists are not valid URLs; they are never local.
    return null;
  }
}

/** `TRUST_PROXY` as Express expects it: hop count, boolean, or an address/subnet list. */
const TrustProxySchema = z
  .string()
  .default('1')
  .transform((value): number | boolean | string => {
    if (/^\d+$/.test(value)) return Number(value);
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  });

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

const optionalString = z.string().min(1).optional();

const fields = z.object({
  CLUSTER: ClusterSchema,
  RPC_URL: z.url(),
  RPC_URL_FALLBACK: z.url().optional(),
  CHAIN_MODE: z.enum(['real', 'fake']).default('real'),
  USDC_MINT: PublicKeySchema,
  DBC_CONFIG: PublicKeySchema,
  TREASURY_WALLET: PublicKeySchema,
  KEEPER_WALLET: PublicKeySchema,

  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// URI'),

  JWT_SECRET: z.string().min(32),
  MASTER_KEY: z.string().regex(MASTER_KEY_FORMAT, 'must be 32 bytes as hex or base64'),
  ADMIN_TOKEN: z.string().min(32),

  PORT: z.coerce.number().int().min(0).max(65_535).default(4000),
  WEB_ORIGIN: z.url(),
  TRUST_PROXY: TrustProxySchema,
  ADMIN_IP_ALLOWLIST: csv,
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).optional(),
  DAILY_CAP_USDC: UsdcInputSchema.optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  JUPITER_PRICE_URL: z.url().optional(),
  JUPITER_API_KEY: optionalString,
  MOCK_UPSTREAM_PORT: z.coerce.number().int().min(0).max(65_535).optional(),

  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,

  // L190: signing keys belong to the keeper and the operator, never to the api process.
  KEEPER_SECRET_KEY: z.undefined({ error: 'must not be set for the api' }).optional(),
  TREASURY_SECRET_KEY: z.undefined({ error: 'must not be set for the api' }).optional(),
});

export const envSchema = z
  .preprocess(
    // `.env` files write unset optionals as `KEY=`; treat them as absent.
    (source) =>
      typeof source === 'object' && source !== null
        ? Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''))
        : source,
    fields,
  )
  .superRefine((env, ctx) => {
    if (env.CHAIN_MODE !== 'fake') return;
    if (env.CLUSTER === 'mainnet-beta') {
      ctx.addIssue({ code: 'custom', path: ['CHAIN_MODE'], message: 'fake is refused on mainnet' });
    }
    const host = mongoHost(env.MONGODB_URI);
    if (host === null || !LOCAL_MONGO_HOSTS.has(host)) {
      ctx.addIssue({
        code: 'custom',
        path: ['CHAIN_MODE'],
        message: 'fake requires a localhost MONGODB_URI (G24)',
      });
    }
  })
  .transform(({ KEEPER_SECRET_KEY: _keeper, TREASURY_SECRET_KEY: _treasury, ...env }) => env);

export type ApiEnv = z.output<typeof envSchema>;

/** Parses the api env; errors name the offending keys but never echo values. */
export function loadEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  return parseEnv(envSchema, source);
}
