import { CLUSTERS } from '@ibt/shared';
import { z } from 'zod';

const EnvSchema = z.object({
  VITE_API_URL: z.url(),
  VITE_RPC_URL: z.url(),
  VITE_CLUSTER: z.enum(CLUSTERS),
  VITE_DBC_CONFIG: z.string().min(1),
  VITE_USDC_MINT: z.string().min(1),
  VITE_TREASURY_USDC_ATA: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;

const ENV_KEYS = Object.keys(EnvSchema.shape) as (keyof Env)[];

/** Validates the `VITE_*` variables; the error lists every missing or invalid key. */
export function parseEnv(source: Readonly<Record<string, unknown>>): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;

  const missing = ENV_KEYS.filter((key) => source[key] === undefined || source[key] === '');
  const invalid = result.error.issues
    .map((issue) => String(issue.path[0]))
    .filter(
      (key, index, keys) => !missing.includes(key as keyof Env) && keys.indexOf(key) === index,
    );
  const lines = [
    missing.length > 0 ? `missing: ${missing.join(', ')}` : null,
    invalid.length > 0 ? `invalid: ${invalid.join(', ')}` : null,
  ].filter((line): line is string => line !== null);
  throw new Error(
    `Invalid web environment (${lines.join('; ')}). Copy apps/web/.env.example to apps/web/.env and fill it in.`,
  );
}

export const env: Env = parseEnv(import.meta.env);
