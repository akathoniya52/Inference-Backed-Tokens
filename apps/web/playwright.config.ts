import { defineConfig, devices } from '@playwright/test';

import { E2E_ENV, PREVIEW_PORT, PREVIEW_URL } from './e2e/env';

// The e2e bundle goes to its own outDir so a test-env build never replaces `dist`.
const OUT_DIR = 'dist/e2e';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: PREVIEW_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `vite build --outDir ${OUT_DIR} && vite preview --outDir ${OUT_DIR} --host 127.0.0.1 --port ${PREVIEW_PORT} --strictPort`,
    url: PREVIEW_URL,
    env: E2E_ENV,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
