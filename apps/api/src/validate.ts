import { AppError } from '@ibt/shared';
import { z } from 'zod';

/** Field paths only: issue messages can echo input values. */
export function describeZodError(error: z.ZodError): string {
  const paths = [...new Set(error.issues.map((issue) => issue.path.map(String).join('.')))];
  const named = paths.filter((path) => path.length > 0);
  return named.length > 0 ? `invalid fields: ${named.join(', ')}` : 'request is invalid';
}

/** Parses request input; failures become 400 `invalid_request`. */
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('invalid_request', { message: describeZodError(result.error) });
  }
  return result.data;
}
