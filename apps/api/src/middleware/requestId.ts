import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

import { setClientRequestId, setRequestId } from '../context.js';

const HEADER = 'X-Request-Id';
// Charset and length bound the echo: no CR/LF or other header injection.
const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Every request gets a server-generated id for ledger and request rows (GW-07).
 * A well-formed client `X-Request-Id` (L407) is only a correlation value: it is
 * echoed back and logged, never used as a unique key, so it cannot collide with
 * another tenant's or a retried request. Without one, the server id is echoed.
 */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const id = randomUUID();
    setRequestId(req, id);
    const supplied = req.get(HEADER);
    const valid = supplied !== undefined && VALID_ID.test(supplied);
    if (valid) setClientRequestId(req, supplied);
    res.setHeader(HEADER, valid ? supplied : id);
    next();
  };
}
