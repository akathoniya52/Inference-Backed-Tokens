import { AppError, isAppError } from '@ibt/shared';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';

import { getRequestId } from '../context.js';

interface HttpParserError {
  type: string;
  status: number;
}

function isParserError(err: unknown): err is HttpParserError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    typeof err.type === 'string' &&
    'status' in err &&
    typeof err.status === 'number'
  );
}

// Request input is validated with `parseInput`, which throws a 400 AppError.
// A bare ZodError here comes from a response DTO or internal parse: a 500.
function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  if (isParserError(err) && err.status >= 400 && err.status < 500) {
    const message =
      err.type === 'entity.too.large' ? 'request body exceeds 1 MB' : 'request body is invalid';
    return new AppError('invalid_request', { message, cause: err });
  }
  return new AppError('internal', { cause: err });
}

export function notFound(): RequestHandler {
  return (_req, _res, next) => {
    next(new AppError('not_found', { message: 'route not found' }));
  };
}

/** Envelope `{error:{code,message,requestId}}` (L260); never a stack or internal message. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    const appError = toAppError(err);
    const requestId = getRequestId(req);
    if (appError.httpStatus >= 500) {
      logger.error({ err, requestId, route: req.path }, 'request failed');
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(appError.httpStatus).json(appError.toEnvelope(requestId));
  };
}
