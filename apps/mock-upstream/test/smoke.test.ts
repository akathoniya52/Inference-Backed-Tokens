import { describe, expect, it } from 'vitest';

import { MOCK_UPSTREAM_PORT } from '../src/index.js';

describe('@ibt/mock-upstream', () => {
  it('uses port 4010 by default', () => {
    expect(MOCK_UPSTREAM_PORT).toBe(4010);
  });
});
