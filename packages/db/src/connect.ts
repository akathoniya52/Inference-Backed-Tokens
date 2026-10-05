import mongoose from 'mongoose';

export interface ConnectOptions {
  /** Server selection timeout; keep short in tests so failures surface fast. */
  serverSelectionTimeoutMS?: number;
}

/** Opens the single mongoose connection shared by every consumer of `@ibt/db`. */
// Filters on paths outside the schema are dropped rather than sent to Mongo.
// `sanitizeFilter` stays off: it would wrap every literal `$in`/`$gt`/`$inc`-style
// filter in `$eq` (and throw on `$expr`) unless each one were `mongoose.trusted()`.
// Request input reaches filters only as zod-validated strings and numbers instead.
mongoose.set('strictQuery', true);

export async function connectDb(uri: string, opts: ConnectOptions = {}): Promise<typeof mongoose> {
  return mongoose.connect(uri, {
    serverSelectionTimeoutMS: opts.serverSelectionTimeoutMS ?? 10_000,
    // int64 money fields decode as bigint in lean reads and aggregations too.
    useBigInt64: true,
  });
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
