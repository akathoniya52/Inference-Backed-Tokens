import type { ZodType } from 'zod';

import { AppError } from '../errors.js';

export function parseEnv<T>(
  schema: ZodType<T>,
  source: Record<string, string | undefined> = process.env,
): T {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  // Keys only: issue messages and inputs may echo secret values.
  const keys = new Set(
    result.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'),
  );
  throw new AppError('internal', {
    message: `invalid environment variables: ${[...keys].join(', ')}`,
  });
}
