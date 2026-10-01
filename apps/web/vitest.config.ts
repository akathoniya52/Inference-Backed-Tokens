import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['development'] },
  test: {
    include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    env: {
      VITE_API_URL: 'http://api.test',
      VITE_RPC_URL: 'http://127.0.0.1:8899',
      VITE_CLUSTER: 'devnet',
      VITE_DBC_CONFIG: 'TestDbcConfig11111111111111111111111111111',
      VITE_USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      VITE_TREASURY_USDC_ATA: 'TestTreasuryAta1111111111111111111111111111',
    },
  },
});
