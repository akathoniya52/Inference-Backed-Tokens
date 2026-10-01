// React Query keys (spec L502). Factories keep keys typed and in one place so
// invalidation after a transaction can target them precisely.
export const queryKeys = {
  models: () => ['models'] as const,
  model: (slug: string) => ['model', slug] as const,
  token: (slug: string) => ['token', slug] as const,
  settlements: (slug: string) => ['settlements', slug] as const,
  me: () => ['me'] as const,
  keys: () => ['keys'] as const,
  ledger: () => ['ledger'] as const,
  usage: () => ['usage'] as const,
};
