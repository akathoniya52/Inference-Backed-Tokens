// Seeds the load-test database: one active `mock-llm` model pointing at the load mock and N
// consumers, each with dev credit and one API key, written with the shapes the api itself uses
// (`apps/api/src/modules/keys/service.ts`, `scripts/seed-models.ts`).
import { adjust, ApiKeys, Models, syncAllIndexes, Users } from '@ibt/db';
import { DEFAULT_MOCK_API_KEY } from '@ibt/mock-upstream';
import {
  encrypt,
  generateApiKey,
  generateDepositRef,
  keyPrefix,
  sha256Hex,
} from '@ibt/shared/node';
import { Keypair } from '@solana/web3.js';

export const LOAD_MODEL_SLUG = 'mock-llm';
export const LOAD_UPSTREAM_MODEL = 'mock-model';
const DEV_CREDIT_REASON = 'dev_credit';

export interface SeedOptions {
  users: number;
  creditMicro: bigint;
  dailyCapMicro: bigint;
  masterKey: string;
  mockPort: number;
}

export interface SeededKey {
  userId: string;
  key: string;
}

async function createUser(wallet: string, role: 'consumer' | 'provider') {
  const [user] = await Users.create([{ wallet, depositRef: generateDepositRef(), role }]);
  if (!user) throw new Error('user insert returned no document');
  return user._id;
}

export async function seedLoadData(opts: SeedOptions): Promise<SeededKey[]> {
  await syncAllIndexes();

  const providerId = await createUser(Keypair.generate().publicKey.toBase58(), 'provider');
  await Models.create({
    providerId,
    slug: LOAD_MODEL_SLUG,
    name: 'Mock LLM (load test)',
    description: 'Load-test model backed by the local mock upstream.',
    status: 'active',
    upstream: {
      baseUrl: `http://localhost:${opts.mockPort}/v1`,
      modelName: LOAD_UPSTREAM_MODEL,
      apiKeyEnc: encrypt(DEFAULT_MOCK_API_KEY, opts.masterKey),
      supportsStreamUsage: false,
    },
    pricing: { inputPerMTokMicroUsdc: 1_000_000n, outputPerMTokMicroUsdc: 2_000_000n },
  });

  const keys: SeededKey[] = [];
  for (let i = 0; i < opts.users; i += 1) {
    const userId = await createUser(Keypair.generate().publicKey.toBase58(), 'consumer');
    await adjust(userId, opts.creditMicro, DEV_CREDIT_REASON);
    const key = generateApiKey();
    await ApiKeys.create({
      userId,
      keyHash: sha256Hex(key),
      prefix: keyPrefix(key),
      name: `load-${i}`,
      dailyCapMicroUsdc: opts.dailyCapMicro,
    });
    keys.push({ userId: userId.toHexString(), key });
  }
  return keys;
}
