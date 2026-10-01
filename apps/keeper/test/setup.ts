import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

/** Must match the `mongo:7` image in docker-compose.yml. */
export const MONGO_TEST_VERSION = '7.0.14';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  process.env.MONGOMS_VERSION ??= MONGO_TEST_VERSION;
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    binary: { version: MONGO_TEST_VERSION },
  });
  const uri = replSet.getUri('ibt_test');
  process.env.MONGODB_URI = uri;
  project.provide('mongoUri', uri);
  return async () => {
    await replSet.stop();
  };
}
