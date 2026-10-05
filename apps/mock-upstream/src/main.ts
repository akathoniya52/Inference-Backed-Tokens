import { createLogger, startSelfPing } from '@ibt/shared/node';

import { MOCK_MODES, MOCK_UPSTREAM_PORT, createMockUpstream, type MockMode } from './index.js';

const port = Number(process.env.MOCK_UPSTREAM_PORT ?? MOCK_UPSTREAM_PORT);
const envMode = process.env.MOCK_UPSTREAM_MODE;
const mode: MockMode = MOCK_MODES.find((m) => m === envMode) ?? 'ok';

// Standalone dev server accepts any bearer unless MOCK_UPSTREAM_API_KEY pins one.
const upstream = await createMockUpstream({
  port,
  host: '0.0.0.0',
  mode,
  apiKey: process.env.MOCK_UPSTREAM_API_KEY ?? null,
});
process.stdout.write(`mock-upstream listening on :${upstream.port} (mode ${mode})\n`);

const selfPing = startSelfPing({
  baseUrl: process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL,
  logger: createLogger({ level: 'info', name: 'mock-upstream' }),
});

const shutdown = () => {
  selfPing.stop();
  upstream.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
