import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['development'] },
  ssr: { resolve: { conditions: ['development'] } },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/setup.ts'],
    hookTimeout: 120_000,
  },
});
