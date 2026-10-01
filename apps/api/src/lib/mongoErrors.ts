/** MongoDB duplicate-key error (E11000) from a unique index. */
export function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}
