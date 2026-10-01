import mongoose from 'mongoose';

export interface ConnectOptions {
  /** Server selection timeout; keep short in tests so failures surface fast. */
  serverSelectionTimeoutMS?: number;
}

/** Opens the single mongoose connection shared by every consumer of `@ibt/db`. */
export async function connectDb(uri: string, opts: ConnectOptions = {}): Promise<typeof mongoose> {
  return mongoose.connect(uri, {
    serverSelectionTimeoutMS: opts.serverSelectionTimeoutMS ?? 10_000,
  });
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
