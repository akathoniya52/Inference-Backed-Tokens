import mongoose from 'mongoose';

export { default as mongoose, Types } from 'mongoose';
export type { ClientSession, HydratedDocument } from 'mongoose';
export { connectDb, disconnectDb } from './connect.js';
export type { ConnectOptions } from './connect.js';
export { withTransaction } from './transaction.js';
export * from './models/index.js';

export const connection = mongoose.connection;
export const startSession: typeof mongoose.startSession = (...args) =>
  mongoose.startSession(...args);
export * from './ledger.js';
