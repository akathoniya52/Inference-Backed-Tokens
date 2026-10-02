// Query keys for provider-side reads. The spec L502 keys sit beside their queries:
// `publicQueryKeys` in lib/queries.ts and `accountKeys` in hooks/useAccount.ts.
export const queryKeys = {
  providerModels: (wallet: string | null) => ['providerModels', wallet] as const,
  feeClaimer: (dbcPool: string) => ['feeClaimer', dbcPool] as const,
};
