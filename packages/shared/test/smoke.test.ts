import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from '../src/index.js';

describe('@ibt/shared', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@ibt/shared');
  });
});
