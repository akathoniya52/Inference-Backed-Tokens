// Build-time `VITE_*` values for the e2e bundle, mirroring `vitest.config.ts`.
// `api.test` never resolves, so every API call must be stubbed with `page.route`.
export const E2E_ENV = {
  VITE_API_URL: 'http://api.test',
  VITE_RPC_URL: 'http://127.0.0.1:8899',
  VITE_CLUSTER: 'devnet',
  VITE_DBC_CONFIG: 'TestDbcConfig11111111111111111111111111111',
  VITE_USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  VITE_TREASURY_USDC_ATA: 'TestTreasuryAta1111111111111111111111111111',
} as const;

export const PREVIEW_PORT = 4173;
export const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}`;
