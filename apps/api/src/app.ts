import express, { type Express } from 'express';

/** Builds the HTTP app without binding a port, so tests can mount it anywhere. */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}
