import { PACKAGE_NAME as SHARED_NAME, SHARED_SOURCE_URL } from '@ibt/shared';
import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from '../src/index.js';
import { TESTING_ENTRY } from '../src/testing.js';

describe('@ibt/chain', () => {
  it('exposes its package name and testing entry', () => {
    expect(PACKAGE_NAME).toBe('@ibt/chain');
    expect(TESTING_ENTRY).toBe('@ibt/chain/testing');
  });

  // G10: workspace packages must resolve to TypeScript source under vitest,
  // so tests never depend on a prior `pnpm build`.
  it('resolves @ibt/shared through the development condition (source, not dist)', () => {
    expect(SHARED_NAME).toBe('@ibt/shared');
    expect(SHARED_SOURCE_URL).toMatch(/\/packages\/shared\/src\/index\.ts$/);
  });
});
