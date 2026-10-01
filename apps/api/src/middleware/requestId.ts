import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

import { setRequestId } from '../context.js';

const HEADER = 'X-Request-Id';
const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Echoes a well-formed `X-Request-Id` (L407) or generates one; set on every response. */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const supplied = req.get(HEADER);
    const id = supplied !== undefined && VALID_ID.test(supplied) ? supplied : randomUUID();
    setRequestId(req, id);
    res.setHeader(HEADER, id);
    next();
  };
}
