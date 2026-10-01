import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    react(),
    // The Solana and Meteora SDKs expect Node's Buffer and process globals.
    nodePolyfills({ include: ['buffer', 'process'], globals: { Buffer: true, process: true } }),
  ],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
});
