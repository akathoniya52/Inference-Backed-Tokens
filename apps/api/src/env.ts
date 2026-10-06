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

/**
 * `TRUST_PROXY` as Express expects it: hop count, boolean, or an address/subnet
 * list. Unset means `1` outside production; production must set it (API-01).
 */
const TrustProxySchema = z
  .string()
  .optional()
  .transform((value): number | boolean | string | undefined => {
    if (value === undefined) return undefined;
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

  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().min(0).max(65_535).default(4000),
  /**
   * Public origin of this api as the web app's `VITE_API_URL`; a launched token's
   * on-chain metadata URI must be `<API_PUBLIC_URL>/metadata/<mint>.json` (API-06).
   * Required on mainnet.
   */
  API_PUBLIC_URL: z
    .url({ protocol: /^https?$/ })
    .transform((url) => url.replace(/\/+$/, ''))
    .optional(),
  // cors matches Origin exactly, so drop any trailing slash or path.
  WEB_ORIGIN: z.url().transform((url) => new URL(url).origin),
  TRUST_PROXY: TrustProxySchema,
  ADMIN_IP_ALLOWLIST: csv,
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).optional(),
  DAILY_CAP_USDC: UsdcInputSchema.optional(),
  /** Keeper SOL float alert threshold for `GET /api/admin/float` (L530). */
  FLOAT_MIN_SOL: z
    .string()
    .regex(/^\d+(\.\d{1,9})?$/, 'must be SOL with up to 9 decimals')
    .default('0.5'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  JUPITER_PRICE_URL: z.url().optional(),
  JUPITER_API_KEY: optionalString,
  MOCK_UPSTREAM_PORT: z.coerce.number().int().min(0).max(65_535).optional(),
  /** Lets provider upstreams resolve to loopback/private addresses (mock-upstream); dev and tests only. */
  ALLOW_PRIVATE_UPSTREAMS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,

  /** Self-ping target; Render sets `RENDER_EXTERNAL_URL` on every web service. */
  SELF_PING_URL: z.url().optional(),
  RENDER_EXTERNAL_URL: z.url().optional(),

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
    const mainnet = env.CLUSTER === 'mainnet-beta';
    if (mainnet || env.NODE_ENV === 'production') {
      // A default hop count lets anyone who reaches the port directly choose `req.ip`.
      if (env.TRUST_PROXY === undefined || env.TRUST_PROXY === true) {
        ctx.addIssue({
          code: 'custom',
          path: ['TRUST_PROXY'],
          message: 'must be set to a hop count, a proxy subnet list or false in production',
        });
      }
    }
    if (mainnet && env.ADMIN_IP_ALLOWLIST.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_IP_ALLOWLIST'],
        message: 'must list the admin addresses on mainnet',
      });
    }
    if (mainnet && env.API_PUBLIC_URL === undefined) {
      ctx.addIssue({ code: 'custom', path: ['API_PUBLIC_URL'], message: 'required on mainnet' });
    }
    if (env.ALLOW_PRIVATE_UPSTREAMS && env.CLUSTER === 'mainnet-beta') {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOW_PRIVATE_UPSTREAMS'],
        message: 'private upstreams are refused on mainnet',
      });
    }
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
  .transform(
    ({ KEEPER_SECRET_KEY: _keeper, TREASURY_SECRET_KEY: _treasury, TRUST_PROXY, ...env }) => ({
      ...env,
      TRUST_PROXY: TRUST_PROXY ?? 1,
    }),
  );

export type ApiEnv = z.output<typeof envSchema>;

/**
 * GW-08 startup warning: in production without `trust proxy`, every client
 * behind a load balancer shares its IP, and so its per-IP limits.
 */
export function clientsShareProxyIp(env: Pick<ApiEnv, 'NODE_ENV' | 'TRUST_PROXY'>): boolean {
  return env.NODE_ENV === 'production' && env.TRUST_PROXY === false;
}

/** Parses the api env; errors name the offending keys but never echo values. */
export function loadEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  return parseEnv(envSchema, source);
}
