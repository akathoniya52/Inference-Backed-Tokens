import type { ChainClient } from '@ibt/chain';
import { connection, mongoose } from '@ibt/db';
import { BODY_LIMIT_BYTES } from '@ibt/shared';
import { createLogger, type Alerter } from '@ibt/shared/node';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';

import { getAuthUser, getRequestId, type Clock } from './context.js';
import type { ApiEnv } from './env.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestId.js';
import { adminRouter } from './modules/admin/router.js';
import { authRouter } from './modules/auth/router.js';
import { billingRouter, meRouter } from './modules/billing/router.js';
import { gatewayRouter } from './modules/gateway/router.js';
import { keysRouter } from './modules/keys/router.js';
import { metadataRouter } from './modules/metadata/router.js';
import { modelsRouter } from './modules/models/router.js';
import { tokensRouter } from './modules/tokens/router.js';

export interface AppTimeouts {
  /** Upstream first byte (L238); the gateway (P4) reads it. */
  firstByteMs?: number;
  totalMs?: number;
}

export interface AppDeps {
  env: ApiEnv;
  chain: ChainClient;
  alerter: Alerter;
  clock?: Clock;
  timeouts?: AppTimeouts;
  logger?: Logger;
  /** Mounted after the built-in routes and before the 404 handler (tests). */
  extraRoutes?: (app: Express, ctx: AppContext) => void;
}

/** Fully resolved dependencies handed to every module router. */
export interface AppContext {
  env: ApiEnv;
  chain: ChainClient;
  alerter: Alerter;
  clock: Clock;
  timeouts: AppTimeouts;
  logger: Logger;
}

async function mongoReady(): Promise<boolean> {
  try {
    const db = connection.db;
    if (connection.readyState !== mongoose.ConnectionStates.connected || db === undefined)
      return false;
    await db.admin().ping();
    return true;
  } catch {
    return false;
  }
}

async function chainReady(chain: ChainClient): Promise<boolean> {
  try {
    return await chain.ping();
  } catch {
    return false;
  }
}

/** Builds the HTTP app without binding a port, so tests can mount it anywhere. */
export function createApp(deps: AppDeps): Express {
  const { env, chain } = deps;
  const logger = deps.logger ?? createLogger({ level: env.LOG_LEVEL, name: 'api' });
  const ctx: AppContext = {
    env,
    chain,
    alerter: deps.alerter,
    clock: deps.clock ?? (() => new Date()),
    timeouts: deps.timeouts ?? {},
    logger,
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => getRequestId(req) ?? 'unknown',
      customProps: (req) => ({
        requestId: getRequestId(req),
        userId: getAuthUser(req)?.userId,
        route: req.url,
      }),
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: [env.WEB_ORIGIN] }));
  app.use(express.json({ limit: BODY_LIMIT_BYTES }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/readyz', async (_req, res) => {
    const [mongo, chainOk] = await Promise.all([mongoReady(), chainReady(ctx.chain)]);
    const ok = mongo && chainOk;
    res.status(ok ? 200 : 503).json({ ok, mongo, chain: chainOk });
  });

  app.use('/api/admin', adminRouter(ctx));
  app.use('/api/auth', authRouter(ctx));
  app.use('/api/me', meRouter(ctx));
  app.use('/api/billing', billingRouter(ctx));
  app.use('/api/keys', keysRouter(ctx));
  app.use('/api/models', modelsRouter(ctx));
  app.use('/api/tokens', tokensRouter(ctx));
  app.use('/v1', gatewayRouter(ctx));
  app.use('/metadata', metadataRouter(ctx));

  deps.extraRoutes?.(app, ctx);

  app.use(notFound());
  app.use(errorHandler(logger));
  return app;
}
