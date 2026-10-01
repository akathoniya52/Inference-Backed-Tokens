import { inject } from 'vitest';

/**
 * Per-test-file database on the shared replica set. Test files run in parallel workers and
 * several of them wipe collections in `beforeEach`, so sharing one database name races.
 */
export function testDbUri(prefix: string): string {
  const url = new URL(inject('mongoUri'));
  url.pathname = `/${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return url.toString();
}
