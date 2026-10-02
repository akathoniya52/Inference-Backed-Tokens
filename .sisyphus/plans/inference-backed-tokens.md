# Inference-Backed Tokens: implementation work plan


---

## 1. TL;DR

- **What gets built:** a pnpm TypeScript monorepo (`apps/api`, `apps/keeper`, `apps/web`, `apps/mock-upstream`, `packages/shared`, `packages/chain`, `packages/db`, `scripts/`). It contains:
  - an OpenAI-compatible metered gateway with hold → capture billing;
  - a keeper that settles revenue hourly 70/20/10, buys the model token on the Meteora DBC curve, cranks migration to DAMM v2, and adds and permanently locks DAMM v2 liquidity;
  - a React/Vite web app where users sign every transaction with their own wallet.
- **Source spec:** `/Users/user/Desktop/43 /Inference-Backed Tokens/Plan.md` (678 lines, authoritative). In this plan, `L123` means a line in that file.
- **Done means:** from a clean clone, `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build` passes and `docker build .` succeeds.
- **Done also means:** `pnpm smoke:local` passes against the local stack. It covers sign-in, key creation, the chat completion call, hold → capture, balance decrease, and one keeper settlement on the fake chain.
- **Out of agent scope:** every step that uses real keys, real funds, or mainnet is in §7 (human-only).

## 2. Assumptions and resolved decisions

