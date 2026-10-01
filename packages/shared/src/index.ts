export const PACKAGE_NAME = '@ibt/shared';

/**
 * URL of the module that was actually loaded. Used by the G10 smoke test in
 * `@ibt/chain` to prove that vitest resolved the `development` export
 * condition (TypeScript source) rather than `dist`.
 */
export const SHARED_SOURCE_URL = import.meta.url;

export * from './constants.js';
export * from './money.js';
export * from './pricing.js';
export * from './split.js';
export * from './signin.js';
export * from './schemas/index.js';
