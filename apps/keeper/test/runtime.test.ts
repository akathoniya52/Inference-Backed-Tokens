import { type FakeChainMongo, saveFakeSolUsd } from '@ibt/chain/testing';
import { describe, expect, it } from 'vitest';

import { DEFAULT_FAKE_SOL_USD, SeededFakePriceSource } from '../src/runtime.js';

function memoryMongo(): FakeChainMongo {
  const rows = new Map<string, Map<string, unknown>>();
  return {
    collection(name) {
      const table = rows.get(name) ?? new Map<string, unknown>();
      rows.set(name, table);
      return {
        insertOne: () => Promise.resolve(),
        findOne: (filter) => Promise.resolve(table.get(String(filter.mint)) ?? null),
        find: () => ({ toArray: () => Promise.resolve([...table.values()]) }),
        replaceOne: (filter, doc) => {
          table.set(String(filter.mint), doc);
          return Promise.resolve();
        },
      };
    },
  };
}

describe('SeededFakePriceSource', () => {
  it('falls back to the default price when none was seeded', async () => {
    await expect(new SeededFakePriceSource(memoryMongo()).solUsd()).resolves.toBe(
      DEFAULT_FAKE_SOL_USD,
    );
  });

  it('reads the price seed-models stored, including later re-seeds', async () => {
    const mongo = memoryMongo();
    const price = new SeededFakePriceSource(mongo);
    await saveFakeSolUsd(mongo, 42.5);
    await expect(price.solUsd()).resolves.toBe(42.5);
    await saveFakeSolUsd(mongo, 200);
    await expect(price.solUsd()).resolves.toBe(200);
  });
});