| # | Decision | Resolution | Rationale |
|---|---|---|---|
| A1 | Naming (L671) | "Inference-Backed Tokens", npm scope `@ibt/*`; providers choose token symbols | Spec default |
| A2 | Provider vesting (L672) | None; all `lockedVesting` fields are 0 | Spec default |
| A3 | Burn-to-credit (L673) | Not built; holder discount instead | Spec default |
| A4 | Split (L674) | 7000/2000/1000 bps, stored per model | Spec default |
| A5 | Launch classes (L675) | One class: 10 SOL on mainnet, 1 SOL on devnet | Spec default |
| A6 | Float refill (L676) | Manual (`scripts/refill-float.ts` plus runbook) | Spec default |
| A7 | Indexer (L677) | Polling only | Spec default |
| A8 | DLMM (L678) | Not used | Spec default |
| G1 | Missing diagrams (L56, L608) | Architecture: README ASCII diagram based on L52–66. Roadmap: 5 gates, see §6 header | Rebuilt from the spec text |
| G2 | "DBC backtester fallback" (L610) | **Out of scope**; no task | Never defined |
| G3 | Lint/format | ESLint 9 flat config + typescript-eslint 8 + eslint-plugin-react-hooks + Prettier 3 | typescript-eslint supports ESLint 9; ESLint 10 is newer than needed |
| G4 | Mock upstream | `apps/mock-upstream` (`@ibt/mock-upstream`). Exports `createMockUpstream()` for tests and runs on `:4010` for local dev | One mock shared by tests, local dev and the load test |
| G5 | Ports | api 4000, keeper 4001 (`/healthz`), web 5173, mock 4010, mongo 27017 | As briefed |
| G6 | Mongo topology | `mongo:7 --replSet rs0` with an init healthcheck; tests use `MongoMemoryReplSet` | L259 requires sessions/transactions, which require a replica set |
| G7 | Dockerfile | One multi-stage `node:20-bookworm-slim` image with pnpm via corepack. Start commands are `node apps/api/dist/main.js` and `node apps/keeper/dist/main.js` (L547) | Matches the spec |
| G8 | `@solana/web3.js` | **1.x, pinned `^1.99.0`**, deduplicated with a pnpm override | DBC SDK needs `^1.98.0`, cp-amm needs `^1.95.3`, wallet-adapter-react 0.15.40 needs peer `^1.99.0` |
| G9 | Express | **Express 5.2** | helmet, cors and pino-http don't depend on the framework; express-rate-limit 8 declares peer `express >=4.11`. Express 5 forwards rejected async handlers to the error handler. Watch out: route `GET /metadata/:file` and strip `.json` (path-to-regexp v8). `req.query` is a getter, so validation middleware stores parsed values on `res.locals` (or `req.validated`) and never reassigns `req.query`. `res.json` throws on BigInt, so every DTO converts BigInt to strings at the response boundary |
| G10 | Module system | ESM everywhere. Node packages use TS `module/moduleResolution: NodeNext`; web uses `Bundler`. Workspace `exports` use a `development` condition → `src/*.ts` and `default` → `dist/*.js`. tsx runs with `--conditions=development`, and vitest/vite set `resolve.conditions` (and `ssr.resolve.conditions`, since vitest resolves Node tests through SSR). **Typecheck note:** TS ignores the `development` condition, so every workspace `exports` entry also needs `types` → `dist/*.d.ts`, and `pnpm typecheck` runs `tsc -b` with project references in dependency order. Never add `customConditions` to the build tsconfig (TS6059 rootDir errors). If P0-T3 shows vitest does not pick up `development`, fall back to `resolve.alias` | Lets dev and tests run without building first; prod runs from `dist` |
| G11 | Mongoose models location | New package `packages/db` (`@ibt/db`), shared by the api and the keeper. `@ibt/db` owns the only `mongoose` dependency and re-exports the connection, the models and the ledger service (P3-T6); api, keeper and scripts never depend on `mongoose` directly. Tests call `syncIndexes()` on every model before the first transaction, and all multi-doc writes use `session.withTransaction` so transient errors retry | Both deployables need the same schemas; `shared` must stay browser-safe. Two mongoose copies would register models on different singletons and queries would hang on buffering; `autoIndex` races cause WriteConflicts |
| G12 | Health-check vs L190 ("keeper never calls the provider model"); `MASTER_KEY` is api-only | The health check runs **in the api**. The keeper's `healthCheck` job calls `POST /api/admin/health-checks/run` (admin token, `API_INTERNAL_URL`) every 60 s | Keeps the upstream keys in the api; resolves the conflict between L190 and L250 |
| G13 | Extra operational collections | `nonces` (TTL 5 min), `idempotency` (unique `(userId,key)`, TTL 24 h, stores the response), `leases` (L253) | Implied by L223, L148, L253; the 8 business collections stay unchanged |
| G14 | Overdraft guard | Add `users.heldMicroUsdc`. A hold is a conditional `$inc` with `$expr: balance − held ≥ estimate` | Atomic version of L236/L520; the load test checks there are zero negative balances |
| G15 | Ledger hold lifecycle | Hold rows get `status: open/captured/released/expired` and `expiresAt` (+10 min) | L237, L520 |
| G16 | Cost rounding | `cost = ceil((pt·inPrice + ct·outPrice) / 1e6)` in BigInt; discount = `floor(cost·(10000−bps)/10000)`; split floors provider and liquidity, and the **remainder goes to the platform** | L150, L587 |
| G17 | No-token phase | Provider share = `providerBps + liquidityBps` (90%) | L166 |
| G18 | Run caps | Payout above `MAX_PAYOUT_USDC_PER_RUN` goes to `token.carryOverMicroUsdc`. Slice above `MAX_SLICE_SOL_PER_RUN` goes to a new `token.sliceCarryOverMicroUsdc` | L182, L521 |
| G19 | Compounding (L179) | New field `token.pendingCompoundLamports`, added to the next run's slice; claim signature stored in `settlements.liquidity.claimTxSignature` | Gives step 6 durable state |
| G20 | Resume pointer | `settlements.lastCompletedState` plus extra signatures `liquidity.swapTxSignature` and `liquidity.migrationSignature`. On the curve phase, `locked` means "liquidity step complete" with `lockTxSignature: null`. Every chain send also writes `settlements.pendingTx {step, signature, lastValidBlockHeight}` through the `onSigned` hook (P2-T3) **before** the tx is sent; resume checks `getSignatureStatuses` on it before rebuilding | L172, L375, L599 |
| G21 | Daily spend cap (L517) | `apiKeys.dailyCapMicroUsdc` (default 50 USDC), set on `POST /api/keys`. Exceeding it returns 429 `daily_cap_exceeded` | The spec defines the cap but no error code |
| G22 | Sign-in message | Fixed template in shared: `"{domain} wants you to sign in with your Solana account:\n{wallet}\n\nNonce: {nonce}\nIssued At: {iso}"` | L518 |
| G23 | Local credits | `seed-models.ts --dev-credit` writes an `adjust` ledger row; refuses when `CLUSTER=mainnet-beta`, and also refuses unless the `MONGODB_URI` host is `localhost` or `127.0.0.1` (same guard for `--fake-token`) | The local happy path has no USDC deposit; the host guard stops free credits landing in prod Atlas when `CLUSTER=devnet` is mis-set |
| G24 | Chain mode | `CHAIN_MODE=real\|fake` for api and keeper. `fake` uses `FakeChainClient` and is refused on mainnet, and also refused unless the `MONGODB_URI` host is `localhost` or `127.0.0.1` | Needed for the DoD and local runs |
| G25 | SOL price source (L177) | `PriceSource` interface: Jupiter implementation with URL from env `JUPITER_PRICE_URL` (no hard-coded URL; P2-T1 confirms the endpoint from Jupiter docs) plus a fake | URL not verified |
| G26 | Extra env vars | `KEEPER_WALLET` (api, for `/admin/float`), `ADMIN_IP_ALLOWLIST`, `API_INTERNAL_URL`, `KEEPER_PORT`, `CHAIN_MODE`, `JUPITER_PRICE_URL`, `JUPITER_API_KEY` (Jupiter's price API may require a key), `MOCK_UPSTREAM_PORT`, `DEVNET_E2E`, `TRUST_PROXY` (api, default `1`), `RATE_LIMIT_PER_MIN` and `DAILY_CAP_USDC` (api, optional overrides of the shared constants, P8-T6) | Implied by the controls in the spec |
| G27 | Telegram (cut list) | `Alerter` interface: log transport in P1, Telegram transport in P6-T9 | L627 |
| G28 | Streaming usage | Forward `stream_options.include_usage=true` upstream only when the per-model flag `upstream.supportsStreamUsage` is true (default false; some upstreams reject `stream_options` with 400). If the final chunk has no usage, count with tiktoken (`usageEstimated: true`) | L147 |
| G29 | Playwright | Local smoke of public pages runs in CI. The full wallet flow test is tagged `@staging` and skipped unless `STAGING_URL` is set; the operator runs it | L592 |
| G30 | Deposit fixtures | Built in the parsed-tx JSON shape by a fixture builder. The operator later adds a real recorded devnet deposit (H9) | Agents must not move funds |
| G31 | Git | P0-T1 runs `git init -b main` (the implementer does this, not the planner) | CI and commits need a repo |

## 3. Prerequisites (checked on this machine, 2026-10-01)

| Tool | Check | Found | Fallback |
|---|---|---|---|
| Node 20 | `node -v` | **v20.20.2** ✅ (≥ 20.19 needed by mongodb-memory-server 11 / ESLint 10; we pin lower majors anyway) | `nvm install 20` |
| pnpm | `pnpm -v` | **12.6.0** ✅ | `corepack enable && corepack prepare pnpm@12.6.0 --activate` |
| npm | `npm -v` | 10.8.2 ✅ | — |
| corepack | `corepack --version` | 0.34.6 ✅ | — |
| Docker | `docker --version` / `docker compose version` | 29.4.3 / Compose v5.1.3 ✅ | Tests use mongodb-memory-server; local dev can use Atlas M0 (L543) |
| git | `git --version` | 2.53.0 ✅ | optional |
| Solana CLI | `solana --version` | **missing** | Not required; scripts use web3.js |

## 4. Pinned versions

Versions were confirmed with `npm view` against the npm registry on 2026-10-01. The SDK API surface was confirmed by reading the published `dist/index.d.ts` on unpkg. I used about 9 network commands rather than the 8-lookup budget, because some re-downloaded the same `.d.ts`. I didn't use context7 or librarian agents: the project folder is empty, so there was nothing for them to explore.

| Package | Pin | Note / source |
|---|---|---|
| typescript | `~5.9.3` | Latest is 7.0.2, but the spec says TS 5 (L207) |
| tsx | `^4.23` | registry |
| @meteora-ag/dynamic-bonding-curve-sdk | `1.5.13` (exact) | deps: web3.js ^1.98, anchor ^0.31, spl-token ^0.4.13; ships CJS `dist/index.cjs` |
| @meteora-ag/cp-amm-sdk | `1.5.1` (exact) | deps: web3.js ^1.95.3, anchor ^0.31 |
| @solana/web3.js | `^1.99.0` | override to a single copy via `overrides:` in `pnpm-workspace.yaml` (pnpm 10+ no longer reads `pnpm.overrides` from `package.json`) |
| @solana/spl-token | `^0.4.15` | |
| @solana/wallet-adapter-react / -react-ui / -wallets / -base | `0.15.40` / `0.9.40` / `0.19.39` / `0.9.28` | peer web3 ^1.99.0 |
| express | `^5.2.1` (+ `@types/express@5`) | G9 |
| helmet / cors / express-rate-limit | `^8.3` / `^2.8.6` / `^8.7` | |
| mongoose | `~8.24.4` | Spec says 8 (L209); latest is 9.10, not used |
| mongodb-memory-server | `^10.4.3` | 11.x needs Node ≥ 20.19. Set `MONGOMS_VERSION=7.0.14` explicitly to match `mongo:7` (exact patch confirmed in P0-T3) |
| zod | `^4.6` | registry; no peer conflicts |
| pino / pino-http | `^9.14` / `^10.5` | Conservative majors (pino 10 / pino-http 11 exist) |
| undici | `^7.30` | **8.x needs Node ≥ 22.19**, so not used; 7.x needs ≥ 20.18.1 ✅ |
| jose / tweetnacl / bs58 | `^6.2` / `^1.0.3` / `^6.0` | jose and bs58 are ESM-only; fine under G10 |
| node-cron | `^4.6` | v4 API: `cron.schedule(expr, fn)` returns a task; no `scheduled` option |
| tiktoken | `^1.0.22` | WASM |
| vitest | `^3.2.7` | depends on `vite ^5\|\|^6\|\|^7`, so it works with Vite 5 |
| supertest / @playwright/test / autocannon | `^7.3` / `^1.63` / `^8.0` | |
| react / react-dom | `18.3.1` | Spec says 18 |
| react-router-dom | `~6.30.6` | Spec says 6 |
| vite / @vitejs/plugin-react | `~5.4.21` / `^4.7` | Spec says Vite 5 (latest is 8, not used) |
| vite-plugin-node-polyfills | `^0.28` | peer includes vite ^5 ✅; include `buffer` + `process` only (`crypto`/`stream` pull in crypto-browserify and often break the build) |
| tailwindcss / postcss / autoprefixer | `~3.4.19` | v3 keeps `tailwind.config.ts` (v4 dropped it) |
| @tanstack/react-query | `^5.104` | peer react ^18 |
| lightweight-charts | `^5.2` | v5 API: `chart.addSeries(LineSeries)` |
| @testing-library/react / @testing-library/dom / jsdom | `^16.3` / `^10` / `~25.0.1` | **jsdom 30 needs Node 22**, so not used |
| eslint / typescript-eslint / prettier | `~9.39` / `^8.71` / `^3.9` | typescript-eslint peer TS < 6.1 ✅ |

**Meteora SDK surface check:** all 19 names listed in the brief exist. The spec has drift in these places, which P2-T1 must encode:

| Spec says (L96–124) | Installed SDK 1.5.13 / cp-amm 1.5.1 |
|---|---|
| `TokenType.SPL` | **`TokenType.SPLToken`** |
| `tokenUpdateAuthority: TokenUpdateAuthorityOption.Immutable` | **`tokenAuthorityOption: TokenAuthorityOption.Immutable`** |
| `migrateToDammV2({ payer, virtualPool, dammConfig })` | **`{ payer, pool, dammConfig }`**; returns `{ transaction, firstPositionNftKeypair, secondPositionNftKeypair }`, and **both keypairs must co-sign** |
| pool metrics `totalTradingQuoteFee` | `client.state.getPoolFeeMetrics(pool).total.totalTradingQuoteFee` |
| `DAMM_V2_MIGRATION_FEE_ADDRESS[2]` | Exported as `PublicKey[]`; the value at `[2]` must equal `Hv8Lmz…cjp` (assert it in a test) |
| cp-amm builders | Return `TxBuilder = Promise<Transaction>`; `derivePoolAddress(config, tokenAMint, tokenBMint)`, token ordering not verified |
| Confirmed OK | `buildCurve`, `client.partner.createConfig`, `client.pool.createPool/swapQuote2/swap2`, `client.migration.migrateToDammV2`, `client.partner.claimPartnerTradingFee`, `client.creator.claimCreatorTradingFee`, `client.state.getPool/getPoolConfig`, `deriveDbcPoolAddress(quoteMint, baseMint, config)`, `getCurrentPoint`, `SwapMode.PartialFill`, enums `BaseFeeMode.FeeSchedulerExponential`, `MigrationOption.MET_DAMM_V2`, `MigrationFeeOption.FixedBps100`, `CollectFeeMode.QuoteToken`, `ActivationType.Timestamp`, `TokenDecimal.SIX/NINE`; cp-amm `claimPositionFee`, `createPositionAndAddLiquidity`, `addLiquidity`, `permanentLockPosition`, `getDepositQuote`, `getQuote2`, `swap2`, `fetchPoolState` |

## 5. Target repository tree

```text
.
├── Plan.md                                  (read-only spec)
├── README.md  .gitignore  .editorconfig  .nvmrc  .npmrc  .prettierrc  .prettierignore
├── package.json  pnpm-workspace.yaml  pnpm-lock.yaml  tsconfig.base.json  tsconfig.json
├── eslint.config.js  docker-compose.yml  Dockerfile  .dockerignore
├── .github/workflows/ci.yml
├── apps/
│   ├── api/  package.json tsconfig.json vitest.config.ts .env.example
│   │   ├── src/main.ts app.ts env.ts logger.ts
│   │   ├── src/middleware/{requestId,errorHandler,jwtAuth,apiKeyAuth,adminAuth,rateLimits}.ts
│   │   ├── src/modules/auth/{routes,service}.ts
│   │   ├── src/modules/apiKeys/{routes,service}.ts
│   │   ├── src/modules/models/{routes,service,health}.ts
│   │   ├── src/modules/billing/{routes,deposits,usage}.ts        (ledger service lives in @ibt/db)
│   │   ├── src/modules/gateway/{routes,estimate,forward,stream,settle,idempotency,discount,tokenCount}.ts
│   │   ├── src/modules/tokens/{routes,service}.ts
│   │   ├── src/modules/metadata/routes.ts
│   │   ├── src/modules/admin/routes.ts
│   │   ├── src/modules/me/routes.ts
│   │   ├── src/ops/{health,alerts}.ts
│   │   └── test/{setup.ts,helpers.ts,*.int.test.ts}
│   ├── keeper/  package.json tsconfig.json vitest.config.ts .env.example
│   │   ├── src/main.ts env.ts lease.ts scheduler.ts health-server.ts cli/settle-once.ts
│   │   ├── src/jobs/{poolPoller,migrationCrank,healthCheck,floatMonitor,holdExpiry,stats,reconcile}.ts
│   │   ├── src/settlement/{engine,steps,period,orchestrator}.ts
│   │   └── test/{setup.ts,helpers.ts,settlement.*.test.ts,jobs.*.test.ts}
│   ├── web/  package.json tsconfig.json vite.config.ts vitest.config.ts tailwind.config.ts
│   │   │     postcss.config.js index.html playwright.config.ts .env.example
│   │   ├── src/main.tsx App.tsx env.ts index.css
│   │   ├── src/lib/{api,auth,format,queryKeys,solscan}.ts
│   │   ├── src/hooks/useSendTx.ts
│   │   ├── src/providers/{WalletProviders,QueryProvider}.tsx
│   │   ├── src/components/{WalletGate,DepositUsdc,TradePanel,CurveProgress,ModelStats,
│   │   │                   SettlementTable,LaunchWizard,ApiKeyManager,ClaimFees,ModelCard,PriceChart,Layout}.tsx
│   │   ├── src/pages/{Explore,TokenPage,Launch,Dashboard,Provider,Docs}.tsx
│   │   ├── src/**/*.test.tsx
│   │   └── e2e/smoke.spec.ts
│   └── mock-upstream/  package.json tsconfig.json src/{index,main}.ts test/mock.test.ts
├── packages/
│   ├── shared/  package.json tsconfig.json vitest.config.ts
│   │   ├── src/index.ts constants.ts money.ts pricing.ts split.ts errors.ts signin.ts ids.ts
│   │   ├── src/schemas/{chat,auth,keys,models,billing,tokens,admin,common}.ts
│   │   ├── src/node/{index,crypto,logger,alerter,telegram,env}.ts   (subpath @ibt/shared/node)
│   │   └── test/*.test.ts
│   ├── chain/  package.json tsconfig.json vitest.config.ts
│   │   ├── src/index.ts rpc.ts send.ts deposit.ts config.ts dbc.ts damm.ts spl.ts price.ts client.ts sdk.ts
│   │   ├── src/testing/{fake-chain,fixtures}.ts                      (subpath @ibt/chain/testing)
│   │   └── test/{*.test.ts,__snapshots__/config.test.ts.snap,fixtures/*.json}
│   └── db/  package.json tsconfig.json vitest.config.ts
│       ├── src/index.ts connect.ts ledger.ts models/{users,apiKeys,models,requests,ledger,deposits,
│       │                     settlements,poolSnapshots,nonces,idempotency,leases}.ts
│       └── test/{indexes,ledger}.test.ts
└── scripts/  package.json tsconfig.json
    ├── create-config.ts seed-models.ts refill-float.ts devnet-e2e.ts dev-signin.ts smoke-local.ts
    └── load/gateway-load.ts
```

## 6. Phases and tasks

**Gates** (these reconstruct the spec's 5-gate roadmap, L606–610):

| Gate | Phases | Target date |
|---|---|---|
| G-Foundation | P0+P1 | Oct 2 |
| G-Chain | P2 + `create-config --dry-run` + **H0** (real devnet create-config, launch, one swap) | Oct 4 |
| G-Gateway | P3 + P4 core | Oct 5 |
| G-Settlement | P5+P6 (operator devnet e2e H6 on Oct 8–9) | Oct 8 |
| G-Ship | P7+P8+P9 CORE; mainnet launch H8/H10 so settlements run for 2+ days | Oct 10 |

Oct 11 is buffer (optional Wave C cut tasks, human review). Oct 12 is reserved for the demo video and submission only (§7).

**Conventions used in every task:**
- **TDD:** write a failing test first, then implement, then refactor.
- **Commit:** one commit per task, in the form `type(scope): summary [Pn-Tm]`.
- **Scope tag:** `CORE` = MVP-core, `CUT` = MVP-cut-list (scheduled last).
- **Category:** q=`quick`, uh=`unspecified-high`, d=`deep`, ub=`ultrabrain`, ve=`visual-engineering`.
- **∥** means the task can run in parallel with siblings whose dependencies are met.
- Web tasks load the `frontend-ui-ux` skill, and every task loads `git-master` for its commit.
- **Test accepts name files, never `-t`:** `pnpm --filter <pkg> exec vitest run <path>` fails with "No test files found" when the path matches nothing, whereas a `-t <word>` that matches no test name skips everything and exits 0.
- **Env loading:** nothing loads `.env` implicitly. Commands that need `MONGODB_URI` and friends use `node --env-file=<file>` or `tsx --env-file=<file>` explicitly.
- **No secrets in the agent env:** agents' environments never contain any `*_SECRET_KEY`.

### Phase 0: Scaffold, tooling, CI, compose (gate: install/lint/typecheck/test/build pass on skeletons)

**P0-T1 Root workspace** · CORE · q · 1h · deps: none
- **Files:** `package.json` (`packageManager: pnpm@12.6.0`, `engines.node ">=20.18.1 <21"`, scripts `lint typecheck test build format format:check dev smoke:local`), `pnpm-workspace.yaml` (`packages: apps/*, packages/*, scripts`; `overrides: {"@solana/web3.js": "^1.99.0"}`; `onlyBuiltDependencies: [esbuild, mongodb-memory-server, bufferutil, utf-8-validate]`; `injectWorkspacePackages: true` for `pnpm deploy` in P8-T5; pnpm 10+ reads these from the workspace file, not `package.json`), `.npmrc`, `.nvmrc` (`20.20`), `.gitignore` (`.env`, `dist`, `*.keypair.json`, `id.json`), `.editorconfig`, `tsconfig.base.json` (strict, NodeNext, `noUncheckedIndexedAccess`), `tsconfig.json` (references).
- **Also:** `git init -b main`.
- **Verify pnpm 10+ behaviour:** after `pnpm install`, confirm no "ignored build scripts" warning for the allow-listed packages.
- **Accept:** `pnpm install` exits 0; `git status` shows a repo; `grep -q '@solana/web3.js' pnpm-workspace.yaml && grep -q onlyBuiltDependencies pnpm-workspace.yaml && grep -q 'injectWorkspacePackages: true' pnpm-workspace.yaml`. Single-copy check (`grep` does not prove it): `pnpm why -r @solana/web3.js | grep -o '@solana/web3.js@1\.[0-9.]*' | sort -u | wc -l` prints `1`; web3.js is first installed in P2-T1, so this command is also part of the P2-T1 and P7-T1 accepts.

**P0-T2 ESLint + Prettier** · CORE · q · 1h · deps: P0-T1 · ∥ P0-T3..T5
- **Files:** `eslint.config.js` (typescript-eslint recommendedTypeChecked with `parserOptions.projectService.allowDefaultProject: ['*.config.ts', '*.config.js', 'eslint.config.js']` so files outside any tsconfig don't error; react-hooks for `apps/web`; `no-floating-promises: error`; ban `console` except scripts), `.prettierrc`, `.prettierignore`; root script `format:check` = `prettier --check .` (`pnpm format --check` would append `--check` to `--write`).
- **Accept:** `pnpm lint` exits 0; `pnpm format:check` exits 0.

**P0-T3 Package skeletons (shared, chain, db, mock-upstream)** · CORE · q · 1.5h · deps: P0-T1 · ∥
- **Files:** for each package, `package.json` (exports with a `development` condition plus `types` → `dist/*.d.ts`, G10), `tsconfig.json` (composite, no `customConditions`), `vitest.config.ts` (`resolve.conditions:['development']` and `ssr.resolve.conditions:['development']`), `src/index.ts`, `test/smoke.test.ts`.
- **db:** `vitest` globalSetup starting `MongoMemoryReplSet` (`MONGOMS_VERSION=7.0.14`); `@ibt/db` is the only package depending on `mongoose` (G11).
- **Confirm G10:** a smoke test in `@ibt/chain` imports `@ibt/shared` and asserts the resolved module path ends in `src/index.ts` (development condition used). If it resolves to `dist`, switch to `resolve.alias` and note it in G10.
- **Accept:** `pnpm -r --filter "./packages/*" test` passes; `pnpm -r build` emits `dist/index.js` and `dist/index.d.ts`; `pnpm typecheck` passes on a fresh clone without a prior build.

**P0-T4 App skeletons (api, keeper, web, scripts)** · CORE · q · 1.5h · deps: P0-T1 · ∥
- **api:** `src/main.ts` with `GET /healthz`; dev `tsx watch --conditions=development src/main.ts`; build `tsc -b`.
- **keeper:** `src/main.ts` with `/healthz` on 4001.
- **web:** Vite 5 + React 18 minimal `App.tsx`.
- **scripts:** `package.json` with a `tsx` dependency.
- **Accept:** `pnpm build` produces `apps/api/dist/main.js`, `apps/keeper/dist/main.js`, `apps/web/dist/index.html`; `node apps/api/dist/main.js & sleep 1; curl -s http://localhost:4000/healthz; kill %1` prints `{"ok":true}` and leaves no server on :4000.

**P0-T5 Compose + env examples** · CORE · q · 1h · deps: P0-T1 · ∥
- **`docker-compose.yml`:** `mongo:7` with `--replSet rs0`, a healthcheck that runs `rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]})` once (a member named by the container hostname is unreachable from the host), port 27017, a named volume. Example `MONGODB_URI=mongodb://localhost:27017/ibt?replicaSet=rs0&directConnection=true`.
- **`.env.example` per app:** every variable from L551–566 plus G26 vars, with placeholder values. Never put a real key in an example file.
- **Accept:** `docker compose up -d mongo && docker compose exec mongo mongosh --quiet --eval 'rs.status().ok'` prints `1`; `mongosh "mongodb://localhost:27017/?replicaSet=rs0&directConnection=true" --quiet --eval 'db.hello().isWritablePrimary'` run from the host prints `true`; `grep -c MONGODB_URI apps/*/.env.example` ≥ 2.

**P0-T6 CI workflow** · CORE · q · 1h · deps: P0-T2..T4
- **`.github/workflows/ci.yml`:** push job runs Node 20.20, corepack pnpm, cache pnpm store and `~/.cache/mongodb-binaries`, `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`, `build` (L570).
- **Nightly job:** `schedule: cron '0 3 * * *'`, `DEVNET_E2E=1` running `pnpm tsx scripts/devnet-e2e.ts` only if the `DEVNET_RPC_URL` secret exists.
- **Accept:** `npx --yes @action-validator/cli .github/workflows/ci.yml` exits 0 (fallback: a `yq` parse).

**P0-T7 Gate G0 check** · CORE · q · 0.5h · deps: P0-T1..T6
- **Accept:** `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build` all exit 0.

### Phase 1: `packages/shared`

**P1-T1 Constants + cluster config** · CORE · q · 1h · deps: P0-T7
- **`constants.ts`:** program IDs and addresses (L129–134, L655–663), USDC mints per cluster, `MIGRATION_THRESHOLD_SOL {devnet:1, 'mainnet-beta':10}`, `DEFAULT_SPLITS_BPS`, `HOLDER_MIN_BASE_UNITS = 1_000_000n * 10n**6n`, `HOLDER_DISCOUNT_BPS=1000`, `RATE_LIMIT_PER_MIN=60`, `MAX_TOKENS_CAP=8192`, `DEFAULT_MAX_TOKENS=1024`, `FIRST_BYTE_TIMEOUT_MS=30000`, `TOTAL_TIMEOUT_MS=300000`, `HOLD_TTL_MS=600000`, `NONCE_TTL_MS=300000`, `JWT_TTL_S=86400`, `MIN_PAYOUT_MICRO=1_000_000`, `DAILY_CAP_DEFAULT_MICRO=50_000_000`.
- **Accept:** `pnpm --filter @ibt/shared exec vitest run test/constants.test.ts` passes; the test asserts the splits sum to 10000 and the addresses are valid base58 of length 32–44.

**P1-T2 Money + pricing math (TDD)** · CORE · d · 1.5h · deps: P1-T1 · ∥ P1-T3..T5
- **`money.ts`:** `microToUsdcString(bigint)` (6 dp), `usdcStringToMicro`, `lamportsToSol`.
- **`pricing.ts`:** `computeCostMicro({pt,ct,inPrice,outPrice})` (G16, BigInt), `estimateHoldMicro`, `applyDiscount`.
- **Tests:** boundary cases (1 token at 1 micro/MTok → 1; 0 tokens → 0; values above 2^53 as strings).
- **Accept:** `pnpm --filter @ibt/shared exec vitest run test/pricing.test.ts` has ≥ 12 assertions and passes.

**P1-T3 Split + conversion math (TDD)** · CORE · d · 1h · deps: P1-T1 · ∥
- **`split.ts`:** `splitRevenue(revMicro, splits, phase)` where `phase:'none'` folds liquidity into the provider (G17) and the remainder goes to the platform; `sliceToLamports(sliceMicro, solPriceMicroUsdc)` floored.
- **Tests:** a property test over 10k random values asserting `p+l+f===rev` and that the platform gets the remainder (L587).
- **Accept:** `pnpm --filter @ibt/shared exec vitest run test/split.test.ts` passes.

**P1-T4 Zod schemas + DTOs** · CORE · uh · 2h · deps: P1-T1 · ∥
- **Coverage:** schemas for every request and response in L383–457.
- **Chat:** `ChatCompletionRequest` uses `.passthrough()` and requires `model` and `messages`; `max_tokens ≤ 8192`.
- **Common:** cursor/limit (max 100) and the error envelope.
- **`signin.ts`:** `buildSignInMessage` (G22).
- **Accept:** `pnpm --filter @ibt/shared exec vitest run test/schemas.test.ts` passes; the test round-trips the example payloads at L409–455.

**P1-T5 AppError + error catalog** · CORE · q · 1h · deps: P1-T1 · ∥
- **`errors.ts`:** `AppError {code,httpStatus,publicMessage,details}` plus a frozen catalog of every code in L417–426 and L436–446, plus `daily_cap_exceeded`, `deposit_pending` (202, retryable, P3-T7), `unauthorized`, `forbidden`, `not_found`, `settlement_not_retryable`, `internal`.
- **Accept:** `pnpm --filter @ibt/shared exec vitest run test/errors.test.ts` passes; the test asserts each status from the spec table.

**P1-T6 Node-only utilities (`@ibt/shared/node`)** · CORE · uh · 1.5h · deps: P1-T5
- **`crypto.ts`:** AES-256-GCM `encrypt/decrypt` with a per-row 12-byte IV and base64 `iv|tag|data` (L297, L516).
- **`ids.ts`:** `generateApiKey()` → `ibt_`+base58(32B), `sha256Hex`, `prefix(12)`, `generateDepositRef()` (8 base58 chars).
- **`logger.ts`:** pino with redaction using exact paths: `req.headers.authorization`, `err.headers`, `*.apiKey`, `*.apiKeyEnc`, `MASTER_KEY`, `JWT_SECRET`, `ADMIN_TOKEN`, `*_SECRET_KEY` (expanded to each concrete `*_SECRET_KEY` env name, since pino paths don't glob on key suffixes).
- **`alerter.ts`:** `Alerter` interface with the log transport (G27).
- **`env.ts`:** `parseEnv(schema)`.
- **Web import guard:** add an ESLint `no-restricted-imports` rule for `apps/web/**` banning `@ibt/shared/node`, `@ibt/db` and `@ibt/chain/testing` ("web build passes" proves nothing because web doesn't import shared yet).
- **Accept:** `pnpm --filter @ibt/shared exec vitest run test/node.test.ts test/logger.test.ts` passes. Cases: tamper → decrypt throws; the logger redacts the bearer token; an upstream-error log record built from a request carrying a decrypted upstream key (in headers, `err.headers` and a nested `apiKey`) never contains the plaintext key. Also `pnpm lint` exits 0 and `grep -q '@ibt/shared/node' eslint.config.js`.

### Phase 2: `packages/chain`

**P2-T1 SDK surface verification** · CORE · d · 1h · deps: P0-T7 · ∥ Phase 1
- **Install:** both SDKs (exact pins), web3.js, spl-token, bn.js.
- **`src/sdk.ts`:** re-exports the needed symbols with comments listing the §4 drift.
- **`test/sdk-surface.test.ts`:** asserts every name in §4 is `typeof 'function'` or defined; asserts `DAMM_V2_MIGRATION_FEE_ADDRESS[2].toBase58()==='Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp'`; asserts `derivePoolAddress` is symmetric in mint order (otherwise documents the required order).
- **Also:** confirm the Jupiter price endpoint from Jupiter docs and record it in `.env.example` (G25), including whether `JUPITER_API_KEY` is required (G26).
- **Accept:** `pnpm --filter @ibt/chain exec vitest run test/sdk-surface.test.ts` passes; `pnpm --filter @ibt/chain exec node -e "import('@meteora-ag/dynamic-bonding-curve-sdk').then(m=>{if(typeof m.buildCurve!=='function')process.exit(1)})"` exits 0 (run inside the package; from the root, strict pnpm can't resolve the SDK); `pnpm why -r @solana/web3.js | grep -o '@solana/web3.js@1\.[0-9.]*' | sort -u | wc -l` prints `1`.

**P2-T2 RPC client** · CORE · uh · 1h · deps: P2-T1
- **`rpc.ts`:** `createRpc({primary, fallback})` exposing a `Connection` pair and `withRetry(fn)` with backoff 500/2000/8000 ms (L259) that fails over to the fallback after 2 primary errors.
- **Tests:** use fake timers.
- **Accept:** `pnpm --filter @ibt/chain exec vitest run test/rpc.test.ts` passes, including the "uses fallback on 3rd attempt" case.

**P2-T3 `sendAndConfirm` (TDD)** · CORE · ub · 2h · deps: P2-T2, P1-T5
- **Rules (L258):** fresh blockhash per attempt; `confirmTransaction({signature, blockhash, lastValidBlockHeight})`; on `TransactionExpiredBlockheightExceededError`, check `getSignatureStatuses` first and **return if it landed**, otherwise rebuild, re-sign and resend; max 3 attempts; extra signers (position NFT keypairs) supported; `simulate` option.
- **`onSigned(sig, lastValidBlockHeight)` hook:** called after signing and **awaited before** `sendRawTransaction` on every attempt, so the caller persists the signature before the tx can land (closes the double-pay window, L172, L599). If `onSigned` throws, nothing is sent.
- **Fake:** a `FakeConnection`.
- **Accept:** `pnpm --filter @ibt/chain exec vitest run test/send.test.ts` passes these cases: success first try; expiry then success; expiry but already landed (no resend); 3 failures throw `AppError('chain_send_failed')`; `onSigned` resolves before the send call (call-order assertion); `onSigned` throwing → zero sends.

**P2-T4 Deposit parser (TDD)** · CORE · ub · 2h · deps: P2-T1 · ∥ P2-T2
- **`deposit.ts`:** `parseDeposit(parsedTx, {usdcMint, treasuryAta, depositRef})` → `{ok, amountMicro, slot}` or `{ok:false, reason}`.
- **Checks (L519):** `meta.err===null`; an SPL `transfer` or `transferChecked` (top-level or inner) to `treasuryAta`; mint = USDC (for plain `transfer`, resolve through `postTokenBalances`); a Memo program instruction equal to `depositRef`; amount taken from the instruction, never from the client.
- **`testing/fixtures.ts`:** `buildDepositFixture(overrides)`.
- **Accept:** `pnpm --filter @ibt/chain exec vitest run test/deposit.test.ts` passes 8 cases (valid ×2 variants, wrong memo, wrong mint, wrong destination, failed tx, no memo, two transfers summed only to the treasury).

**P2-T5 Partner config builder + snapshot** · CORE · d · 1h · deps: P2-T1 · ∥
- **`config.ts`:** `buildPartnerConfigParams(cluster)` calls `buildCurve` with exactly the parameters at L97–113 (with the §4 drift corrections) and `migrationQuoteThreshold` 10 or 1; `buildCreateConfigTx({connection, configPubkey, treasury, cluster})`.
- **Snapshot:** BN values serialized to strings.
- **Accept:** `pnpm --filter @ibt/chain exec vitest run test/config.test.ts` passes. A committed `__snapshots__/config.test.ts.snap` exists for both clusters, and explicit assertions check `creatorTradingFeePercentage===50`, `migrationFeeOption===2`, `poolCreationFee` 0, and the locked LP percentages 50/50.

**P2-T6 DBC wrapper** · CORE · ub · 2h · deps: P2-T3, P2-T5, P1-T5
- **`dbc.ts`:**
  - `readPool(mint|pool)` → normalized DTO (string base units, `progress = quoteReserve/migrationQuoteThreshold`, `isMigrated`);
  - `verifyLaunch({signature, mint, expectedConfig, expectedCreator})`: tx succeeded, `deriveDbcPoolAddress(NATIVE_MINT, mint, config)` exists, `pool.config===ours`, `pool.creator===owner` (L122, L524);
  - `quoteBuy(pool, lamports)` via `swapQuote2` PartialFill (L123);
  - `buildCurveBuyTx(keeper, pool, lamports, minOut)`;
  - `buildMigrateTx(keeper, pool)` returning the tx plus 2 NFT signers;
  - `feeMetrics(pool)`.
- **Tests:** pure functions run on JSON fixtures of `VirtualPool`/`PoolConfig`. SDK builders fetch accounts through `Connection`, so builder tests either assert the SDK-call parameters with `vi.spyOn(client.pool, 'swap2')` etc., or stub `getAccountInfo`/`getMultipleAccountsInfo` to return encoded fixture accounts. No RPC is ever contacted.
- **Accept:** `pnpm --filter @ibt/chain exec vitest run test/dbc.test.ts` passes (progress math, verifyLaunch mismatch → `pool_mismatch`, `buildCurveBuyTx`/`buildMigrateTx` call the SDK with the expected params).

**P2-T7 DAMM v2 wrapper** · CORE · ub · 2h · deps: P2-T3 · ∥ P2-T6
- **`damm.ts`:** `deriveDammPool(mint)` (fee config `Hv8L…`, base mint, WSOL; ordering per P2-T1), `readDammPool`, `quoteSwap` (`getQuote2`), `depositQuote` (`getDepositQuote`), `buildCreatePositionAndAdd`, `buildAddLiquidity`, `buildPermanentLock`, `buildClaimPositionFee`, `buildSwap`.
- **WSOL:** wrap and unwrap are handled internally.
- **Tests:** same approach as P2-T6: `vi.spyOn` on the cp-amm SDK methods, or `getAccountInfo`/`getMultipleAccountsInfo` stubbed with encoded fixture accounts; no RPC.
- **Accept:** `pnpm --filter @ibt/chain exec vitest run test/damm.test.ts` passes (derivation is deterministic; the builders call the SDK with the expected params and produce transactions with the expected program id `cpamdp…` on a stubbed fixture pool state).

**P2-T8 ChainClient + Fake + SPL + price** · CORE · d · 2h · deps: P2-T4, P2-T6, P2-T7
- **`client.ts`:** `ChainClient` interface used by api and keeper: `getParsedTx`, `verifyDeposit`, `verifyLaunch`, `readPool`, `readDammPool`, `tokenBalance(wallet,mint)`, `solBalance`, `usdcBalance`, `transferUsdc(from,toWallet,amount)` (creates the ATA idempotently, L176), `curveBuy`, `migrate`, `dammSwap`, `addAndLock`, `claimPositionFee`, `signatureStatus`. Every sending method takes `{onSigned}` and passes it to `sendAndConfirm` (P2-T3). `RealChainClient` composes P2-T2..T7.
- **`price.ts`:** `JupiterPriceSource` (sends `JUPITER_API_KEY` as a header when set) and `FakePriceSource`.
- **`testing/fake-chain.ts`:** in-memory pools, balances and signatures; `failNext(method, n)`; `crashAfter(method)`; `crashAfterLand(method)` (the tx is recorded as landed, then the call throws before returning, simulating a crash between landing and persist); `migrateWhen(threshold)`; every call is recorded for assertions; `onSigned` is invoked before a tx "lands".
- **Optional persistence:** `createFakeChain({ mongo?: Connection })`. When a Mongo connection is passed, every landed tx (`{signature, method, from, to, amount, mint, settlementRef, ts}`) is also written to the `fakeChainTxs` collection through `connection.collection('fakeChainTxs')`, and `signatureStatus` reads from it, so state survives a process SIGKILL. `@ibt/chain` takes the connection as a structural type only (no `mongoose` dependency, G11).
- **Accept:** `pnpm --filter @ibt/chain exec vitest run test/fake-chain.test.ts` passes (including persistence against an in-memory stub of `collection()`: insert on land, `signatureStatus` answered from the stored rows by a fresh fake instance); `pnpm --filter @ibt/chain typecheck` exits 0.

### Phase 3: `packages/db` + `apps/api` core

**P3-T1 Mongoose models + indexes** · CORE · uh · 2h · deps: P1-T4
- **Collections:** all 11 (L266–368 plus G13), with the extra fields from G14, G15, G18–G21, plus `token.status:'pending'` (set by `/launch/prepare`, P5-T1), `upstream.supportsStreamUsage` (G28) and `settlements.pendingTx` (G20).
- **Indexes:**
  - users: `wallet` (u), `depositRef` (u)
  - apiKeys: `keyHash` (u), `(userId,createdAt)`
  - models: `slug` (u), `token.mint` (u, `partialFilterExpression: {'token.mint': {$type: 'string'}}`, not sparse), `providerId`
  - requests: `requestId` (u), `createdAt` TTL 90 d, `(modelId,settlementId,createdAt)`, `(userId,createdAt)`, partial `(userId,idempotencyKey)` **non-unique** (rows live 90 days; a key may be reused after 24 h)
  - ledger: `(userId,createdAt)`, `(type,status,expiresAt)`
  - deposits: `txSignature` (u)
  - settlements: `(modelId,periodStart)` (u), `(state,updatedAt)`
  - poolSnapshots: `(modelId,ts)`, `ts` TTL 30 d
  - nonces: `expiresAt` TTL
  - idempotency: `(userId,key)` (u); separate single-field `createdAt` TTL index (24 h)
  - leases: `expiresAt` TTL
- **`connect.ts`:** `connectDb(uri)`; `index.ts` re-exports `mongoose`'s connection, all models and `syncAllIndexes()` (calls `syncIndexes()` on every model) so api, keeper and scripts never import `mongoose` directly (G11).
- **Accept:** `pnpm --filter @ibt/db exec vitest run test/indexes.test.ts` passes; the test runs `syncIndexes()` and asserts every index above by key spec and options (including `unique` absent on `requests.(userId,idempotencyKey)` and the partial filter on `token.mint`); `grep -L '"mongoose"' apps/api/package.json apps/keeper/package.json` lists both files.

**P3-T2 API app factory + middleware + harness** · CORE · uh · 2h · deps: P1-T6, P3-T1, P2-T8
- **`app.ts`:** `createApp({env, chain, alerter, clock})`.
- **Proxy:** `app.set('trust proxy', env.TRUST_PROXY)` (default `1`, G26) so IP rate limits and `ADMIN_IP_ALLOWLIST` see the client IP on Railway and express-rate-limit doesn't throw on `X-Forwarded-For` (L230, L523).
- **Middleware order:** requestId (echo or generate, L407) → pino-http (L257 fields) → helmet → cors (`WEB_ORIGIN` only) → json limit 1 MB (L522).
- **Routes:** `/healthz`, `/readyz` (Mongo ping plus `chain.ping`, L529); 404; error handler (envelope `{error:{code,message,requestId}}`, no stack, L260); `main.ts` with graceful shutdown.
- **`env.ts`:** the api env schema **rejects** startup when `KEEPER_SECRET_KEY` or `TREASURY_SECRET_KEY` is present (L190); `CHAIN_MODE=fake` is refused unless the `MONGODB_URI` host is localhost/127.0.0.1 (G24).
- **`test/helpers.ts`:** `makeTestApp()` with MongoMemoryReplSet and FakeChainClient; calls `syncAllIndexes()` before any test transaction.
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/app.int.test.ts test/env.test.ts` passes (the X-Request-Id header is present; an unknown route returns 404 with the envelope; a thrown error leaks no stack; `X-Forwarded-For` is honoured for `req.ip`; env with `TREASURY_SECRET_KEY` set fails to parse).

**P3-T3 Auth module** · CORE · uh · 1.5h · deps: P3-T2 · ∥ P3-T4, P3-T5
- **Endpoints:** `POST /api/auth/nonce`, `POST /api/auth/verify` (L223, L518): random nonce, single use, 5-minute expiry; `tweetnacl.sign.detached.verify` over `buildSignInMessage`; upsert the user with a new `depositRef`; jose HS256 24 h JWT `{userId, wallet, role}`.
- **Also:** `jwtAuth` middleware; rate limit on auth routes (10/min/IP).
- **Tests:** use an ephemeral `nacl.sign.keyPair()`.
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/auth.int.test.ts` passes (valid → token; replayed nonce → 401; expired → 401; wrong wallet signature → 401).

**P3-T4 API keys + key auth** · CORE · uh · 1.5h · deps: P3-T3
- **Endpoints:** `GET/POST/DELETE /api/keys` (L224, L390, L497); `GET` takes `?cursor=&limit=` (limit ≤ 100, opaque cursor, L457); `POST` returns the full key once, stores only the SHA-256, `prefix(12)` and `dailyCapMicroUsdc`.
- **`apiKeyAuth`:** hashes the bearer key, loads key and user, revoked → 401 `invalid_api_key`, updates `lastUsedAt` (throttled).
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/keys.int.test.ts` passes (the full key appears exactly once; the list never contains it; a revoked key gets 401 on `/v1/models`; 3 keys with `limit=2` → 2 items plus a cursor that returns the third).

**P3-T5 Models module** · CORE · uh · 2h · deps: P3-T3 · ∥ P3-T4
- **Endpoints:** `GET /api/models?cursor=&limit=` (limit ≤ 100, L457), `GET /api/models/:slug` (public, includes `stats` and `token`), `POST /api/models` (sets the role to provider, encrypts the upstream key), `PATCH /api/models/:id` (owner only; `PATCH` replaces the key, never reads it back, L516; also accepts `status: 'active'|'paused'` for the provider pause/resume UI, L483, and resuming resets `health.consecutiveFailures` to 0).
- **Rule:** `upstream.apiKeyEnc` is stripped from every response through a schema transform.
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/models.int.test.ts` passes; the test greps every response body for `apiKeyEnc` and the plaintext key and finds neither; owner pause → `status:'paused'`, resume → `active` with `consecutiveFailures:0`, non-owner → 403; pagination returns a cursor.

**P3-T6 Ledger service (TDD)** · CORE · ub · 2h · deps: P3-T1, P1-T2, P1-T5
- **Location:** `packages/db/src/ledger.ts`, exported from `@ibt/db` so the api (P3-T7, P4-T4), the keeper (P6-T7, P6-T8) and scripts (P8-T2) all import the same service. Tests run in `@ibt/db` with the P0-T3 global `MongoMemoryReplSet` setup, so this task does **not** depend on the api harness (P3-T2). All multi-doc writes use `session.withTransaction`; tests call `syncAllIndexes()` first.
- **`ledger.ts`:**
  - `hold(userId, est)` (G14: conditional `$inc heldMicroUsdc`, fails with 402 and `shortfallUsdc`);
  - `capture(holdId, cost, requestDoc)` (session: close the hold, `$inc balance −cost, held −est`, insert the capture row with `balanceAfter`, insert the request);
  - `release(holdId)`;
  - `expireHolds(now)`;
  - `credit(userId, amount, ref)`;
  - `adjust`;
  - `recomputeBalance(userId)` (L372).
- **Accept:** `pnpm --filter @ibt/db exec vitest run test/ledger.test.ts` passes. Cases: all transitions; double capture is a no-op; 50 concurrent holds against a balance of 10 holds never let `balance−held` go below 0.

**P3-T7 Billing endpoints + `/api/me`** · CORE · uh · 2h · deps: P3-T6, P3-T4
- **`POST /api/billing/deposits`:** `chain.getParsedTx(sig, 'finalized')` → `parseDeposit` → credit (via `@ibt/db` ledger). Errors: 409 `deposit_already_credited` (unique signature), 422 `deposit_invalid` (rejected row stored with the reason), rate-limited (L395, L432–437, L519).
- **Not finalized yet:** if `getParsedTx(sig,'finalized')` returns null but the signature is known at `confirmed`, return retryable **202 `deposit_pending`** with no `rejected` row, so it doesn't count toward the "rejected > 5/h" alert (L519). The client polls (P7-T6).
- **Other endpoints:** `GET /api/billing/ledger?cursor=` (opaque base64 cursor, limit ≤ 100), `GET /api/billing/usage?from=&to=` (aggregated per model per day), `GET /api/me` (profile, balance, held, depositRef).
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/billing.int.test.ts` passes (credit → 200 `{credited:true, amountUsdc:"25.000000"}`; replay → 409; wrong memo → 422 and a `rejected` row plus a log line; confirmed-but-not-finalized → 202 `deposit_pending` and zero `rejected` rows, then 200 once the fake finalizes it).

### Phase 4: Gateway

**P4-T1 Mock upstream** · CORE · q · 1.5h · deps: P0-T3
- **Modes** (set by `x-mock-mode` header or model name suffix): `ok`, `stream`, `error500`, `slow-first-byte`, `slow-stream`, `no-usage`, `malformed`, `stream-no-done`.
- **`createMockUpstream({port})`:** returns `{url, close, calls}`; `main.ts` serves on `MOCK_UPSTREAM_PORT=4010`; checks the `Authorization` header.
- **Accept:** `pnpm --filter @ibt/mock-upstream test` passes; `pnpm --filter @ibt/mock-upstream start & sleep 1; curl -s http://localhost:4010/v1/chat/completions -H 'Content-Type: application/json' -H 'Authorization: Bearer test' -d '{"model":"m","messages":[]}'; kill %1` prints JSON with `usage`.

**P4-T2 Token counting** · CORE · q · 1h · deps: P1-T2 · ∥ P4-T1
- **`gateway/tokenCount.ts`:** lazy `cl100k_base` singleton; counts messages (role and content, including array content parts); `count(text)`; never frees the shared encoder per call.
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/tokenCount.test.ts` passes ("Hello" → known count; 1k calls construct the encoder exactly once, asserted with `vi.spyOn` on the tiktoken factory; no heap-growth assertion, it's flaky).

**P4-T3 `/v1/models` + resolve + validation** · CORE · uh · 1h · deps: P3-T4, P3-T5
- **Behaviour:** `GET /v1/models` returns OpenAI list format with prices (L386); resolve the slug (404 `model_not_found`, 503 `model_paused`); zod 400 `invalid_request`; enforce the `max_tokens` cap.
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/gateway-resolve.int.test.ts` passes.

**P4-T4 Non-streaming chat completions** · CORE · ub · 2h · deps: P4-T1..T3, P3-T6
- **Flow** (L232–239): estimate (L236) → hold → undici `request` to `baseUrl/chat/completions` with the upstream model name and decrypted key (`headersTimeout:30000`, `bodyTimeout` plus an overall `AbortSignal.timeout(300000)`) → validate the `choices` array → usage or tiktoken (L147) → capture → headers `X-Request-Id`, `X-Cost-Usdc`, `X-Balance-Usdc`, `X-Discount-Bps` (L415).
- **Injectable timeouts:** `createApp` takes `timeouts: {firstByteMs, totalMs}` defaulting to `FIRST_BYTE_TIMEOUT_MS`/`TOTAL_TIMEOUT_MS`; tests pass ~100 ms so they never wait 30 s.
- **Failures:** non-2xx or malformed → release and 502; timeout → release and 504; each writes a request doc with status `upstream_error`/`timeout`.
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/gateway.int.test.ts` passes (supertest against `makeTestApp()` plus `createMockUpstream()`): happy path with `X-Cost-Usdc` and hold + capture rows in `GET /api/billing/ledger`, 402 with `shortfallUsdc`, upstream 500 not billed, timeout releases (injected 100 ms timeout), revoked key, and usage-estimated cases. No live curl here: nothing is seeded until P8-T2; the live curl runs in P9-T1.

**P4-T5 Rate limit + daily cap** · CORE · uh · 1h · deps: P4-T4
- **Rate limit:** express-rate-limit keyed by `keyHash`, 60/min, 429 `rate_limited` with the envelope (L423).
- **Daily cap:** sum of today's (UTC) captured cost per key from `requests` (index-backed), checked before the hold, 429 `daily_cap_exceeded` (G21).
- **Overrides:** both limits read optional env overrides `RATE_LIMIT_PER_MIN` / `DAILY_CAP_USDC` (wired in P8-T6, G26); the shared constants stay the defaults.
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/limits.int.test.ts` passes (the 61st request gets 429; a cap of 1 USDC is hit after N requests).

**P4-T6 Streaming pass-through** · **CUT** · ub · 2h · deps: P4-T4
- **Behaviour** (L238, L415): send the cost headers (hold estimate) before the first chunk; pipe the undici body to `res` with back-pressure (`pipeline`); tee to an SSE parser; detect `[DONE]`; read final usage or tiktoken over the concatenated deltas; capture after the end. `stream_options.include_usage` is sent only when `upstream.supportsStreamUsage` is true (G28).
- **Failure handling:** a missing `[DONE]` → release with `upstream_error`; client disconnect → abort upstream, release, `client_abort`; 300 s total → 504 or stream end with release.
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/streaming.int.test.ts` passes (the bytes match the mock exactly; `[DONE]` present → captured; no-done → released; abort → released; flag off → no `stream_options` in the upstream body).

**P4-T7 Idempotency keys** · **CUT** · uh · 1.5h · deps: P4-T4
- **Behaviour** (L148): `Idempotency-Key` → insert `{userId,key,state:'in_flight'}` (a unique conflict on an in-flight key returns 409 `idempotency_in_progress`); on completion store status, headers and body; a replay returns the stored response with `Idempotency-Replayed: true` and is never billed. Streaming plus a key is replayed as the stored assembled JSON.
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/idempotency.int.test.ts` passes (2 identical calls → 1 capture row).

**P4-T8 Holder discount** · **CUT** · uh · 1h · deps: P4-T4, P2-T8
- **Behaviour** (L186, L241): `chain.tokenBalance(user.wallet, model.token.mint)` cached in a 5-minute TTL map keyed by `wallet:mint`; ≥ `HOLDER_MIN_BASE_UNITS` → 1000 bps; `discountBps` stored on the request; RPC failure → no discount, no error.
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/discount.int.test.ts` passes (cost is 90%; 2 calls → 1 RPC read; at 5 min + 1 s → re-read).

### Phase 5: Tokens, metadata, admin

**P5-T1 Launch prepare + confirm** · CORE · d · 2h · deps: P3-T5, P2-T8
- **`POST /api/tokens/launch/prepare {modelId, mint}`** (L122): owner only, called **before** the wallet signs; stores `token.{status:'pending', mint}` so `/metadata/<mint>.json` resolves before any indexer fetches the immutable URI (P5-T3). Re-preparing with a new mint replaces a still-pending one; a model already on `curve`/`graduated` → 409.
- **`POST /api/tokens/launch/confirm`** (L398, L440–446): owner only; the mint must equal the prepared one; `chain.verifyLaunch` → sets `token.{status:'curve', mint, dbcPool, launchSignature}`; 422 `pool_mismatch` with a message; idempotent if already launched with the same mint.
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/launch.int.test.ts` passes (prepare → `token.status:'pending'` and metadata 200 for that mint; good confirm → 200 `{token:{status:"curve",progress:0}}`; wrong creator → 422; wrong config → 422; non-owner → 403; confirm with an unprepared mint → 422).

**P5-T2 Token state / quote / settlements** · CORE · uh · 1.5h · deps: P5-T1, P3-T1
- **`GET /api/tokens/:mint/state`:** latest `poolSnapshots` row plus `stats`, with the shape at L452–454.
- **`GET /api/tokens/:mint/quote?side=&amount=`:** curve → dbc quote; graduated → damm quote.
- **`GET /api/tokens/:mint/settlements?cursor=`:** public settlement ledger.
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/tokens.int.test.ts` passes (state matches the shape; quote mirror equals the chain fake's value).

**P5-T3 Metadata + health-check service** · CORE · uh · 1.5h · deps: P3-T5 · ∥ P5-T1
- **Metadata:** `GET /metadata/:file` (strip `.json`; Metaplex JSON with name, symbol, description, image, `external_url`, `attributes:[{trait_type:'model', value: slug}]`, L229). Serves any model whose `token.mint` matches, **including `token.status:'pending'`** (set by `/launch/prepare`, P5-T1), so the URI never 404s once the wallet signs.
- **Health check:** `models/health.ts` sends one `max_tokens:1` completion and updates `health.lastOkAt/p50LatencyMs/consecutiveFailures`; the 3rd failure sets `status:'paused'` and alerts (L250); `POST /api/models/:id/health-check` (owner).
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/metadata.int.test.ts test/health.int.test.ts` passes (a pending mint returns 200 JSON; an unknown mint returns 404).

**P5-T4 Admin module** · CORE · uh · 1.5h · deps: P5-T3, P3-T1
- **`adminAuth`:** bearer `ADMIN_TOKEN` (constant-time compare) plus `ADMIN_IP_ALLOWLIST` (L230).
- **Endpoints:**
  - `POST /api/admin/settlements/:id/retry`: `failed` → state = `lastCompletedState`, `attempts=0`; otherwise 409.
  - `POST /api/admin/models/:id/pause`
  - `GET /api/admin/float`: keeper SOL vs `FLOAT_MIN_SOL`, treasury USDC vs next expected payout.
  - `POST /api/admin/health-checks/run` (G12).
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/admin.int.test.ts` passes (wrong token → 401; disallowed IP → 403).

**P5-T5 API alerts** · CORE · q · 1h · deps: P5-T4, P1-T6
- **Rolling counters:** 5xx rate > 2% over 5 minutes → alert; deposits rejected > 5 per hour → alert; model paused → alert (L530). All go through `Alerter`.
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/alerts.test.ts` passes using a fake clock and a fake alerter.

### Phase 6: `apps/keeper`

**P6-T1 Keeper shell + lease** · CORE · uh · 1.5h · deps: P3-T1, P2-T8
- **Setup:** `env.ts`, `main.ts`, `/healthz` on `KEEPER_PORT`.
- **`lease.ts`:** `leases` doc `{_id:'keeper', holder, expiresAt}` with a 90 s TTL, renewed every 30 s through a conditional `findOneAndUpdate`; losing the lease stops all jobs (L253). TTL and renew interval are injectable (`createLease({ttlMs, renewMs, clock})`) so tests use ~200 ms instead of 90 s.
- **`scheduler.ts`:** node-cron wrappers with a per-job overlap guard.
- **`cli/settle-once.ts`:** `--chain fake|real --period-start ISO`. Package script `settle:once` = `tsx --env-file=.env --conditions=development src/cli/settle-once.ts` (nothing else loads `.env`).
- **Keeper test harness:** `test/setup.ts` (vitest globalSetup starting `MongoMemoryReplSet`, same as P0-T3) and `test/helpers.ts` (`makeKeeperCtx()` → db connection from `@ibt/db` with `syncAllIndexes()`, `FakeChainClient` persisting to that connection, `FakePriceSource`, fake clock, fake alerter).
- **Accept:** `pnpm --filter @ibt/keeper exec vitest run test/lease.test.ts` passes (2 instances → 1 runs; after a holder crash, takeover happens after the injected TTL).

**P6-T2 poolPoller + migrationCrank** · CORE · d · 2h · deps: P6-T1
- **Every 15 s** (L247–248): for each `curve`/`graduated` model, read the pool, write a snapshot (reserves, sqrtPrice, progress, `priceSolPerToken`, `totalTradingQuoteFee`, `isMigrated`).
- **Curve complete and `isMigrated=0`:** `chain.migrate` (with NFT signers), store `token.migrationSignature`.
- **`isMigrated` flips:** derive the DAMM v2 pool, confirm it by reading, set `token.status='graduated'` and `dammV2Pool`.
- **Accept:** `pnpm --filter @ibt/keeper exec vitest run test/jobs.poolPoller.test.ts` passes (snapshot written; complete → 1 migrate call even across 2 ticks; flip → graduated).

**P6-T3 Settlement steps 1–3** · CORE · ub · 2h · deps: P6-T1, P1-T3
- **`period.ts`:** `[H-1, H)` in UTC (L172).
- **`steps.ts`:**
  - `lease` (insert `computing`; a duplicate-key error means another runner owns it);
  - `tagAndSum` (session: `updateMany {modelId, status:'success', settlementId:null, createdAt < periodEnd}` → `$set settlementId`, then aggregate by `settlementId`, L172, L175). Filtering on `createdAt < periodEnd` instead of `createdAt∈period` sweeps requests orphaned by missed hours into the next run;
  - **zero revenue:** `rev = 0` → `state:'done'` with phase `none` and no chain calls (keeps the L375 invariant);
  - `split`;
  - `payProvider` (accrued = share + carry; ≥ 1 USDC and ≤ cap → `transferUsdc` from treasury, store the signature, set carry to 0, `state:'paid_provider'`; otherwise update the carry, L176).
- **Persist-before-send:** every chain call passes `onSigned` (P2-T3), which writes `settlements.pendingTx {step, signature, lastValidBlockHeight}` before sending (G20). On resume, a step with a stored `pendingTx` first calls `chain.signatureStatus(signature)`: landed → record the signature and advance without resending; not landed and blockhash expired → clear `pendingTx` and rebuild; otherwise wait and re-check.
- **Accept:** `pnpm --filter @ibt/keeper exec vitest run test/settlement.steps1.test.ts` passes (includes: a request from 2 periods ago with `settlementId:null` gets tagged; zero-revenue period → `done`/`none` with zero fake-chain calls; stored landed `pendingTx` on `payProvider` → no second transfer).

**P6-T4 Settlement steps 4–5** · CORE · ub · 2h · deps: P6-T3, P6-T2
- **`convert`:** read the price, store the rate, compute lamports = slice + `sliceCarryOver` + `pendingCompoundLamports`, cap at `MAX_SLICE_SOL_PER_RUN` (excess carries over), `state:'converted'`. **Dust:** if the slice floors to 0 lamports, add the slice to `token.sliceCarryOverMicroUsdc`, skip `buyAndLock` and finish the run (L375 invariant holds).
- **`buyAndLock`** (re-reads the phase at this step):
  - none → skip;
  - curve → `curveBuy` PartialFill, add bought tokens to `escrowBaseUnits`, `state:'bought'`; if the curve is now complete → `migrate` in the same run (L178);
  - graduated → pair escrow with SOL first; once escrow is empty, swap half on DAMM v2; `createPositionAndAddLiquidity` once (store `keeperPosition`) or `addLiquidity`, then `permanentLockPosition`; store every signature; `state:'locked'` (L168, L178).
- **Resume:** every send in these steps uses the same `onSigned` → `pendingTx` → `signatureStatus` check as P6-T3 before rebuilding.
- **Accept:** `pnpm --filter @ibt/keeper exec vitest run test/settlement.steps2.test.ts` passes (includes: dust slice → `sliceCarryOverMicroUsdc` grows and zero buy calls; stored landed `pendingTx` on `curveBuy` → no second buy).

**P6-T5 Settlement 6–7, retries, orchestrator** · CORE · ub · 2h · deps: P6-T4
- **`compound`:** `claimPositionFee` → lamports go to `pendingCompoundLamports`, and any base-token fees go to `escrowBaseUnits` (L127); store `claimTxSignature`.
- **`finalize`:** `state:'done'`.
- **`engine.ts`:** runs from `lastCompletedState`; each step retries 3× with backoff on RPC or blockhash errors, then `failed` with `error` and an alert (L182); Mongo writes per step in `session.withTransaction`; honours `pendingTx` resume (P6-T3).
- **`orchestrator.ts`:** all models with concurrency 3 (L249), cron `SETTLEMENT_CRON`. **Resume scan:** at boot and at the start of every run, find settlements whose state is not `done`/`failed` (including ones an admin re-queued through `/retry`, P5-T4) and drive each through `engine` from `lastCompletedState` before opening new periods (L172, L182, L525, L599).
- **Accept:** `pnpm --filter @ibt/keeper exec vitest run test/settlement.engine.test.ts` passes (includes: a settlement left in `paid_provider` from an earlier run is finished on boot; an admin-retried `failed` settlement is executed on the next run; base fees from `claimPositionFee` land in `escrowBaseUnits`); `cp apps/keeper/.env.example apps/keeper/.env && docker compose up -d mongo && pnpm --filter @ibt/keeper settle:once --chain fake` prints a JSON summary (`settle:once` loads env with `tsx --env-file`, P6-T1).

**P6-T6 Settlement test suite** · CORE · ub · 2h · deps: P6-T5
- **Covers L589:** each transition; `crashAfter` each of the 7 steps → re-run → exactly one provider transfer and one buy (asserted on fake call logs); carry-over below 1 USDC across 2 periods; `maxSliceSolPerRun` cap; curve → graduated switch between convert and buy; no-token phase gives 90/10; second concurrent runner fails fast; invariant L375 checked on every `done` doc; **crash between landing and persist** (`crashAfterLand` on `transferUsdc` and on `curveBuy` → re-run → `signatureStatus` finds the landed tx through `pendingTx`, exactly one transfer/buy in the fake call log); zero-revenue period; dust slice; orphaned request from a missed hour.
- **Accept:** `pnpm --filter @ibt/keeper exec vitest run test/settlement.suite.test.ts` passes with ≥ 15 tests.

**P6-T7 healthCheck / floatMonitor / holdExpiry / stats jobs** · CORE · uh · 1.5h · deps: P6-T1, P5-T4, P3-T6
- **healthCheck:** every 60 s, calls the api endpoint (G12).
- **floatMonitor:** every 5 min (L251).
- **holdExpiry:** every 60 s, `expireHolds` imported from `@ibt/db` (P3-T6).
- **stats:** every 5 min, rolling 24 h requests, successRate, revenue, lockedLiquiditySol into `models.stats` (L308). `lockedLiquiditySol` = sum of SOL added to the locked position across all `done` settlements for the model (`settlements.liquidity.solAddedLamports`, L308, L454).
- **Accept:** `pnpm --filter @ibt/keeper exec vitest run test/jobs.periodic.test.ts` passes (includes: 2 settlements adding 0.3 and 0.2 SOL → `lockedLiquiditySol:"0.5"`).

**P6-T8 Nightly reconciliation** · CORE · uh · 1.5h · deps: P6-T5, P3-T6
- **Ledger:** sum per user vs `balanceMicroUsdc` → log drift and fix through `recomputeBalance` imported from `@ibt/db` (P3-T6).
- **Signatures:** every settlement signature from the last 48 h → `signatureStatus` must be success, otherwise alert (L531).
- **Accept:** `pnpm --filter @ibt/keeper exec vitest run test/jobs.reconcile.test.ts` passes (injected drift is detected and fixed; a failed signature raises an alert).

**P6-T9 Telegram transport** · **CUT** · q · 1h · deps: P1-T6
- **`shared/node/telegram.ts`:** undici POST `sendMessage`; when `TELEGRAM_*` is unset, use the log transport; transport failures are logged and swallowed.
- **Accept:** `pnpm --filter @ibt/shared exec vitest run test/telegram.test.ts` passes (mocked with undici `MockAgent`).

### Phase 7: `apps/web` (all load `frontend-ui-ux`)

**P7-T1 Web shell** · CORE · ve · 2h · deps: P1-T4, P0-T4
- **Vite:** `nodePolyfills({include:['buffer','process'], globals:{Buffer:true,process:true}})`. Start with `buffer` + `process` only; `crypto`/`stream` pull in crypto-browserify and often break the build. Add more only if the SDK import below fails.
- **SDK smoke import:** `src/lib/sdkSmoke.ts` imports `DynamicBondingCurveClient` from `@meteora-ag/dynamic-bonding-curve-sdk` and `CpAmm` from `@meteora-ag/cp-amm-sdk` and is referenced from `main.tsx`, so polyfill failures show up in wave 6, not at P7-T5.
- **Styling and routing:** Tailwind 3; router with the 6 routes (L477–484); `QueryProvider`.
- **Wallets:** `ConnectionProvider`/`WalletProvider` with Phantom and Solflare adapters plus Wallet Standard auto-detect (Backpack).
- **`env.ts`:** zod over `VITE_*` (L507).
- **`lib/api.ts`:** fetch with the in-memory JWT.
- **Also:** `Layout`, `queryKeys.ts` (L502), `format.ts` (base units → decimals, no floats, L504).
- **Accept:** `pnpm --filter @ibt/web build` exits 0 with the DBC and cp-amm SDK imports in the bundle (`grep -rlq 'dynamic-bonding-curve\|cpamdp' apps/web/dist/assets`); `pnpm --filter @ibt/web exec vitest run src/lib/format.test.ts` passes; `pnpm why -r @solana/web3.js | grep -o '@solana/web3.js@1\.[0-9.]*' | sort -u | wc -l` prints `1`.

**P7-T2 WalletGate + useSendTx** · CORE · ve · 2h · deps: P7-T1
- **`WalletGate`:** nonce → `signMessage` → verify; JWT in a module-level store, never `localStorage` (L490); public pages work without a wallet (L505).
- **`useSendTx`:** build → simulate → sign → send → confirm with `lastValidBlockHeight` → `onConfirmed` → invalidate the queries; error mapper for wallet rejection, slippage and blockhash expiry (L503).
- **Accept:** `pnpm --filter @ibt/web exec vitest run src/components/WalletGate.test.tsx src/hooks/useSendTx.test.ts` passes; `grep -r localStorage apps/web/src` finds nothing.

**P7-T3 Explore + CurveProgress + ModelCard** · CORE · ve · 1.5h · deps: P7-T1 · ∥ P7-T2
- **Content:** model cards (L479); `CurveProgress` polls every 10 s, showing SOL raised vs threshold.
- **Accept:** `pnpm --filter @ibt/web exec vitest run src/pages/Explore.test.tsx src/components/CurveProgress.test.tsx` passes (renders progress 42% from a fixture).

**P7-T4 Token page + ModelStats + SettlementTable** · CORE · ve · 1.5h · deps: P7-T3
- **Content:** L480, L494–495; Solscan links include `?cluster=devnet` when needed; settlements refetch every 60 s.
- **Accept:** `pnpm --filter @ibt/web exec vitest run src/components/SettlementTable.test.tsx src/components/ModelStats.test.tsx` passes (link href correct per cluster).

**P7-T5 TradePanel** · CORE · ve · 2h · deps: P7-T2, P7-T4
- **Curve:** `swapQuote2` + `swap2` (DBC). **Graduated:** `getQuote2` + `swap2` (cp-amm). Slippage selector, price impact, min received, 0.01 SOL fee note (L123, L492).
- **Accept:** `pnpm --filter @ibt/web exec vitest run src/components/TradePanel.test.tsx` passes (quote rendering for both phases with mocked SDK).

**P7-T6 Dashboard: ApiKeyManager + DepositUsdc** · CORE · ve · 2h · deps: P7-T2
- **Content:** L482, L491, L497. Deposit = USDC `transferChecked` to `VITE_TREASURY_USDC_ATA` plus a Memo instruction with `depositRef` → `POST /api/billing/deposits`; states idle → signing → pending → credited or error. A 202 `deposit_pending` keeps the `pending` state and re-posts every 5 s (up to ~2 min) until 200 or a non-retryable error (P3-T7). Also: usage table and quickstart snippet.
- **Accept:** `pnpm --filter @ibt/web exec vitest run src/components/DepositUsdc.test.tsx src/components/ApiKeyManager.test.tsx` passes (all states; 202 then 200 → credited after polling with fake timers; the key is shown once).

**P7-T7 LaunchWizard** · CORE · ve · 2h · deps: P7-T2
- **Four steps** (L481, L496): register → health check → prices → launch (generate the mint keypair, `POST /api/tokens/launch/prepare {modelId, mint}` **before** signing so the metadata URI resolves (P5-T1), `createPool` with uri `${VITE_API_URL}/metadata/${mint}.json`, partial-sign with the mint, wallet signs, then `/launch/confirm`).
- **Accept:** `pnpm --filter @ibt/web exec vitest run src/components/LaunchWizard.test.tsx` passes (validation errors on bad URL, prices and symbol; step gating; `prepare` is called before the wallet `signTransaction` mock).

**P7-T8 Provider page + ClaimFees** · CORE · ve · 1.5h · deps: P7-T2, P7-T4
- **Content:** L483, L498. Creator: `claimCreatorTradingFee` + `claimPositionFee`. Platform (treasury wallet): `claimPartnerTradingFee`. Pause/resume through `PATCH /api/models/:id {status}` (P3-T5). ClaimFees also appears owner-only on the token page.
- **Accept:** `pnpm --filter @ibt/web exec vitest run src/components/ClaimFees.test.tsx` passes (correct builder chosen per role).

**P7-T9 Docs page** · CORE · ve · 1h · deps: P7-T1
- **Content:** L484. OpenAI SDK `baseURL` swap examples (JS and Python), curl, streaming, error table.
- **Accept:** `pnpm --filter @ibt/web exec vitest run src/pages/Docs.test.tsx` passes (contains `baseURL` and `/v1/chat/completions`).

**P7-T10 Price chart** · **CUT** · ve · 1h · deps: P7-T4
- **`PriceChart`:** lightweight-charts v5 line chart from snapshots; progress bar stays as the fallback (L625).
- **Accept:** `pnpm --filter @ibt/web exec vitest run src/components/PriceChart.test.tsx` passes (mocks the canvas).

**P7-T11 Playwright** · CORE · ve · 1h · deps: P7-T3, P7-T9 · skills: `frontend-ui-ux`, `playwright`
- **Setup:** `playwright.config.ts` (webServer `vite preview`); `e2e/smoke.spec.ts` stubs every `${VITE_API_URL}/**` request with `page.route` (fixture JSON for `/api/models` etc.), since no api runs under `vite preview`, then checks that `/` and `/docs` render with no console errors; the `@staging` flow is skipped unless `STAGING_URL` is set (G29).
- **Accept:** `pnpm --filter @ibt/web e2e` passes locally.

### Phase 8: Scripts, Docker, load, CI, README

**P8-T1 `create-config.ts`** · CORE · d · 1.5h · deps: P2-T5
- **Default:** `--dry-run` prints params and the derived accounts.
- **`--send`:** requires `TREASURY_SECRET_KEY` from env **and** `I_AM_HUMAN=1` (exits 1 with a message otherwise); refuses `mainnet-beta` without `--confirm-mainnet`; writes nothing to disk; prints the config key (L574).
- **Accept:** `pnpm tsx scripts/create-config.ts --cluster devnet --dry-run` exits 0 and prints `migrationQuoteThreshold` and `creatorTradingFeePercentage: 50`; `env -u I_AM_HUMAN pnpm tsx scripts/create-config.ts --cluster devnet --send` exits 1 before reading any key. Agents never run `--send`.

**P8-T2 `seed-models.ts` + `dev-signin.ts`** · CORE · uh · 1.5h · deps: P3-T7, P5-T1
- **seed-models:** idempotent model seeding (upstream defaults to the mock); `--dev-credit <wallet> <usdc>` (G23) writes the row through `adjust` imported from `@ibt/db` (P3-T6); `--fake-token` (local only) also seeds the fake chain pool and a `FakePriceSource` SOL price so the smoke settlement slice converts to > 0 lamports (L375). Both flags refuse unless `CLUSTER` ≠ `mainnet-beta` **and** the `MONGODB_URI` host is localhost/127.0.0.1 (G23).
- **dev-signin:** ephemeral in-memory keypair; prints `{wallet, jwt}`.
- **Accept:** with the api running: `pnpm tsx --env-file=apps/api/.env scripts/dev-signin.ts` prints a JWT, then `seed-models --dev-credit` increases `GET /api/me` balance; `MONGODB_URI=mongodb://db.example.com/ibt pnpm tsx scripts/seed-models.ts --dev-credit x 1` exits 1.

**P8-T3 `refill-float.ts`** · CORE · q · 1h · deps: P2-T8
- **Behaviour:** dry-run by default; prints treasury → keeper SOL transfer and the resulting float (runbook 3, L576).
- **Accept:** `pnpm tsx scripts/refill-float.ts --dry-run --sol 1` exits 0.

**P8-T4 `devnet-e2e.ts`** · CORE · d · 2h · deps: P6-T5, P8-T1
- **Gate:** exits 0 with "skipped" unless `DEVNET_E2E=1`; refuses mainnet.
- **Flow** (L590): throwaway keypairs (memory only) → airdrop with retry → create config (1 SOL) → launch → 3 buys → settlement on the curve → buy to threshold → migration → settlement after graduation → assert the keeper position is permanently locked and fees are claimable.
- **Accept:** `pnpm tsx scripts/devnet-e2e.ts` (unset) prints `skipped`; `pnpm typecheck` passes. The live run is operator-only (H6).

**P8-T5 Dockerfile** · CORE · q · 1h · deps: P0-T7
- **Image:** multi-stage, `pnpm prune --prod` (not `deploy`; `injectWorkspacePackages` is `false` since `31dde1f`, see §13), non-root, two start commands (G7); `.dockerignore`.
- **Accept:** `docker build -t ibt . && docker run --rm -e PORT=4000 ibt node apps/api/dist/main.js --version-check` exits 0. Add a `--version-check` flag to main that prints and exits.

**P8-T6 Load test** · CORE · uh · 1.5h · deps: P4-T4, P4-T5
- **`scripts/load/gateway-load.ts`:** seeds ≥ 50 users/keys (each with dev credit) and round-robins requests across them, so no single key hits the 60/min rate limit (L423) or the 50 USDC daily cap; autocannon at 50 req/s for 60 s against the api with the mock; compares against a direct-to-mock p95 baseline; then queries Mongo for negative balances and duplicate captures (L591).
- **Env-overridable limits:** the api env schema accepts `RATE_LIMIT_PER_MIN` and `DAILY_CAP_USDC` (defaults: the shared constants, G26) and the P4-T5 middleware reads them; the load profile (`pnpm load`) starts the api with both raised (e.g. `RATE_LIMIT_PER_MIN=100000 DAILY_CAP_USDC=1000000`).
- **Accept:** `pnpm load` exits 0 with overhead p95 < 50 ms, 0 non-2xx responses, 0 negative balances and 0 duplicate captures; `pnpm --filter @ibt/api exec vitest run test/limits.int.test.ts` still passes (defaults unchanged).

**P8-T7 CI finalize** · CORE · q · 1h · deps: P8-T4, P7-T11
- **Adds:** Playwright install and run, docker build job, nightly e2e wiring.
- **Accept:** workflow validates (P0-T6 command); local `act` run is optional.

**P8-T8 README** · CORE · writing · 1.5h · deps: P8-T1..T6
- **Sections:** what it is; ASCII architecture (G1); Meteora usage table (DBC config, createPool, swap2, migrateToDammV2, DAMM v2 add/lock/claim); run instructions; env table; runbooks; address table placeholders (L632–633).
- **Accept:** `grep -c "migrateToDammV2\|permanentLockPosition\|create-config" README.md` ≥ 3.

### Phase 9: Verification

**P9-T1 `smoke-local.ts`** · CORE · d · 1.5h · deps: P8-T2, P6-T5
- **Automates §9 local happy path** and exits non-zero on any mismatch. Loads env explicitly (`tsx --env-file`), seeds through P8-T2, then runs the live gateway curl moved here from P4-T4.
- **Accept:** `pnpm smoke:local` prints `SMOKE OK`; with mongo, mock and api running and seeded as in §9, `curl -si http://localhost:4000/v1/chat/completions -H 'Content-Type: application/json' -H "Authorization: Bearer $KEY" -d '{"model":"mock-llm","messages":[{"role":"user","content":"Hello"}],"max_tokens":64}'` returns 200 with `X-Cost-Usdc`, and `curl -s http://localhost:4000/api/billing/ledger -H "Authorization: Bearer $JWT"` shows the hold and capture rows.

**P9-T2 Acceptance checklist pass** · CORE · d · 1.5h · deps: P9-T1, P5-T5, P6-T6
- **Maps each line L596–602** to an automated test id or an H-task.
- **Adds tests:** "OpenAI SDK with only baseURL/apiKey changed" (`apps/api/test/acceptance.int.test.ts`, uses the `openai` npm package against the api with the mock); "kill keeper mid-settlement" (`apps/keeper/test/acceptance.test.ts`: child process runs `settle:once` with `FakeChainClient` persisting to the test Mongo, gets SIGKILL mid-run, a second process resumes; asserts from the `fakeChainTxs` collection exactly one provider transfer and one buy per settlement); "alerts on forced failure and low float" (same keeper file).
- **Accept:** `pnpm --filter @ibt/api exec vitest run test/acceptance.int.test.ts && pnpm --filter @ibt/keeper exec vitest run test/acceptance.test.ts` passes.

**P9-T3 Slop + consistency review** · CORE · uh · 2h · deps: P9-T2 · skills: `review-work`, `ai-slop-remover`
- **Checks:** spec line references, error codes, env names identical across `.env.example`, README and code (`pnpm tsx scripts/check-env-consistency.ts`, written inline in the test as `scripts/test/env-consistency.test.ts`).
- **Accept:** `pnpm --filter ./scripts exec vitest run test/env-consistency.test.ts` passes; reviewer report has 0 blockers.

**P9-T4 Clean-clone DoD** · CORE · q · 1h · deps: P9-T3 (CORE tasks only; Wave C cut tasks run after this and are optional)
- **Accept:** §9 sequence in a fresh `git clone` into `$TMPDIR` passes. If any Wave C task lands later, re-run this accept after it.

### Task Dependency Graph (phase level; per-task deps are listed above)

| Block | Depends on | Reason |
|---|---|---|
| P0 | — | Root |
| P1 | P0-T7 | Needs workspace and tooling |
| P2 | P0-T7 (P2-T1); P1 for T8 | SDKs install independently; client uses shared errors |
| P3 | P1, P2-T8 | Models need schemas; app needs ChainClient |
| P4 | P3 | Gateway needs auth and ledger |
| P5 | P3, P2-T8 | Chain verification |
| P6 | P3-T1, P3-T6, P2-T8, P1-T3 | db (models + ledger service), chain, split |
| P7 | P1-T4 (+ api contract) | Can mock the api |
| P8 | P2, P4, P6, P7 | Scripts and CI wrap everything |
| P9 | all CORE (Wave C cut tasks run after P9-T4, optional) | Verification |

### Parallel Execution Graph

```
Wave 1: P0-T1
Wave 2: P0-T2, P0-T3, P0-T4, P0-T5
Wave 3: P0-T6 → P0-T7
Wave 4: P1-T1, P2-T1, P4-T1
Wave 5: P1-T2, P1-T3, P1-T4, P1-T5, P2-T2, P2-T4, P2-T5
Wave 6: P1-T6, P2-T3, P3-T1, P4-T2, P7-T1, P8-T5
Wave 7: P2-T6, P2-T7, P3-T6, P7-T2, P7-T3, P7-T9
Wave 8: P2-T8, P7-T4, P7-T6, P7-T7
Wave 9: P3-T2, P8-T1, P8-T3, P7-T5, P7-T8, P7-T11
Wave 10: P3-T3 → (P3-T4 ∥ P3-T5), P6-T1
Wave 11: P3-T7, P4-T3, P5-T1, P5-T3, P6-T2, P6-T3
Wave 12: P4-T4, P5-T2, P5-T4, P6-T4
Wave 13: P4-T5, P5-T5, P6-T5
Wave 14: P6-T6, P6-T7, P6-T8, P8-T2, P8-T4, P8-T6
Wave 15: P8-T7, P8-T8, P9-T1
Wave 16: P9-T2 → P9-T3 → P9-T4
Wave C (cut list, OPTIONAL, only after P9-T4 passes): P4-T6, P4-T7, P4-T8, P6-T9, P7-T10
Critical path: P0-T1→T3→T7→P2-T1→T2→T3→T6→T8→P3-T2→T3→T4→P3-T7 (∥ P5-T1)→P8-T2→P9-T1→T2→T3→T4. The settlement chain P3-T6→P6-T3→T4→T5 joins at P9-T1 and does not go through P4.
```

Totals: **73 tasks**, about **110 agent-hours** (chain and settlement `ub` tasks may run 1.5–2× their estimate) plus **15–20 human hours** (reviewing ~73 commits and running H0–H13). With 4–6 parallel agents the agent work is roughly 30–35 wall-clock hours.

### Skills evaluation (applies to all tasks)

- **Included:**
  - `git-master` on every task (atomic commit);
  - `frontend-ui-ux` on all P7 tasks;
  - `playwright` on P7-T11;
  - `review-work` and `ai-slop-remover` on P9-T3.
- **Omitted:** `dev-browser`, docs/docx/pdf/pptx/xlsx/google-workspace/canvas-design/morning/import-memory/skill-creator/mcp-builder/learn/deep-research/browser/computer-use variants. None of them fit a TypeScript code build, and the deep-research skill isn't needed because the spec is authoritative.

## 7. Human-only / operator tasks (never assigned to agents)

All `--send` commands below run with `I_AM_HUMAN=1` in the operator's shell only (P8-T1).

| ID | Task | Spec ref | By |
|---|---|---|---|
| H0 | **Devnet chain smoke** (required for the G-Chain gate): `I_AM_HUMAN=1 create-config.ts --cluster devnet --send`; launch one token on that config (`createPool`); do one swap on the curve. Record the signatures; any SDK drift found here goes back to P2-T5..T7 as a fix task | L610 | **Oct 4** |
| H1 | Create the treasury and keeper wallets (hardware or secret store); never commit them | L515 | Oct 3 |
| H2 | Helius devnet and mainnet keys; set `RPC_URL`/`RPC_URL_FALLBACK`; obtain `JUPITER_API_KEY` if Jupiter's price API requires one (G26) | L554 | Oct 3 |
| H3 | Atlas M0 (staging) and M10 with backups (prod); IP rules | L545 | Oct 3 |
| H4 | Fund the devnet treasury; **create the treasury USDC ATA** (devnet USDC mint) and record it as `TREASURY_USDC_ATA`/`VITE_TREASURY_USDC_ATA`; run `create-config.ts --cluster devnet --send` (may reuse the H0 config); paste the key into all three apps' env (runbook 1). Repeat the USDC ATA step for mainnet inside H8 | L574 | Oct 4 |
| H5 | Railway (api + keeper, keeper 1 replica), Vercel (web), env secrets | L544–547 | Oct 8 |
| H6 | Run `DEVNET_E2E=1 scripts/devnet-e2e.ts` twice in a row; devnet migration drill (runbook 6) | L579, L596 | **Oct 8–9** |
| H7 | Telegram bot and chat id; force a settlement failure and a low float to confirm alerts | L602 | Oct 9 |
| H8 | Mainnet: **only after H6, H7 and H9 all pass** (L594). Fund the treasury, create the mainnet treasury USDC ATA, `create-config --cluster mainnet-beta --send --confirm-mainnet`, refill the float (runbook 3) | L574–576, L594 | **Oct 10** |
| H9 | Record one real devnet deposit and commit it as a parser fixture; wrong-memo deposit check | L598 | Oct 9 |
| H10 | Before launching, check that the deployed web's `VITE_API_URL` is the production api domain (the metadata URI baked into the mint is immutable). First mainnet model launch with the treasury as provider; buy 0.1 SOL (runbook 2); real OpenAI SDK call | L575, L597 | **Oct 10** |
| H11 | Provider claims creator and position fees from the dashboard; confirm settlement links | L600–601 | Oct 11 |
| H12 | Fill the README address table; 3-minute demo video; live URL; add `dannxbt` if the repo is private; submit on Superteam Earn and Colosseum before **2026-10-13 06:59 UTC** | L629–636 | **Oct 12** (video + submission only) |
| H13 | Legal framing review of copy | L535 | Oct 11 |

Human time budget: ~15–20 h across H0–H13 plus commit review.

## 8. Test matrix

| Spec level (L585–592) | Tests created by |
|---|---|
| Unit: pricing, split remainder | P1-T2, P1-T3 |
| Unit: hold/capture/release | P3-T6 |
| Unit: deposit parser | P2-T4 (+ H9 real fixture) |
| Unit: config snapshot | P2-T5 |
| Integration: happy path, 402, upstream 500, timeout, revoked key | P4-T4, P3-T4 |
| Integration: streaming `[DONE]` | P4-T6 |
| Integration: idempotency replay | P4-T7 |
| Integration: discount | P4-T8 |
| Settlement: all items | P6-T3..T6 |
| Chain e2e | P8-T4 (operator run H6) |
| Load: `pnpm load` at 50 req/s for 60 s; p95 overhead < 50 ms, 0 negative balances, 0 duplicate captures | P8-T6 |
| Frontend: TradePanel, DepositUsdc, LaunchWizard | P7-T5, P7-T6, P7-T7 |
| Frontend: Playwright smoke | P7-T11 (staging: H-run) |
| Acceptance L594–602 | P9-T2 + H6/H9–H11/H7 |

## 9. Definition of done

```bash
git clone <repo> ibt && cd ibt && corepack enable
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build
docker build -t ibt .
docker compose up -d mongo
cp apps/api/.env.example apps/api/.env && cp apps/keeper/.env.example apps/keeper/.env   # localhost MONGODB_URI, CLUSTER=devnet; then made local-ready by the sed line
K=11111111111111111111111111111111; sed -i.bak -e 's/^CHAIN_MODE=real/CHAIN_MODE=fake/' -e "s|^DBC_CONFIG=.*|DBC_CONFIG=$K|" -e "s|^TREASURY_WALLET=.*|TREASURY_WALLET=$K|" -e "s|^KEEPER_WALLET=.*|KEEPER_WALLET=$K|" -e "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 32)|" -e "s|^MASTER_KEY=.*|MASTER_KEY=$(openssl rand -base64 32)|" -e "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$(openssl rand -base64 32)|" apps/api/.env
pnpm --filter @ibt/mock-upstream start &                      # :4010
(cd apps/api && node --env-file=.env dist/main.js) &          # :4000; nothing loads .env implicitly
eval "$(pnpm --silent exec tsx --env-file=apps/api/.env scripts/dev-signin.ts --export)"   # ephemeral nacl keypair → WALLET, JWT
pnpm tsx --env-file=apps/api/.env scripts/seed-models.ts --owner $WALLET --fake-token --dev-credit $WALLET 10   # also seeds fake SOL price
KEY=$(curl -s -XPOST http://localhost:4000/api/keys -H 'Content-Type: application/json' -H "Authorization: Bearer $JWT" -d '{"name":"dev"}' | jq -r .key)
curl -si http://localhost:4000/v1/chat/completions -H 'Content-Type: application/json' -H "Authorization: Bearer $KEY" \
  -d '{"model":"mock-llm","messages":[{"role":"user","content":"Hello"}],"max_tokens":64}'
#   → 200, X-Cost-Usdc, X-Balance-Usdc < 10.000000
curl -s "http://localhost:4000/api/billing/ledger" -H "Authorization: Bearer $JWT"   # hold(captured) + capture rows
pnpm --filter @ibt/keeper settle:once --chain fake --period-start "$(date -u +%Y-%m-%dT%H:00:00Z)"   # tsx --env-file=.env (P6-T1); no `--` before the flags (see §13 wave 15)
#   → state "done", provider carry-over (<1 USDC), liquidity buy signature from the fake chain (slice > 0 thanks to seeded price)
pnpm --filter @ibt/web build
kill %1 %2          # stop mock and api so smoke:local can start its own on the same ports
pnpm smoke:local    # automates all of the above → "SMOKE OK"
```

## 10. Risk register

| Risk | Mitigation | Task |
|---|---|---|
| Meteora SDK API drift (already found 4 differences) | Exact pins, surface test, wrappers isolate the SDK | P2-T1, P2-T6, P2-T7 |
| web3.js 1.x vs 2.x conflicts | `^1.99.0` override, single copy; check with `pnpm why @solana/web3.js` | P0-T1, P2-T1 |
| Vite polyfills for `Buffer`/`process` | `vite-plugin-node-polyfills` with `buffer` + `process` only; DBC and cp-amm SDK import in the P7-T1 build accept | P7-T1 |
| Keeper crash after a tx lands but before its signature is stored (double pay) | `onSigned` persists the signature before send; resume checks `getSignatureStatuses` | P2-T3, P6-T3..T6 |
| `development` condition ignored by TS / two mongoose copies / pnpm 10+ config moves | G10 typecheck note, G11 single mongoose in `@ibt/db`, `pnpm-workspace.yaml` overrides + `onlyBuiltDependencies` + `injectWorkspacePackages` | P0-T1, P0-T3, P3-T1 |
| First real DBC/DAMM tx happens late with no fallback | H0 devnet chain smoke by Oct 4 | H0 |
| DBC SDK is CJS under ESM | Dynamic import check in the surface test | P2-T1 |
| mongodb-memory-server binary download on macOS/CI | Pin `MONGOMS_VERSION`, cache binaries in CI, Docker fallback | P0-T3, P0-T6 |
| Transactions need a replica set | `--replSet rs0` + MongoMemoryReplSet | P0-T5, P3-T1 |
| undici streaming back-pressure and aborts | `stream.pipeline`, abort on `req.close`, tests | P4-T6 |
| BigInt and base-unit strings | BigInt math in shared, string storage, property tests | P1-T2, P1-T3 |
| tiktoken WASM in Node and memory use | Singleton encoder, leak test | P4-T2 |
| undici 8 / jsdom 30 need Node 22 | Pinned 7.x / 25.x | §4 |
| Health-check vs L190 contradiction | G12 | P5-T3, P6-T7 |
| Devnet faucet unreliability | `DEVNET_E2E` gate, airdrop retry, operator run | P8-T4 |
| Oct 13 deadline (~110 agent-hours + 15–20 human hours vs 11 days) | Gates, cut-list wave optional after P9-T4, parallel waves, mainnet by Oct 10, cut order in §11 | §6, §7, §11 |

## 11. Scope markers

- **CUT (5, Wave C, optional, after P9-T4):** P4-T6, P4-T7, P4-T8, P6-T9, P7-T10.
- **CORE:** all 68 other tasks.

**Cut order if over budget** (apply top to bottom):
1. The spec's own cut list: P4-T6, P4-T7, P4-T8, P6-T9, P7-T10.
2. P7-T11 Playwright.
3. P8-T6 load test (run once by hand).
4. P9-T3 review.
5. P5-T5 5xx-rate counter.
6. P6-T8 signature re-check (keep the ledger recompute).
7. P8-T7.
8. P7-T9 becomes a static page.

**Never cut:** P2-T3, P3-T6, P6-T3–T6, P2-T4, P4-T5 caps.
- **Post-MVP:** none built. The spec defers vesting classes, burn-to-credit, Jupiter refill job, indexer and DLMM (L672–678); they are listed as assumptions only.

## Commit strategy

- **One task = one commit** (`git-master`), Conventional Commits with the task id: `feat(chain): sendAndConfirm with blockhash resend [P2-T3]`.
- **TDD:** the test commit may be squashed into the feature commit, but the test must fail before the implementation exists.
- **Before every commit:** `pnpm lint && pnpm typecheck && pnpm --filter <pkg> test`.
- **Lockfile:** changes only in the task that adds the dependency.
- **Gates:** after each gate passes, tag it with `git tag gate-<name>`.

## TODO list

> Caller: add these and run them wave by wave. Details and QA commands for each id are in §6.

- **Wave 1–3:**
  - P0-T1 (q, none → T2–T6)
  - P0-T2, P0-T3, P0-T4, P0-T5 (q)
  - P0-T6 (q)
  - P0-T7 (q, gate)
- **Wave 4–5:**
  - P1-T1 (q)
  - P2-T1 (d)
  - P4-T1 (q)
  - P1-T2, P1-T3 (d)
  - P1-T4 (uh)
  - P1-T5 (q)
  - P2-T2 (uh)
  - P2-T4 (ub)
  - P2-T5 (d)
- **Wave 6–8:**
  - P1-T6, P3-T1 (uh)
  - P2-T3, P2-T6, P2-T7 (ub)
  - P4-T2 (q)
  - P7-T1 (ve)
  - P8-T5 (q)
  - P3-T6 (ub)
  - P7-T2, P7-T3, P7-T9 (ve)
  - P2-T8 (d)
  - P7-T4, P7-T6, P7-T7 (ve)
- **Wave 9–11:**
  - P3-T2 (uh)
  - P8-T1 (d)
  - P8-T3 (q)
  - P7-T5, P7-T8 (ve)
  - P7-T11 (ve + playwright)
  - P3-T3, P3-T4, P3-T5, P6-T1 (uh)
  - P3-T7 (uh)
  - P4-T3 (uh)
  - P5-T1 (d)
  - P5-T3 (uh)
  - P6-T2 (d)
  - P6-T3 (ub)
- **Wave 12–15:**
  - P4-T4 (ub)
  - P5-T2, P5-T4 (uh)
  - P6-T4 (ub)
  - P4-T5 (uh)
  - P5-T5 (q)
  - P6-T5 (ub)
  - P6-T6 (ub)
  - P6-T7, P6-T8, P8-T2 (uh)
  - P8-T6 (uh, after P4-T5)
  - P8-T4 (d)
  - P8-T7 (q)
  - P8-T8 (writing)
  - P9-T1 (d)
- **Wave 16:**
  - P9-T2 (d)
  - P9-T3 (uh + review-work, ai-slop-remover)
  - P9-T4 (q, CORE deps only)
- **Wave C (optional, only after P9-T4 passes; skip per the §11 cut order if over budget):**
  - P4-T6 (ub)
  - P4-T7, P4-T8 (uh)
  - P6-T9 (q)
  - P7-T10 (ve)
- **Human gates (not agent tasks, §7):** H0 must pass before tagging `gate-chain` (Oct 4); H6 Oct 8–9; H8/H10 by Oct 10, H8 only after H6 + H7 + H9.

**Execution:** fire each wave's tasks in parallel with `task(category=<cat>, load_skills=[git-master,(+frontend-ui-ux for P7)], prompt="<task id block from §6>")`, then run every QA command before the next wave.

## 12. Review log

Oracle review 1 (2026-10-01): APPROVE WITH FIXES. All items applied; see review-oracle-1.md.

## 13. Execution log (deviations discovered while building)

- **pnpm 12.6.0** no longer reads `onlyBuiltDependencies`; it hard-fails installs with `ERR_PNPM_IGNORED_BUILDS` and expects `allowBuilds: { esbuild: true, ... }` in `pnpm-workspace.yaml`. P0-T1's `grep onlyBuiltDependencies` accept is obsolete; `allowBuilds` is the key. `overrides` also gained `vite: ~5.4.21` so vitest 3.2 resolves the same Vite 5 as `apps/web`.
- **TypeScript layout (G10):** every package has a composite `tsconfig.json` (src only, emits `dist`) plus a non-composite `noEmit` `tsconfig.test.json` (src + test + vitest config). Root `tsconfig.json` references both, so `pnpm typecheck` (`tsc -b`) type-checks tests too. `tsBuildInfoFile` lives in `dist/` so `rm -rf dist` is a true fresh-clone simulation (TS 5.6+ otherwise leaves `*.tsbuildinfo` beside the tsconfig and skips emit). Web and scripts put theirs in `node_modules/.cache/`.
- **G10 confirmed:** `injectWorkspacePackages: true` still symlinks workspace packages (pnpm dedupes injected deps), and vitest's `development` condition resolves `@ibt/shared` to `packages/shared/src/index.ts` (asserted by `packages/chain/test/smoke.test.ts` via `SHARED_SOURCE_URL`). `@ibt/shared` compiles with `types: []`, so it declares `ImportMeta.url` itself in `src/import-meta.d.ts`.
- **mongodb-memory-server** reads `config.mongodbMemoryServer.version = 7.0.14` from the root `package.json` and downloads to `node_modules/.cache/mongodb-memory-server` (not `~/.cache/mongodb-binaries`); CI caches that path. `test/setup.ts` in `@ibt/db` also pins the version and `provide()`s `mongoUri`.
- **Git:** the operator's global config signs commits with a passphrase-protected SSH key that is not in the agent. `commit.gpgsign=false` and `tag.gpgsign=false` are set in this repo's local config only (`git config --local`), so agent commits are unsigned. Re-sign later with `git rebase --exec 'git commit --amend --no-edit -S'` if desired.
- **Wave discipline:** dependencies for a wave are installed by the orchestrator in one commit before agents start; agents never run `pnpm add`/`install` and stage only their own package path, so parallel agents never collide on the lockfile.
- P0-T4 accept: `kill %1` only works in an interactive shell; non-interactive runners must use `kill $!` (or `lsof -ti :4000 | xargs kill`).
- **Wave 6–8a (P1-T6, P2-T3/T6/T7/T8, P3-T1/T6, P4-T2, P7-T1, P8-T5) landed; root gate green (298 tests).** Deviations:
  - **DBC 1.5.13 drift (adds to §4):** `VirtualPool` is `{ poolState: {...} }`, so fields read as `pool.poolState.*`; a BN is built with `convertToLamports(x.toString(), 0)` (exported as `toBN`/`BNValue` from `sdk.ts`; `bn.js`/anchor are not resolvable from `packages/chain`); cp-amm builders already wrap/unwrap WSOL; cp-amm `SwapMode`/`getCurrentPoint` re-exported as `DammSwapMode`/`getDammCurrentPoint`; cp-amm `getQuote2` slippage is in percent (`bps/100`).
  - **`ChainClient` sends** take `{onSigned(sig, lastValidBlockHeight, step), settlementRef?}`; `addAndLock` sends two txs (`addLiquidity`, `lock`); `migrate`/position creation build once and re-sign on retry; `readPool` takes `{pool} | {mint, config}`; `sendAndConfirm` uses `skipPreflight`, `maxRetries: 0`, simulation failure throws immediately, landed-with-error counts as a failed attempt. Fake chain: `crashAfter(method)` = signed but never landed; `crashAfterLand`; `migrateWhen(lamports)`; `setSol/setUsdc/setBalance/setParsedTx/landedTxs`. Fixture loader moved to `src/testing/fixtures.ts`. `sdk.ts` constants now come from `@ibt/shared`.
  - **`@ibt/db`:** `connectDb` sets `useBigInt64: true` (lean reads and aggregations return `bigint`). Nested groups are required single-nested subschemas (non-nullable). Added unique `leases.name`, `ledger.reason`, `deposits.reason`, `token.symbol`, `provider.carryOverMicroUsdc`; `models.stats` uses `requests` and `lockedLiquidityLamports` (BigInt). `ledger.ref.holdId/settlementId` are ObjectIds. Hold row stores `−estimate`, release `+estimate`; expiry writes a `release` row with `status:'expired'` on the hold; `credit` with `settlementId` writes `adjust` + `reason:'settlement'`; `release(holdId, request?)` can log a failed request; `credit`/`adjust` accept `{session}`. Exports: `Users, ApiKeys, Models, Requests, Ledger, Deposits, Settlements, PoolSnapshots, Nonces, Idempotency, Leases`, `withTransaction`, `syncAllIndexes`, `ALL_MODELS`, ledger fns.
  - **`@ibt/shared/node`:** `createLogger({level,name,redact?}, dest?)`, `REDACT_PATHS`, `encrypt/decrypt(text, masterKey)`, `generateApiKey`, `sha256Hex`, `keyPrefix`, `generateDepositRef`, `createLogAlerter(logger)`, `parseEnv(schema, source?)` (reports keys only). ESLint bans `@ibt/shared/node`, `@ibt/db`, `@ibt/chain/testing` under `apps/web/**`.
  - **Web:** route is `/t/:slug` (spec says `/models/:slug`); `*` → `NotFoundPage`; Router v7 future flags; `env.ts` parses at module load (vitest `test.env` supplies the six `VITE_*`); wallet adapters Phantom + Solflare only; `App.tsx` deletion landed in commit `e085295` (another agent's) because `git rm --cached` staged it in the shared index. `format.ts`: `formatPct` takes a ratio, `formatSol` 4 dp, `formatUsdc` 6 dp, grouping on the whole part.
  - **Dockerfile:** deps stage adds `python3 make g++` (bufferutil/utf-8-validate need node-gyp on arm64); runtime stage is clean slim; `pnpm prune --prod` not `deploy`; each workspace `package.json` is copied by explicit path (new package → new line).
- **Wave 9a (P3-T2..T5, P6-T1..T3, P8-T1/T3, P7-T2/T3/T4/T6/T7/T9) landed; root gate green (429 tests: mock-upstream 17, shared 104, chain 86, web 107, db 47, api 49, keeper 19).** Deviations:
  - **api:** opaque cursor helper is `apps/api/src/pagination.ts` (base64url of `_id`, sorted desc, `limit+1` probe); `apiKeyAuth` attaches `ApiKeyContext` only (never `AuthUser`, so key-auth requests cannot pass `requireAuthUser`); `lastUsedAt` write throttled to once per 60 s; `apps/api/src/modules/gateway/router.ts` already mounts a minimal `/v1/models` behind `apiKeyAuth` (P4-T3 extends it, does not re-create it). Model stats mapped from `stats.{requests, successRate, revenueMicroUsdc, lockedLiquidityLamports}`.
  - **keeper:** `runSteps` runs `tagAndSum → split → payProvider`, each guarded by `lastCompletedState`; no retry/`failed` handling yet (P6-T5). `pendingTx.step` is stored as `payProvider:payout` (step + chain step). Pool poller writes `totalTradingQuoteFee:'0'` and does not update `models.stats` (P6-T7 must). Graduation is confirmed with `readDammPool(mint)`. **Known defect to fix in P6-T4:** on resume with a stored `pendingTx`, `tagAndSum`/`split` re-run and can re-tag requests that arrived after the crash, so the recorded amount can differ from the transfer that landed (no double spend). Fix: skip both steps whenever `pendingTx` is set.
  - **scripts:** five commits (two `feat`, three `fix`). `create-config` takes the cluster from `--cluster` or `CLUSTER` (disagreement → exit 2, none → exit 2); dry-run prints a base64 unsigned tx (real blockhash + genesis check when `RPC_URL`/`--rpc-url` is set, placeholder blockhash offline; 661 bytes on devnet); exits 0 ok / 1 gate refused (`I_AM_HUMAN`, `--confirm-mainnet`, unset `TREASURY_SECRET_KEY`) / 2 error; `--send` no longer prints the config keypair secret. `TREASURY_SECRET_KEY` accepts base58 or a JSON byte array (matches keeper). `refill-float` defaults to devnet and reports `FLOAT_MIN_SOL` breach now and after the refill.
  - **web:** `useSendTx` failure state is named `failed` (`e9aabf2`); `ModelCard` shows `$SYMBOL` beside the slug (follow-up `fix(web)` commit).
  - **db tests:** `packages/db/test/db-uri.ts` gives each test file its own database on the shared replica set. Previously all three files shared `ibt_test` and `ledger.test.ts`'s `beforeEach` wipe raced `indexes.test.ts` in a parallel worker (flaky `DocumentNotFoundError` right after `Users.create`). api/keeper helpers already did this.
  - **Orchestration:** the first wave-9a agent batch reported "Claude Max rate limit reached" and their sessions vanished, but their processes kept running and committed everything. The relaunched agents found the commits already present and stopped (scripts agent added fixes). Before relaunching a "dead" agent, check `git log` and recent mtimes under its package.
- **Wave 9b (P3-T7, P4-T3, P5-T1, P5-T3, P6-T3 fix, P6-T4, P7-T5, P7-T8, P7-T11) landed; root gate green (481 tests: mock-upstream 17, shared 104, chain 86, web 120, db 47, keeper 29, api 78; Playwright 2 passed, 1 `@staging` skipped).** Deviations:
  - **Workspace linking (`31dde1f`):** `injectWorkspacePackages` is now `false`. With `true`, pnpm injected copies of `@ibt/chain` into api and `@ibt/db` into keeper (their peer sets differ), so agents saw stale sources, `@ibt/chain`'s `test/fixtures` were missing from the copy, and a second `@ibt/shared` instance made `instanceof AppError` fail in the api error handler. Three workarounds landed before the fix and are harmless: api matches `pool_mismatch` by shape (`launch/service.ts`), api builds deposit fixtures in `apps/api/test/depositTx.ts`, keeper writes `token.keeperPositionNftAccount` with `strict: false` and reads it through a widened type. Each can be simplified later; none must be.
  - **api P3-T7:** deposits call `chain.verifyDeposit`; "confirmed but not finalized" = no finalized tx plus `signatureStatus === 'landed'` → 202 `deposit_pending`. An unknown signature stores a `rejected` row that is deleted inside the credit transaction if the same signature later verifies. Deposit rate limit 10/min per user. Usage counts every request status (failed cost 0); date-only `to` includes the whole UTC day; default range last 30 days. `src/lib/publicKey.ts` builds `PublicKey`s via the class `@ibt/chain` exposes (api has no direct `@solana/web3.js` dep). `makeTestApp` accepts `logger`.
  - **api P4-T3:** valid `POST /v1/chat/completions` returns 501 `not_implemented` until P4-T4. `validateChatRequest` and `resolveModel` (lean `ModelRow` with upstream) are exported for P4-T4.
  - **api P5-T1:** router-level 409 `token_already_launched` (not in the shared catalog) for re-prepare of a launched model, confirm with a different mint, or a mint used by another model. Unprepared mint → 422 `pool_mismatch` "mint was not prepared for this model". Launch acceptance split: pending state checked in `launch.int.test.ts`, "prepare then metadata 200" in `metadata.int.test.ts`.
  - **api P5-T3:** `external_url` is `${WEB_ORIGIN}/t/<slug>`; symbol falls back to slug-derived (≤10 chars A–Z0–9), image to `""`; `/metadata/<mint>` and `/metadata/<mint>.json` both work. `runHealthCheck(ctx, model)` exported for P5-T4; `p50LatencyMs` = median of last 21 successes in process memory; success never auto-resumes a paused model; errors never include the key or URL; tests run a local `node:http` upstream.
  - **keeper P6-T3 fix (`922233f`):** `tagAndSum`/`split` return early when payout is done or a `pendingTx` is stored (test covers `crashAfter` and `crashAfterLand`).
  - **keeper P6-T4 (`5141a5f`):** `SETTLEMENT_STEPS = PROVIDER_STEPS + LIQUIDITY_STEPS` (`convert`, `buyAndLock`); steps1 tests run `PROVIDER_STEPS`. Compound lamports are spent before the USDC slice; the cap applies to the total; USDC excess → `sliceCarryOverMicroUsdc`, compound excess stays in `pendingCompoundLamports`; capped USDC spend rounds up. Dust ends `done` with `liquidity.phase:'none'`. One add+lock per run: existing escrow is paired first with no swap; otherwise half the lamports are swapped on DAMM v2 then added; unspent lamports (also unspent curve room) go to `pendingCompoundLamports`. `liquidity.solAddedLamports` holds the planned curve spend before send, then the lamports added. A buy that completes the curve migrates in the same run; `liquidity.migrationSignature` is set only when the settlement sent it. `pendingTx.ts` gained `pendingTxOutcome` and a `chainSteps` filter. New db field `token.keeperPositionNftAccount` (needed to reuse a DAMM position). Known limits: add landed without lock → step throws every retry (manual lock; no lock-only chain call); lock landed with lost result → tokens recovered from balance, lamports assumed fully used, position keys lost if that run created the position. **For P6-T5:** append `compound` and `finalize`; retry `PendingTxUnresolvedError`, send "landed without its lock" straight to `failed` with an alert; `compound` must `$inc pendingCompoundLamports`; `settle-once` output lacks liquidity fields.
  - **web P7-T5 (`3c7ae00`):** curve price impact is computed from the sqrt-price move (DBC `swapQuote2` returns none); cp-amm slippage passed in percent; build step re-quotes before signing; quotes show without a wallet, submit disabled with a hint.
  - **web P7-T8 (`40a28db`):** no owner-list endpoint, so `useProviderModels` pages `GET /api/models?limit=100` and filters by `providerWallet` (paused listed, delisted not). Platform role detected by reading `feeClaimer` from the pool config on chain (no treasury-wallet env). Platform claim builds only `claimPartnerTradingFee` (spec L125 also wants `claimPositionFee` on the locked position: follow-up). Claimable amounts are not shown. `ClaimFees` on the token page renders only for the provider.
  - **web P7-T11 (`c841c45`):** `apps/web/tsconfig.json` includes `playwright.config.ts` and `e2e`; e2e build goes to `dist/e2e`, preview on `127.0.0.1:4173`; one `page.route('**/*')` stubs `http://api.test` from `src/fixtures`, serves empty CSS for Google Fonts and 404s anything else (fails the test). `@staging` test skipped unless `STAGING_URL`.
- **Wave 12–14 (P4-T4, P4-T5, P5-T2, P5-T4, P5-T5, P6-T5..T8, P8-T2, P8-T4, P8-T7, P8-T8) landed; root gate green (567 tests: mock-upstream 17, shared 104, chain 90, web 120, db 47, keeper 69, api 120; Playwright 2 passed, 1 skipped).** Commits: c31d870 P4-T4, e9c579d P4-T5, 08cd5b8 P5-T2, 7f30c4a P5-T4, e7e2896 P5-T5, 83d34da P6-T5, 347b4be P6-T6, ee7eae0 P6-T7 (337577f), 65a92ec P6-T8, 4cfff0d P8-T2, ee7eae0 P8-T4, 5ba5c73 P8-T7, 4c616d9 P8-T8. Deviations:
  - **api P4-T4:** `src/lib/upstream.ts` shared by gateway and health check. Cost is capped at the hold estimate (G14 no-overdraft) with a warning if upstream reports more prompt tokens than tiktoken counted. Extra native first-byte timer beside undici `headersTimeout` (undici's coarse timer does not fire at 100 ms). `stream: true` → 400 `invalid_request`; `stream_options` never forwarded. Reused `X-Request-Id` → 400 (`requests.requestId` unique). Free models still hold 1 micro-USDC. Request docs use `status: 'success'` (db enum), field `apiKeyId`, plus `modelId`, `userId`, `costMicroUsdc`, token counts, `settlementId: null`. Old 501 test now expects 402.
  - **api P4-T5:** rate limit keyed by `apiKeyId` (no `keyHash` in `ApiKeyContext`), applies to all `/v1/*` after auth. Daily cap rejects when today's spend ≥ cap (last request can slightly exceed); query uses `{userId, createdAt}` index then filters `apiKeyId`; 429 body includes `dailyCapUsdc`. `RATE_LIMIT_PER_MIN`/`DAILY_CAP_USDC` already existed in env schema; `DAILY_CAP_USDC` sets the default cap of new keys.
  - **api P5-T2:** `GET /api/tokens/:mint/state` → `{phase, progress, quoteReserveSol, priceSolPerToken, dbcPool, dammV2Pool, lockedLiquiditySol, stats:{requests24h, successRate, revenueUsdc24h, lockedLiquiditySol}}` from latest `poolSnapshots` (no snapshot → progress 0/1, `"0"` reserve and price; pending/no token → phase `none`). `GET /api/tokens/:mint/quote?side=&amount=` → `{side, phase, amountIn, amountOut, fee, priceImpactPct}` (404 without pool). `GET /api/tokens/:mint/settlements?cursor=&limit=` → `{items, nextCursor}` newest first, `error` never exposed. **Chain additive:** `ChainClient.quoteCurve(pool, {side, amount})` and `quoteDamm(mint, {side, amount})` → `{amountIn, amountOut, fee, priceImpactPct}`; helpers `quoteCurveSwap` (dbc.ts) and `quoteSwapDetailed` (damm.ts); fake quotes at fixed rate, curve buys capped at remaining room; `packages/chain/test/quote.test.ts`.
  - **api P5-T4:** `adminAuth` = bearer `ADMIN_TOKEN` (hash-then-`timingSafeEqual`) + `ADMIN_IP_ALLOWLIST` via `req.ip` (empty allows all). `POST /api/admin/settlements/:id/retry`: `failed` → `state = lastCompletedState ?? 'computing'`, `attempts: 0`, `error: null`, `pendingTx` untouched; else 409 `settlement_not_retryable`. `POST /api/admin/models/:id/pause`: delisted → 400, already paused → 200 no alert. `GET /api/admin/float`: keeper SOL vs new optional env `FLOAT_MIN_SOL` (api, default 0.5) and treasury USDC vs next expected payout summed per model with each model's splits (90% before a token exists, G17). `POST /api/admin/health-checks/run` → 200 `{checked, ok, failed, paused}` (all active models in parallel); 401 wrong token, 403 disallowed IP. The P5-T4 commit was amended once (ESLint fix) before any other commit landed on top.
  - **api P5-T5:** `src/alerts.ts`; 5xx rate counted by a middleware over every finished response, min sample 50 in the 5-minute window; error-rate and rejected-deposit alerts fire once when tripped and re-arm after clearing; model-paused alerts fire on every pause (health check and admin pause both route through `ctx.alerts`, title "model paused", body `{modelId, consecutiveFailures?, reason}`). `AppContext` gained `alerts`. Two one-off failures in unrelated tests (`app.int` async-boom, `launch.int` prepare 404) seen under load during P5-T5, not reproduced in 3 later full runs nor in the root gate: watch for flakiness.
  - **keeper P6-T5:** `SETTLEMENT_STEPS` is now the full 7 (`compound`, `finalize` appended); steps2 tests use an explicit `STEPS_2_TO_5`. `compound` measures fee amounts as the keeper's SOL/token balance gain across the claim (`claimPositionFee` returns only a signature; concurrent sends can only undercount); a landed-but-lost claim records the signature with zero amounts and a warning. Invariant L375 (`doneInvariantViolation`/`checkDoneInvariant` exported): paid provider amount needs a signature; lamports spent need a buy signature (curve) or add+lock signatures (graduated); phase `none` passes; violation → `SettlementInvariantError` (non-retryable → `failed` + alert). `src/settlement/engine.ts`: 3 attempts per step, backoff 500 ms/2 s/8 s (injectable `ctx.sleep`), retryable = `chain_send_failed`, retryable `AppError`, `PendingTxUnresolvedError`, transient Mongo, RPC/blockhash/network-style messages, "changed mid-run"; everything else incl. `LiquidityUnlockedError` ("landed without its lock") fails immediately with an alert; the settlement doc is reloaded after every failed attempt; `attempts`/`error` written with `updateOne`. `src/settlement/orchestrator.ts`: one model's open settlements in period order, 3 models concurrently, resume scan before opening the last complete hour; `main.ts` fires `runNow('settle')` at boot without awaiting (lease renewal unaffected). `settle-once` takes the keeper lease first and refuses if held; summary (`src/settlement/summary.ts`) includes state, attempts, error, provider fields and the full `liquidity` block. Live `settle:once -- --chain fake` against compose mongo printed `{"chain":"fake",...,"settlements":[]}` (no models seeded yet). `test/helpers.ts` gained `addRequest`, `graduate`, `DEFAULT_THRESHOLD`.
  - **keeper P6-T6:** `test/settlement.suite.test.ts` 21 tests (transitions, crash after each of 7 steps, `crashAfterLand` on transfer and buy, carry-over, cap, curve→graduated switch, no-token 90/10, concurrent runner, invariant on every `done` doc, zero revenue, dust, orphaned request).
  - **keeper P6-T7:** `src/jobs/{healthCheck,floatMonitor,holdExpiry,stats}.ts`. healthCheck posts `{}` with `Authorization: Bearer ADMIN_TOKEN` and `content-type: application/json`, 30 s timeout, any 2xx = ok, warn alert otherwise, pauses 60 s after 3 failures; disabled with a warning if `ADMIN_TOKEN` unset. floatMonitor: keeper SOL < `FLOAT_MIN_SOL` → alert; treasury USDC vs expected payout (per-model accrued revenue × provider bps, min/max thresholds) → alert; treasury wallet derived from the treasury signer. stats writes `models.stats.{requests, successRate (0–1), revenueMicroUsdc, lockedLiquidityLamports}` (sum of `liquidity.solAddedLamports` over `done` settlements, all time; includes curve-buy SOL per the plan's definition); api `lamportsToSol` renders `"0.5"`.
  - **keeper P6-T8:** `src/jobs/reconcile.ts`, new env `RECONCILE_CRON` (default `0 3 * * *`); ledger drift fixed with a conditional `updateOne` inside a transaction + alert; every signature field of settlements with `periodStart` in the last 48 h must be `landed`, else one error alert. No db fields were added by the keeper (all existed).
  - **scripts P8-T2:** `seed-models.ts` (`--owner`, `--dev-credit <wallet> <usdc>`, `--fake-token`; model `mock-llm` → upstream `mock-model` at `http://localhost:${MOCK_UPSTREAM_PORT ?? 4010}/v1`, key `mock-key` encrypted with `MASTER_KEY`; pricing 1/2 USDC per M tokens; `supportsStreamUsage: false`; G23 guard checked before anything else, exit 1 with "nothing was written"; idempotent: same model id/mint/pool across runs, credit additive). `dev-signin.ts` (`API_URL` default `http://localhost:4000`, `/api/auth/nonce` + `/api/auth/verify`, `--export` prints `export WALLET=… JWT=…`). **Chain additive:** fake chain persists pools in `fakeChainPools` (`addPersistedPool()`, lazy one-time hydrate on first pool call, write-back after curve buy/migrate/add on persisted pools; `addPool` unchanged, in-memory wins), `saveFakeSolUsd`/`loadFakeSolUsd` in `fakeChainPrices`, `FakeChainMongo` gained optional `replaceOne`. **Still needed for P9-T1 fake mode:** `apps/api/src/main.ts` calls `createFakeChain({usdcMint})` without `mongo` (add `mongo: {collection: n => connection.db.collection(n)}`); keeper `runtime.ts` hardcodes `new FakePriceSource(150)` (optionally `loadFakeSolUsd`).
  - **scripts P8-T4:** `devnet-e2e.ts` runs `corepack pnpm --filter @ibt/keeper settle:once --chain real --period-start …` **without** `--` (a literal `--` makes settle-once's `parseArgs` fall back to the fake chain) and asserts the summary reports `chain === 'real'`; model splits 1000/8000/1000 and 1 USDC revenue per run so no devnet USDC payout is needed; the script performs migration with the keeper key and flips the model to `graduated` itself (poller not running); claimable fees verified by simulating `claimPositionFee`; requires `apps/keeper/.env` and a Mongo (`ibt_devnet_e2e_*` db per run). Unset → prints `skipped (...)`, exit 0; mainnet → exit 1.
  - **scripts P8-T7:** `ci.yml` jobs `ci` (+ Playwright install/run, `test-results` artifact on failure), `docker` (build + `--version-check`), `nightly-devnet-e2e` (`docker compose up -d --wait mongo`, copies keeper `.env.example`, `RPC_URL` from `DEVNET_RPC_URL`, optional `JUPITER_API_KEY`, skips when the secret is empty).
  - **scripts P8-T8:** `README.md` (grep count 10; every `.env.example` name present plus `LOG_LEVEL`, `API_URL`, `I_AM_HUMAN`, `RECONCILE_CRON`). It was written while `/api/admin/*` was not yet mounted; runbooks 3/4 and the admin note were corrected afterwards by the orchestrator (see next bullet).
  - **Orchestration:** `pnpm-workspace.yaml` relink (31dde1f) removed the stale-copy class of bugs; no agent in this wave hit it. Throwaway db `ibt_p8t2_check` dropped from the compose mongo.
- **Wave 15 (P8-T6, P9-T1, P9-T2) landed.** Commits: f20a769 P9-T2 api acceptance; a01eb2e `fix(api)` fake chain gets `mongo` in `main.ts`; d27ee68 `fix(keeper)` `SeededFakePriceSource`; 6b53619 P9-T2 keeper acceptance; 50f2243 `docs/acceptance-checklist.md`; 04a9763 P8-T6; 2ea5b8f P9-T1. Deviations:
  - **`settle:once -- --flags` is broken by design of pnpm 12 + `parseArgs`:** pnpm forwards the literal `--`, `parseArgs` then treats everything after it as positionals, so `--chain`/`--period-start` are silently ignored (defaults: fake chain, last complete hour). README and §9 now use `settle:once --chain … --period-start …` without `--`; `devnet-e2e`, `smoke-local` and the keeper acceptance test never pass `--`.
  - **P9-T1 smoke (`scripts/smoke-local.ts`):** spawns tsx directly (`node <tsx/cli> --conditions=development <entry>`, own process group; `pnpm exec` starts tsx in a separate group so group kills missed it); api always from `src` (a stale `dist` would lack a01eb2e); port check binds and connects on 127.0.0.1/::1 (a Python service on 127.0.0.1:4000 answers `{"detail":"Not Found"}` on this machine, so the api falls back to a free port); fresh `ibt_smoke_<ts>` db dropped after awaiting every model's `init()` (mongoose re-runs model init on reconnect and recreated collections right after `dropDatabase`); race timers are `unref`'d (they kept the process alive ~2 min after `SMOKE OK`); settlement period = UTC hour of the gateway request; env forced in code (`CHAIN_MODE=fake`, `CLUSTER=devnet`, db, ports, `LOG_LEVEL=warn`, generated secrets, throwaway keeper/treasury keypairs), `SMOKE_ENV_FILE` only adds extras; the api child never receives `*_SECRET_KEY`. `scripts/lib/cli.ts` gained `isMain(import.meta.url)`; `dev-signin.ts` exports `signInEphemeral({apiUrl})`, `seed-models.ts` exports `seedModels({owner, devCredit, fakeToken, env})` (CLI unchanged). Real run: `SMOKE OK` in ~4 s warm (first run ~2 min cold tsx compile), cost 0.000008 USDC, carry-over 0.000005 USDC, 6 lamports bought. Keeper: `buildKeeperCtx` stays sync; `SeededFakePriceSource` reads `loadFakeSolUsd` per call, default `DEFAULT_FAKE_SOL_USD = 150`; `apps/keeper/test/runtime.test.ts` (2 tests).
  - **P8-T6 load (`scripts/load/{gateway-load,children,seed,measure,checks}.ts`, root `pnpm load`):** `LOAD_CONNECTIONS` defaults to 5 (autocannon fires each connection's per-second quota as a burst, so connections = peak concurrency; at 10 the overhead p95 sat at 46–50 ms, at 5 27–38 ms, at 2 22 ms); percentiles computed by the script from autocannon's `response` event (no p95 in its histogram; `@types/autocannon` signature differs from what v8 emits, values read from the end of the arg list); `seed.ts` writes users/keys/model itself (seed-models had no exports at the time); keys get an explicit 1,000,000 USDC daily cap and users 1000 USDC credit; db name always `ibt_load_<ts>` even when `MONGODB_URI` is set (host/options kept); G23 guard first; children = tsx from source in their own process groups (SIGTERM then SIGKILL after 5 s); extra thresholds: 0 connection errors, requests ≥ 90% of rate×duration, clean baseline, 0 negative available, 0 non-zero held, 0 balance drift. Full 60 s run on this machine: api p50 17.92 / p95 40.84 / p99 46.36 ms, mock p95 2.47 ms, **overhead p95 38.37 ms < 50**, 3000/3000 2xx, ledger clean, 3160 captures = 3160 `success` docs (incl. warm-up).
  - **P9-T2 acceptance:** `apps/api/test/acceptance.int.test.ts` (4 tests: real `openai` v7 client with only `baseURL`/`apiKey`, `maxRetries: 0`; chat → capture row; `models.list` → `mock-llm`; revoked key → `AuthenticationError`; `stream: true` → 400 `invalid_request`). `apps/keeper/test/acceptance.test.ts` (4 tests): kill mid-settlement spawns `node --import tsx --conditions=development src/cli/settle-once.ts --chain fake --period-start …` (cwd `apps/keeper`; through pnpm the SIGKILL would hit the wrapper) with a **test-only hook** in `settle-once.ts` (`SETTLE_ONCE_PAUSE_AFTER_STEP`, `SETTLE_ONCE_PAUSE_MS`, no-op when unset), waits for `paid_provider` + the landed `transferUsdc` in `fakeChainTxs`, SIGKILLs, expires the lease (`Leases.updateMany expiresAt → epoch`, equivalent to the 90 s TTL), second child finishes; asserts exactly one `transferUsdc` and one `curveBuy` with signatures matching the doc and `state:'done'` (~2 s). Forced failure = unfunded treasury (non-retryable, 1 attempt + alert) and `failNext('transferUsdc', 3)` (retries exhausted + alert); low float via floatMonitor + fake alerter. `docs/acceptance-checklist.md` maps spec L585–592 and L596–602 to test ids / H-steps. **Gaps:** streaming `[DONE]`, idempotency replay, holder discount (cut P4-T6/T7/T8) have no coverage; `@staging` Playwright only renders pages (no wallet/deposit/key flow) and no H step names it; kill mid-settlement proven on the fake chain only.
  - **Orchestration:** three agents ran concurrently on distinct port ranges (4000/4010 smoke with fallback, 4200/4210 load, port 0 tests) with no collisions; the load agent correctly left the smoke agent's uncommitted `scripts/` edits unstaged.
- **Wave 16 (P9-T3) landed.** Commits: 1fc674e `test(scripts)` env/error-code/spec-reference consistency (16 tests, `scripts` now has a `test` script so root `pnpm test` runs it); 4829c42/f9b59d9/d804cfa/8968c76/0af0b60 per-package review fixes; 95ca079 `.sisyphus/plans/review-p9t3.md`; ec671c0 `fix(chain)`; 46de7bd `chore(root)`. Review result: 3 blockers, 0 majors, 10 minors, 4 slop files, 11 wrong spec line refs (all fixed). The accept ("0 blockers") is met after the orchestrator fixes below.
  - **B3 (money) `packages/chain/src/send.ts`:** `sendAndConfirm` used to re-sign with a fresh blockhash after *any* send/confirm error, so a network error that arrived after the RPC had forwarded the tx could pay a provider twice (spec L258). Now only three outcomes start a new attempt: blockhash expired and `getSignatureStatuses` shows nothing landed; the RPC rejected the send with `SendTransactionError` (nothing forwarded); the tx landed with an on-chain error. Everything else throws `chain_send_failed` after a single send. Callers already cope: the keeper engine treats `chain_send_failed` as retryable and `sendWithPendingTx` → `pendingTxOutcome` resolves the persisted signature before rebuilding; the pool poller keeps `shouldSendMigration`; operator scripts fail fast. Three tests added (`send.test.ts`: network error on send → one send, `onSigned` once; network error on confirm → one send; `SendTransactionError` → re-signed).
  - **B2:** `LOG_LEVEL=info` added to `apps/api/.env.example` and `apps/keeper/.env.example` (both env schemas read it; the consistency test caught the gap).
  - **B1:** `.env.example` ships `CHAIN_MODE=real` and `replace-me` placeholders, so the §9/README copy did not start the api. §9 and the README now have a `sed` line after the `cp` (fake chain, `11111111111111111111111111111111` for the three pubkeys, `openssl rand` for the three secrets). Shipping working secrets in `.env.example` was rejected.
  - **Minors left open (design calls, recorded in `review-p9t3.md` §Minors):** duplicate concurrent `X-Request-Id` leaves a 10-minute hold and one unbilled upstream call; two dead query invalidations in the web; curve `priceSolPerToken` is the reserve ratio, not spot; keeper transient-error classification by message substring; hourly `claimPositionFee` even with nothing accrued; no sanity band on the Jupiter SOL price before spending float; seven env names missing from the README env table; unused shared exports kept for Wave C.
  - **Lesson:** `env-consistency.test.ts` checks only that `L<n>` lies inside `Plan.md`, not what the line says; 11 wrong refs passed it and were found by hand.
- **P9-T4 clean-clone gate passed at `a03ef60`** (clone in `$TMPDIR`, `node_modules` absent, no binary cache): `pnpm install --frozen-lockfile`, `lint`, `format:check`, `typecheck`, `test` (596 tests: mock-upstream 17, shared 104, chain 93, web 120, db 47, scripts 16, keeper 75, api 124), `build`, `docker build -t ibt .` (+ `--version-check` for api and keeper), `docker compose up -d --wait mongo` (host `hello.isWritablePrimary` true), `pnpm smoke:local` → `SMOKE OK`, web Playwright 2 passed / 1 `@staging` skipped. Fixes it took, in commit order:
  - **5e08c89 `test(keeper)`:** `lease.test.ts` used a 200 ms TTL with 40 ms renews; under the full-suite CPU load (every keeper file took >10 s) holder A's renew interval stalled past the TTL and B legitimately took over, so "exactly one holds the lease" failed once in the working-tree gate (5/5 green in isolation). The lease is correct; the test now uses 1500/100 ms and 6 s `waitFor` timeouts.
  - **a03ef60 `fix(root)`:** on a cold install pnpm runs the `mongodb-memory-server` postinstall twice (two instances, `supports-color@7.2.0` vs `@8.1.1` peers) into the same empty `node_modules/.cache/mongodb-memory-server`; the second `rename(*.tgz.downloading → *.tgz)` hits ENOENT and `pnpm install --frozen-lockfile` exits 1 (`ERR_PNPM_EXECUTOR_LIFECYCLE_SCRIPT_FAILED`). The working tree never saw it because the binary was already cached; a cold CI cache would. Root `package.json` `config.mongodbMemoryServer.disablePostinstall: "1"` skips the postinstall; the single-process `globalSetup` in `@ibt/db` downloads lazily (db tests run before api/keeper under `pnpm -r test`, so no second race). The lazy path prefers `~/.cache/mongodb-binaries`, so `ci.yml` now caches that directory instead of `node_modules/.cache/mongodb-memory-server`. The Dockerfile already set `MONGOMS_DISABLE_POSTINSTALL=1`.
  - **Environment, not repo:** running `docker compose up -d mongo` from the clone while the main checkout's compose project already published 27017 fails with "port is already allocated", and the container it leaves behind comes up later with broken host port publishing (api got ECONNREFUSED on 127.0.0.1:27017 while `rs.status().ok` was 1 inside the container). After `docker compose down -v` and a fresh `up` with the other project stopped, compose, host connectivity and smoke all passed. Only one compose project per machine can own 27017.
  - **Host port 4000** is occupied on this machine by an unrelated Python service; smoke-local falls back to a free port by design (logged under wave 15).
- **Wave C (spec cut list) landed after the P9-T4 gate**, 11 days before the deadline, as §11 allows. Deps 0538734 (`lightweight-charts` ^5.2.1 in web, `undici` ^7.30 in shared). Commits: d073567 P6-T9 `packages/shared/src/node/telegram.ts` (`createTelegramAlerter`, `createAlerter` with log fallback; also exports `formatTelegramText` and a narrow `TelegramFetch` type; 3500-char body cap under Telegram's 4096 limit; 5 s timeout; token scrubbed from logged errors; 7 tests), d888bcf P6-T9 wiring in both `main.ts`; 290ddda P7-T10 `GET /api/tokens/:mint/snapshots` (`?limit` 1..1000, default 288, oldest → newest, `TokenSnapshotsResponseSchema`; **beyond the spec**, which only has `/state` with the latest snapshot; 5 tests), ea60c41 P7-T10 `PriceChart` (v5 `addSeries(LineSeries)`, explicit `ResizeObserver`, fixed 224 px height, wheel scroll/zoom off, TradingView attribution left on, "No price data yet" below 2 points, chart above `CurveProgress` on the curve and inside the graduated panel; `usePriceSnapshots` lives in `lib/queries.ts` next to `publicQueryKeys`, refetch 15 s to match the poller; `fixtures/lightweightCharts.ts` stands in for the library under jsdom; 6 + 1 tests); b89b3ad P4-T6 streaming (`stream.ts`, `sse.ts`; hold/cost-cap/billing-header helpers shared with `completions.ts`; `stream_options.include_usage` only when `upstream.supportsStreamUsage`; manual `for await` + `drain` pump instead of `stream.pipeline` so a total timeout ends the response instead of destroying it; `X-Balance-Usdc` before the first chunk is balance minus the hold estimate; client disconnect before upstream headers releases with `client_abort` and no 5xx; 6 tests), 649bad9 P4-T7 idempotency (`idempotency.ts`; the `Idempotency` model has no `state` field and `packages/**` was off-limits, so `response: null` means in flight and `requestHash` is a sha256 of the body; same key with a different body → 400; key longer than 255 → 400; replay returns the stored billing headers but the current `X-Request-Id`; 6 tests), f49ecb9 P4-T8 discount (`discount.ts`; `ApiKeyContext.wallet` loaded in `authenticateKey`; per-app 5-minute cache keyed `wallet:mint`; only for `token.status` curve/graduated with a mint; a failed read logs one warning and gives 0 bps; 4 tests). Existing `stream: true → 400` assertions in `gateway.int` and `acceptance.int` became real streaming checks. README scope/env/api rows and `docs/acceptance-checklist.md` L588 rows updated; the three Wave C gap rows are closed.
  - **Flake found while gating Wave C and fixed in 4794611 `test(api,keeper)`.** Symptoms over ~20 api-suite runs: `prepare failed: 401`, `/api/me` 401, `verify failed: 401` (no JWT-verify cause attached), and 404s on `POST /api/keys` and `/api/auth/nonce`, in different files each time, never in isolation. Cause: supertest binds a fresh **wildcard** `listen(0)` server per request and connects to `127.0.0.1:<port>`, while the mock upstreams and the api servers bind `127.0.0.1` explicitly. On macOS a wildcard listener may share a port with a loopback-specific listener, and loopback connections go to the specific one; during the allocation window the kernel can hand both out, so a supertest request lands on another worker's mock upstream (404) or another file's api app (401). Reproduced outside the suite: a two-process churn loop got 1 foreign reply in 3,966 requests, about the observed one failure per 4–8 suite runs. Fix: `makeTestApp()` now returns `app` as an `http.Server` already listening on `127.0.0.1` (supertest reuses a listening server instead of binding one), `TestApp.express` keeps the Express instance, `close()` closes the socket; the acceptance, streaming and smoke tests use `t.app` instead of calling `listen` again; the keeper smoke test binds `127.0.0.1` too. 10/10 api runs green afterwards. Helpers also now include the response body in their "failed" errors. The DIAG message temporarily added to `verifyJwt` during diagnosis was reverted.
  - **Second flake, fixed in 9311efc `test(api)`:** the streaming total-timeout test asserted the whole request took under 3 s; under the root run (eight packages at once, api test files taking 10–18 s each) it took 3.7 s and failed once. The test already proves the cut structurally (no `[DONE]` in the body, request `status: 'timeout'`, hold released, and only the 700 ms app serves that port), so the wall-clock bound was dropped. Root `pnpm test` after both fixes: 630 tests (mock-upstream 17, shared 111, chain 93, web 126, db 47, scripts 16, keeper 75, api 145).
  - **P9-T4 re-run on a fresh clone of 9311efc passed in full:** `pnpm install --frozen-lockfile`, `lint`, `format:check`, `typecheck`, `test` (630), `build`, `docker build -t ibt .` plus `--version-check` for api and keeper, `docker compose up -d --wait mongo` (main checkout's compose stopped first, restored after), README env prep (`cp` + `sed` line), `pnpm smoke:local` → `SMOKE OK`, web Playwright 2 passed / 1 `@staging` skipped. Clone removed; main compose mongo back up.
- **Local dev run verified on this machine (2026-10-02), prompted by the user asking for the commands to run the project.** `pnpm dev` starts the api and keeper without any env, so both exit in `loadEnv`; the working dev form is `cd apps/api && pnpm exec tsx watch --conditions=development --env-file=.env src/main.ts` (same for the keeper). `pnpm --filter @ibt/api exec tsx watch … --env-file=.env` fails with `node: .env: not found` although `pnpm --filter @ibt/api exec pwd` prints `apps/api`, and a root-relative path fails as well (pnpm 12 quirk, not investigated further); the README now says to use `cd`. pnpm 12's CLI rejects `-s` before the command (`error: unexpected argument '-s' found`), so the README/§9 `pnpm -s tsx … dev-signin.ts --export` line never worked with this pnpm; replaced by `pnpm --silent exec tsx …` in both. Node 20.20's `--env-file` parser strips the inline `# real | fake` comment the `sed` line leaves behind. Port 4000 is the user's own `litellm` proxy, so the local `.env` files (gitignored, left in place) use `PORT=4100` with `API_INTERNAL_URL` and `VITE_API_URL` pointing at 4100. Verified against the running stack: sign-in, `seed-models --fake-token --dev-credit 10`, key creation, chat completion 200 (`X-Cost-Usdc: 0.000008`, `X-Discount-Bps: 0`), ledger `adjust` + `capture` rows, keeper lease acquired and a settlement run finished. The seeded dev data (model `mock-llm`, one ephemeral wallet holding 10 USDC of credit) stays in the compose `ibt` database.
- **Docs page contents highlight (2026-10-02, user report: the active item should look like the hover state).** The "On this page" rail on the Docs page had hover styles only. New `apps/web/src/hooks/useActiveSection.ts`: the URL hash wins when it names a section, otherwise a passive scroll listener picks the last section whose top has passed a reading line 20% down the viewport (100 px floor, so a section scrolled to its 96 px `scroll-mt-24` margin still counts on short viewports), the first section while the page is scrolled above it, and the last section at the page bottom; on mount it reads the scroll position only when the page is already scrolled. An IntersectionObserver version was built first and dropped: the last section is too short to reach the line, so clicking "Where the money goes" lit "Errors" (seen in Chromium, not in jsdom). The active link gets the hover classes plus `aria-current="location"`. Verified against a production build in Chromium (initial, scroll, click, back to top, bottom, 480 px viewport, hash on load) and by 6 jsdom tests in `Docs.test.tsx` (web 132 tests, Playwright 2 passed / 1 skipped). Noticed, not changed: the Docs page still says "Streaming is coming soon" (and a test asserts it) although P4-T6 shipped streaming; flagged to the user.
- **Devnet verification with the user's env files (2026-10-02; user: "I put all the env variables, make sure it actually works on devnet").** Env audit (secrets never printed): `RPC_URL` (Helius devnet) and `RPC_URL_FALLBACK` answer with the devnet genesis hash; Jupiter price works keyless and with the keeper's `JUPITER_API_KEY` (lite and `api.jup.ag`); `TELEGRAM_BOT_TOKEN` is a valid bot (`getMe`) but `TELEGRAM_CHAT_ID` is empty, so alerts stay in the logs. `TREASURY_SECRET_KEY` (43 chars) and `KEEPER_SECRET_KEY` (38 chars) are not valid keys: both contain non-base58 characters and are neither JSON arrays, hex nor base64, so `parseSecretKey` and `readSecretKeypair` reject them. Still placeholders: `DBC_CONFIG`, `TREASURY_WALLET`, `KEEPER_WALLET` (`1111…`, accepted by `PublicKeySchema` because it is the system program), `VITE_DBC_CONFIG`, `VITE_TREASURY_USDC_ATA` (`replace-me`). The Mongo compose container had disappeared entirely (no container, nothing on 27017; the four dev processes seen listening at first had exited by the next check); `docker compose up -d --wait mongo` recreated it, the `ibt` database was intact.
  - **Live read paths on devnet, against pools other people created (85,116 `VirtualPool` accounts found via the Anchor discriminator):** `readPool` by pool and by `{mint, config}`, `verifyLaunch` on a real `createPool` transaction (and `pool_mismatch`/`creator` with a wrong creator), `quoteCurve`, `tokenBalance`, `verifyDeposit` on a real USDC `transferChecked` (`missing_memo`, as expected without a memo). `readDammPool`/`quoteDamm` returned null on the first migrated sample because its config used migration fee option 3: our `deriveDammPool` is specific to fee option 2 (`Hv8Lmz…cjp`, 100 bps) and WSOL, by design. A pool migrated under option 2 (`9LbQHvyNusMcXDYY7LcCp6xuXQSQruEf8eQiwhUWiNwh`) read and quoted both ways.
  - **API in `CHAIN_MODE=real` on devnet** (port 4102, scratch db `ibt_devnet_check`, dropped afterwards; the user's `.env` plus `PORT`/`MONGODB_URI` overrides): `/readyz` `{ok, mongo, chain}` all true; with a model row pointing at the real curve pool `35DxxLp6…`: `/quote` buy and sell, `/state` (0 before any snapshot, live reserve `0.009799991` SOL and progress after the keeper's poller wrote snapshots), `/settlements`, `/snapshots`, `/api/models`, 404 for an unknown mint.
  - **Keeper in real mode with unfunded throwaway keys** (`KEEPER_PORT=4003`, `ADMIN_TOKEN` empty so the health-check job is disabled): booted, acquired the lease, the boot settlement run finished with nothing to settle, `poolPoller` wrote a `poolSnapshots` row from devnet every 15 s. Keys passed through the environment only and discarded.
  - **Blocked: anything that signs.** Helius devnet answers `requestAirdrop` with HTTP 500 on every attempt; the public faucet answered a 5 SOL request with "Internal error" and 2 and 1 SOL with 429 "reached your airdrop limit today or the faucet has run dry"; there is no Solana CLI keypair on the machine and the user's keys do not decode. So `devnet-e2e` (H6), `create-config --send` (H4), a launch confirm through the API with a real owner wallet, a real USDC deposit (needs devnet USDC from faucet.circle.com), and the real settlement buy/migrate/lock were not run. Commit `1dd0156 fix(scripts)`: `devnet-e2e.ts` gained `fund()`: `DEVNET_FUNDER_SECRET_KEY` (one transfer from a pre-funded wallet, balance checked first) or faucet airdrops through `AIRDROP_RPC_URL` (default public devnet, never `RPC_URL`) in 2 SOL requests into the treasury wallet, which then pays creator/trader/keeper in one transfer; `FAUCET_DRY` stops retrying on the daily-limit message; `waitForLamports` covers the lag between the faucet's RPC and `RPC_URL`. README: the devnet bullet, two new env rows (`DEVNET_FUNDER_SECRET_KEY`, `AIRDROP_RPC_URL`, Used by scripts) and the exact secret-key format on the `*_SECRET_KEY` rows. Verified: prettier/eslint/`tsc -b scripts`, scripts tests 16/16, and a real run fails fast (11 s, exit 2) with the faucet message. The funder path is untested live: nothing on this machine holds devnet SOL.
  - **Docs page:** the Streaming section said "coming soon" and told users not to send `stream: true` although P4-T6 shipped streaming; it now describes the SSE relay, `data: [DONE]`, the hold-based `X-Cost-Usdc`/`X-Balance-Usdc` sent before the first chunk, the capped final charge, the unbilled timeout/disconnect cuts and the idempotent replay as JSON. `Docs.test.tsx` asserts the new text.
- **Devnet run with the user's keys (2026-10-02, afternoon; user: "I have put the private key as well, VITE_TREASURY_USDC_ATA I don't know and DBC_CONFIG").** The keeper `.env` now held two valid 64-byte base58 keys, both the same wallet `EiH21XJyoCx17LTGWV63KxzXFDKTQA8Aw3MEQbbp1dYG` holding 10 SOL, so treasury and keeper are one wallet on devnet (works; two wallets for mainnet). Filled in from the keys, never printing a secret: `TREASURY_WALLET`/`KEEPER_WALLET` (api) and `TREASURY_WALLET` (keeper); `VITE_TREASURY_USDC_ATA=6GBMbSPFragSR2Y2tqyx5qPAqmNPpyCLmo6jdmZz928q` (`getAssociatedTokenAddressSync(USDC, treasury)`, the address `treasuryAta(ctx)` derives); `TELEGRAM_CHAT_ID=1497548963` from the user's `getUpdates` paste (a test alert through `createAlerter` answered HTTP 200); the keeper's `JUPITER_API_KEY` copied into the api env. On devnet, at the user's request and standing in for the `I_AM_HUMAN=1` operator: `create-config --cluster devnet --send` created config `HDJm1Cc9gGu4Y9EnqKF59Sp65ZonMKtLG8t5Lq4RFvzX` (sig `48Noim…3EDz`; `getPoolConfig` reads back feeClaimer = treasury, WSOL quote, 1 SOL threshold, migration option 1, fee option 2) and `DBC_CONFIG`/`VITE_DBC_CONFIG` were set in all three apps; the treasury USDC ATA was created with `createAssociatedTokenAccountIdempotent` (sig `3SD1tX…38Mg`) because the web deposit transfers straight into it. The fake-mode seed (model `mock-llm`, its ephemeral user, key, request, ledger, settlement, 57 snapshots, the `fakeChain*` collections) was removed from the compose `ibt` database by id; the user's own rows (wallet `Hpq9…gFba`, model `amit`) stayed.
  - **First `devnet-e2e` with `DEVNET_FUNDER_SECRET_KEY` = the user's wallet: 10 checks passed, then `FAIL settlement after graduation (no lock recorded)` and `FAIL keeper position recorded`.** The graduated settlement died at `buyAndLock:addLiquidity`, `attempts: 3`, error text `transaction could not be confirmed`. All nine add-liquidity sends (3 `sendAndConfirm` attempts × 3 engine attempts) **landed** with `InstructionError [5, Custom 6002]` = cp-amm `ExceededSlippage` at `ix_add_liquidity.rs:146`. Simulating the same add with unlimited thresholds moved exactly the SDK-quoted amounts (vault A +1314405136865, vault B +6572025), so equal thresholds should have passed; decoding the failed instruction showed `liquidityDelta 54216811413822396689000000000` instead of the quoted `…688848514146`. Root cause: `toBN(x) = convertToLamports(x.toString(), 0)` runs through decimal.js at its default 20 significant digits, so every u128 liquidity value was rounded (here up, by 1.5e8); the program needed slightly more than the thresholds and refused. Lamports and token base units never reach 20 digits, which is why the curve phase, the swaps and every test passed.
  - **Fixes:** 324e25f `chore(deps)` adds `bn.js` ^5.2.5 (`@types/bn.js` dev) to chain and web; 1590015 `fix(chain)` `toBN = new BN(value.toString())`, `BNValue = BN`, the `convertToLamports` re-export removed, regression tests in `sdk-surface.test.ts` (the real delta and 2^128 − 1 stay exact) and `damm.test.ts` (a u128 through `buildAddLiquidity` and `buildPermanentLock`); c583383 `fix(web)` the same `toBN` in `lib/trade.ts`; 3a82bba `fix(keeper)` `errorMessage` includes the cause chain, so a failed settlement records `transaction failed: {"InstructionError":…}` instead of only the catalog text; 2a7d942 `fix(scripts)` `FUNDING` right-sized from 5 to 2 SOL from the measured spend (config ≈ 0.008, pool ≈ 0.021, trader 1/0.7 ≈ 1.43 at the 30% cliff fee, keeper < 0.05), `lamportsOf` and the airdrop accept fractional SOL, README funding text. The targeted path then ran live with the user's wallet against the first run's DAMM pool: `dammSwap` 0.003 SOL, `addAndLock` 0.002 SOL (new position `EFes2rBx2HBga3adrTRLKBw9LRuTDbxFsKBGJ9d3b9SD`, `permanentLockedLiquidity` = the delta exactly, unlocked 0) and a real `claimPositionFee`, about 0.014 SOL in all.
  - **Second `devnet-e2e` (2 SOL from the user's wallet): 14/14.** Config `EH3jAQjiWVcEzJbBfVuMryKk2fi4f8LVURpA7tS4FeSS`, pool, three buys, settlement on the curve, threshold reached, `migrateToDammV2` `5jLgXD…cpK9`, settlement after graduation `341su1…xJNf`, keeper position recorded and permanently locked (54083134318536000469122310833, unlocked 0), `claimPositionFee` simulates. Both runs' `ibt_devnet_e2e_*` databases were dropped afterwards; the throwaway wallets keep what they did not spend (about 3.5 SOL from the first run, 0.3 from the second; their keys are never persisted). The user's wallet went 10 → 2.979 SOL.
  - **Final checks:** api in real mode `/readyz` `{ok, mongo, chain}` all true and `/api/admin/float` reading the real wallet; keeper boots with the Telegram transport, acquires the lease and finishes the boot settlement run; root `lint`, `format:check`, `typecheck`, `build`, `test` green (637 tests: mock-upstream 17, shared 111, chain 94, web 132, db 47, scripts 16, keeper 75, api 145). README addresses table: devnet config, treasury, ATA and keeper filled in. Left for the user: H6 "twice in a row" (one passing run so far), a Phantom wallet to launch through the web, devnet USDC for a deposit, the deploys; the model `amit` is paused because its upstream URL fails the health check.
- **Phantom sign-in (2026-10-02; user console: `WalletSignMessageError: The app's signature request cannot be shown due to invalid formatting` at `useAuth.ts:89`).** The nonce message is byte-identical to `createSignInMessageText` from `@solana/wallet-standard-util` and parses with its `parseSignInMessageText`; the domain is the `WEB_ORIGIN` host, which CORS forces to equal the page host; the nonce is 32 hex characters and `Issued At` is RFC 3339, so the text meets the Sign-In-With-Solana ABNF. Phantom still refused it through `signMessage` (it validates recognised SIWS text before prompting and answers -32000 without a prompt). Fix in `apps/web/src/hooks/useAuth.ts`: when `useWallet()` exposes the Wallet Standard `signIn` (Phantom and Solflare do; the console showed `StandardWalletAdapter` with `signIn`), the hook passes `{domain, address, nonce, issuedAt}` parsed from the server's message and lets the wallet build and sign the text itself, then checks that the signed account is the connected wallet and that the signed bytes equal our template, so the api's verification is unchanged. `signMessage` stays as the fallback for wallets without `signIn`. Wallet errors (`WalletSign*`) now show their own text in the sign-in panel instead of "Sign-in failed". Tests in `WalletGate.test.tsx`: the signIn path, a wallet that alters the text (refused, no verify call) and the wallet-error display (web 135 tests). Not verified live: no Phantom on this machine; the user retries in the browser.
