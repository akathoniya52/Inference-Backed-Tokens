import { Types } from '@ibt/db';
import { AppError } from '@ibt/shared';

// Opaque cursor (L457): base64url of the last item's ObjectId. Lists are
// ordered by `_id` descending (newest first).

export function encodeCursor(id: Types.ObjectId): string {
  return Buffer.from(id.toHexString(), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Types.ObjectId {
  const hex = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[a-f0-9]{24}$/.test(hex)) {
    throw new AppError('invalid_request', { message: 'invalid cursor' });
  }
  return new Types.ObjectId(hex);
}

/** `_id` filter for the page after `cursor`. */
export function cursorFilter(cursor: string | undefined): { _id?: { $lt: Types.ObjectId } } {
  return cursor === undefined ? {} : { _id: { $lt: decodeCursor(cursor) } };
}

/** Splits a `limit + 1` fetch into the page and the cursor for the next one. */
export function toPage<T extends { _id: Types.ObjectId }>(
  rows: T[],
  limit: number,
): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: last ? encodeCursor(last._id) : null };
}
