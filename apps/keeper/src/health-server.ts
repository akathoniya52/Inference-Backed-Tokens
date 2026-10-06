import { createServer, type Server } from 'node:http';

import type { Logger } from 'pino';

/**
 * Listens on `port`; a listen error (e.g. `EADDRINUSE`) is logged and handed to `onError`
 * instead of crashing the process on an unhandled `'error'` event (KPR-15).
 */
export function startHealthServer(
  port: number,
  { logger, onError }: { logger: Logger; onError: (err: Error) => void },
): Server {
  const server = createHealthServer();
  server.on('error', (err) => {
    logger.fatal({ err, port }, 'keeper health server failed');
    onError(err);
  });
  return server.listen(port, () => {
    logger.info({ port }, 'keeper health server listening');
  });
}

/** Minimal liveness endpoint for the keeper process (no Express needed). */
export function createHealthServer(): Server {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}
