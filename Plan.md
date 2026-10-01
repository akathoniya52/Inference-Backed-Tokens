# Inference-Backed Tokens — Technical Documentation

Oct 1, 2026 · @Amit Patel

## Overview

Inference-Backed Tokens pairs every AI model listed on an inference gateway with a token launched on Meteora's Dynamic Bonding Curve (DBC). A fixed share of each paid inference request buys that token and locks it as permanent DAMM v2 liquidity. The token's market therefore tracks measured demand for the model rather than hype.

Who it serves:

- Providers list a model behind an OpenAI-compatible endpoint, launch its token, and earn their inference revenue plus the creator share of trading fees.
- Consumers call one API across every listed model and pay for usage (billing model: see open decisions).
- Token holders get utility on the gateway (discounts or credits) and a market whose fundamentals are public: requests, success rate, revenue, liquidity locked.

Hackathon context: the project targets the [Best use of Meteora's DBC](https://superteam.fun/earn/listing/meteora-dbc) sidetrack of [Colosseum's Crypto World's Fair](https://colosseum.com/worldsfair) on Superteam Earn ($20,000 USDC: $10k / $5k / $3k / $1.5k / $500). Sidetrack submissions close Oct 13, 2026 at 06:59 UTC; the same build goes into Colosseum's main Solana track. Meteora has also announced discretionary infrastructure grants for AI and RWA use cases built on DBC during this period.

| Judging criterion | How the project scores |
| --- | --- |
| Depth of Meteora integration | DBC partner config, pool creation and curve swaps; graduation to DAMM v2; keeper buys and permanently locks DAMM v2 liquidity; partner and creator fee claims on both programs |
| Technical execution | Typed TypeScript monorepo, metered gateway with idempotent billing, settlement with an on-chain audit trail, devnet end-to-end tests including migration |
| Originality and taste | Compute-backed tokens: an asset whose fundamentals (requests, success rate, revenue) are measurable on the platform and independent of the meme-stock meta |
| Impact potential | Any provider can list any model; the same primitive extends to agents, datasets and GPU capacity |
| Traction and volume | Mainnet launch with one to three real models and real paid usage before the deadline |

## Actors and glossary

Six actors touch the system; two of them (platform and keeper) are the same operator with different wallets.

| Actor | Role | On-chain identity |
| --- | --- | --- |
| Provider | Lists a model, launches its token, receives inference revenue and the creator fee share | Wallet that signs pool creation (the DBC creator) |
| Consumer | Calls the gateway API and pays for usage | API key; wallet optional (see open decisions) |
| Token holder | Buys the model token on the curve or on DAMM v2; gets gateway utility | Any wallet |
| Platform | Runs the gateway, keeper and frontend; owns the DBC partner config | Treasury wallet, set as the config's fee claimer |
| Keeper | Backend job that settles revenue, buys tokens and locks liquidity | Hot wallet funded with USDC and SOL |
| Meteora migrator | Meteora-operated keeper that migrates a DBC pool to DAMM v2 once the threshold is met | Meteora |

| Term | Meaning |
| --- | --- |
| DBC | Meteora's Dynamic Bonding Curve program: a virtual pool that sells a new token along a configured curve until a quote threshold is reached |
| Partner config | On-chain account created by the platform that fixes curve, fees, quote token, migration and LP rules for every pool launched under it |
| Base / quote token | Base is the model token being sold; quote is the token paid in (USDC or SOL) |
| Graduation (migration) | The moment a pool reaches its migration quote threshold; its liquidity moves into a DAMM v2 pool |
| DAMM v2 | Meteora's constant-product AMM with position NFTs, fee schedulers and permanent liquidity locks |
| Position NFT | Ownership record of a DAMM v2 liquidity position; the keeper's positions are permanently locked |
| Fee claimer | The partner wallet that collects the partner share of DBC trading fees |
| Fee scheduler | A base fee that starts high and decays linearly or exponentially after launch; the anti-sniper mechanism used here |
| Billable request | An inference request that completed successfully; the only unit that counts toward settlement |
| Settlement period | Fixed window (hourly in the MVP) over which billable revenue is aggregated and split |
| Buyback | Keeper purchase of the model token: on the curve before graduation, on DAMM v2 after |

## System architecture

Three deployables (web, api, keeper) and one database. The browser signs every user transaction with the user's own wallet, the API meters inference and only reads the chain, and the keeper is the single component that moves money.

&#91;embedded content: system architecture · 3 services, 1 database, 2 Meteora programs\]

User transactions never pass through the server: the web app builds launch, swap and deposit transactions with the Meteora SDKs and the wallet signs them; the API then verifies the result on-chain. The keeper holds the only hot keys.

### End-to-end flows

1. Provider onboarding: register the model and upstream endpoint → health check passes → set prices → sign `createPool` in the browser → `POST /api/tokens/launch/confirm` verifies the pool and marks the token `curve`.
2. Consumer usage: sign in with wallet → create an API key → send USDC to the treasury with the memo `depositRef` → `POST /api/billing/deposits` credits the ledger → calls to `/v1/chat/completions` are held, proxied, and captured per request.
3. Hourly settlement: the keeper sums billable requests per model → pays the provider in USDC → converts the liquidity slice to SOL → buys on the curve or adds and locks DAMM v2 liquidity → publishes the settlement row.
4. Graduation: the curve reaches 10 SOL → the keeper (or Meteora's keeper) migrates the pool to DAMM v2 → the poller flips the token to `graduated` → trade panel and keeper switch to DAMM v2 calls.
5. Fee claims: provider and platform claim curve fees and locked-position fees from their dashboards with their own wallets.

## On-chain design (Meteora DBC and DAMM v2)

One DBC partner config, owned by the platform treasury, governs every model token: SOL quote, 10 SOL graduation, exponential anti-sniper fee, migration into a DAMM v2 pool whose liquidity is permanently locked. Providers never touch the config; they only sign pool creation.

### Partner config (one per launch class)

| Parameter | Mainnet value | SDK field (`buildCurve` / `createConfig`) | Why |
| --- | --- | --- | --- |
| Quote token | Wrapped SOL `So11111111111111111111111111111111111111112` | `quoteMint: NATIVE_MINT` | Standard launchpad UX; the keeper's float is held in SOL |
| Supply and token | 1,000,000,000 tokens, 6 decimals, SPL | `token.totalTokenSupply`, `tokenBaseDecimal: SIX`, `tokenQuoteDecimal: NINE`, `tokenType: SPL` | Decimals must be 6–9; SPL keeps wallets and explorers simple |
| Update authority | Immutable | `tokenUpdateAuthority: Immutable` | Metadata cannot change after launch |
| Curve builder | `buildCurve` | `percentageSupplyOnMigration: 20`, `migrationQuoteThreshold: 10` | 80% of supply sells along the curve for 10 SOL; 20% plus the raised SOL seed the DAMM v2 pool |
| Graduation threshold | 10 SOL (devnet: 1 SOL) | `migrationQuoteThreshold` | 10 SOL is a threshold Meteora's mainnet keepers auto-migrate for WSOL pools; our keeper also cranks migration itself |
| Base fee | Exponential scheduler 30% → 1% over 60 min | `baseFeeMode: FeeSchedulerExponential`, `feeSchedulerParam: {startingFeeBps: 3000, endingFeeBps: 100, numberOfPeriod: 60, totalDuration: 3600}` | Snipers pay the most in the first minutes; 1% steady state. Rate limiter mode is deprecated for new configs |
| Dynamic fee | Enabled | `dynamicFeeEnabled: true` | Adds up to 20% of the minimum base fee during volatility |
| Fee collection | Quote token | `collectFeeMode: QuoteToken` | Fees accrue in SOL, one asset to claim and account for |
| Creator fee share | 50% | `creatorTradingFeePercentage: 50` | Protocol keeps 20% of every trading fee; of the partner's 80%, half goes to the provider: provider 40%, platform 40%, protocol 20% |
| Pool creation fee | 0 | `poolCreationFee: 0` | No friction for providers in the MVP |
| Migration target | DAMM v2 | `migrationOption: MET_DAMM_V2` | DAMM v1 migration is deprecated |
| Graduated pool fee | Fixed 100 bps | `migrationFeeOption: FixedBps100` → config key `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp` | 1% fee after graduation; fixed options need no custom `migratedPoolFee` |
| Migration fee | 0% | `migrationFee: {feePercentage: 0, creatorFeePercentage: 0}` | The whole threshold becomes liquidity |
| LP distribution | Partner 50% permanently locked, creator 50% permanently locked | `partnerPermanentLockedLiquidityPercentage: 50`, `creatorPermanentLockedLiquidityPercentage: 50`, the two unlocked shares 0 | All migrated liquidity is locked forever; both parties still claim its fees |
| Locked vesting | None | all `lockedVesting` fields 0 | Provider token allocation is an open decision |
| Activation | Timestamp | `activationType: Timestamp` | Scheduler durations are read in seconds |
| Fee claimer, leftover receiver | Treasury wallet | `feeClaimer`, `leftoverReceiver` | Partner fees and any leftover base tokens go to the platform |

The config is created once per environment by `scripts/create-config.ts`:

```ts
const params = buildCurve({
  token: { tokenType: TokenType.SPL, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.NINE,
           tokenUpdateAuthority: TokenUpdateAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
  fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
           feeSchedulerParam: { startingFeeBps: 3000, endingFeeBps: 100, numberOfPeriod: 60, totalDuration: 3600 } },
         dynamicFeeEnabled: true, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 50,
         poolCreationFee: 0, enableFirstSwapWithMinFee: false },
  migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100,
               migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
  liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 50,
                           creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 50 },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0,
                   totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Timestamp,
  percentageSupplyOnMigration: 20,
  migrationQuoteThreshold: 10, // SOL; 1 on devnet
});
const tx = await client.partner.createConfig({ config: configKeypair.publicKey, feeClaimer: treasury,
  leftoverReceiver: treasury, payer: treasury, quoteMint: NATIVE_MINT, ...params });
```

The SDK validates the config on creation: liquidity shares must sum to 100%, at least 10% of liquidity must stay locked for one day, and curve points must ascend. Run the script against devnet first and record both config public keys in the environment files.

### Launch, trade, graduate

1. Launch. The provider's wallet signs `client.pool.createPool({ baseMint, config, name, symbol, uri, payer: provider, poolCreator: provider })`. The frontend generates the `baseMint` keypair, which also signs. `uri` points at `GET /metadata/:mint.json` on the API. The pool address comes from `deriveDbcPoolAddress`; the backend verifies on-chain that `creator` is the provider and `config` is ours before marking the model as launched.
2. Trade on the curve. The frontend reads `client.state.getPool` and `getPoolConfig`, computes `currentPoint`, quotes with `client.pool.swapQuote2` in `PartialFill` mode, and builds `client.pool.swap2`; the wallet signs. Curve progress shown to users is `quoteReserve / migrationQuoteThreshold`. SOL buyers need about 0.01 SOL extra for fees.
3. Graduate. When `quoteReserve` reaches the threshold the curve is complete. The keeper calls `client.migration.migrateToDammV2({ payer: keeper, virtualPool, dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[2] })` within one poll cycle; Meteora's mainnet keepers (`Asi5DTGEeiso6k7ya6ndDabEZ7DRCgfTpCBLPH5E3aQs`, `DeQ8dPv6ReZNQ45NfiWwS5CchWpB2BVq1QMyNV8L2uSW`) are the fallback, and on devnet the [manual migrator](https://migrator.meteora.ag) is. After migration `isMigrated = 1`; the DAMM v2 pool address is derived with cp-amm-sdk `derivePoolAddress` from the fee config key, base mint and WSOL, then confirmed by reading it. No leftover withdrawal or locker is needed with `leftover: 0` and no vesting.
4. Claim fees. Platform: `claimPartnerTradingFee` for curve fees, `claimPositionFee` on its locked DAMM v2 position. Provider: `claimCreatorTradingFee` and `claimPositionFee` on theirs. Both appear as Claim buttons in the dashboards.

The keeper's own buyback liquidity is separate from the migrated LP: one DAMM v2 position per model, grown with `addLiquidity` and locked with `permanentLockPosition` after every settlement (section Token lifecycle). Fees that position earns are claimed by the keeper and folded into the next liquidity slice.

| Program or account | Address |
| --- | --- |
| DBC program (mainnet and devnet) | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| DBC pool authority PDA | `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` |
| DAMM v2 program (mainnet and devnet) | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| DAMM v2 fee config, option 2 (100 bps) | `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp` |

Sources: [DBC developer guide](https://docs.meteora.ag/developer-guides/dbc), [DBC SDK functions](https://docs.meteora.ag/developer-guide/guides/dbc/typescript-sdk/sdk-functions.md), [DAMM v2 SDK reference](https://docs.meteora.ag/developer-guides/damm-v2/typescript-sdk/reference).

## Token lifecycle and settlement engine

Every hour the keeper turns the previous hour's billable revenue for each model into three things: a USDC payout to the provider, a token buy that becomes permanently locked liquidity, and a platform fee. Every on-chain step is recorded by signature and published on the token page.

### Billable request

A request counts only when all of the following hold:

- The upstream returned HTTP 2xx and the response completed: for non-streaming calls the JSON parsed with a `choices` array; for streaming calls the `[DONE]` sentinel arrived.
- `usage.prompt_tokens` and `usage.completion_tokens` are present in the upstream response (if the upstream omits them, the gateway counts tokens with `tiktoken` and flags the request `usageEstimated: true`).
- The request is not a duplicate: an `Idempotency-Key` header seen before within 24 h returns the stored response and is never billed twice.

Cost in micro-USDC = `prompt_tokens × inputPricePerMTok / 1e6 + completion_tokens × outputPricePerMTok / 1e6`, then the holder discount (section Backend) is applied. Prices are set by the provider per model and shown gross; the split below applies to the gross amount.

### Revenue split

| Share | MVP default | Destination | On-chain? |
| --- | --- | --- | --- |
| Provider | 70% | USDC transfer to the provider wallet | Yes, SPL transfer from treasury |
| Liquidity slice | 20% | Token buy + locked DAMM v2 liquidity for that model | Yes, DBC or DAMM v2 transactions |
| Platform | 10% | Stays in the treasury USDC account | No transaction |

The split is stored per model (`models.splits`) so launch classes can differ later; the MVP uses one global default.

### Token phases

| Phase | Condition | What the liquidity slice does |
| --- | --- | --- |
| No token | Model listed, provider has not launched | Slice is skipped; provider gets 90%, platform 10% |
| On curve | DBC pool exists, `isMigrated = 0` | Slice buys the token on the curve with `swap2` (PartialFill); tokens are held in the model's escrow ATA owned by the keeper. Revenue literally advances the curve toward graduation |
| Graduated | `isMigrated = 1`, DAMM v2 pool known | Slice becomes locked liquidity: escrow tokens are paired with SOL first; once escrow is empty, half the slice is swapped to tokens on DAMM v2 and both sides are added |

### Settlement run, per model and period

The keeper runs at minute 5 of every hour for the period `[H-1:00, H:00)`. One settlement document per `(modelId, periodStart)` is the state machine; each step stores its signature before moving on, so a crashed run resumes at the first incomplete step.

1. Lease: insert the settlement doc with `state: "computing"` (unique index makes a second runner fail fast).
2. Tag and sum: `updateMany` all billable requests in the period with `settlementId: null` → set `settlementId`; then aggregate cost by `settlementId`. Tagging first means a request can never be counted twice.
3. Provider payout: if the provider's accrued amount (this period plus any carry-over) is at least 1 USDC, send one SPL transfer from the treasury USDC account (create the provider's ATA if missing), store the signature; otherwise add to `carryOverMicroUsdc`.
4. Convert the slice: price the slice in SOL using the Jupiter price API at run time, store the rate, and spend from the keeper's SOL float. The float is refilled by an operator runbook in the MVP; a Jupiter swap job replaces that later.
5. Buy and lock, by phase (table above). On curve: `swap2` on the DBC pool; if this buy completes the curve, call `migrateToDammV2` in the same run. Graduated: `getDepositQuote` → `addLiquidity` on the model's keeper position (created once with `createPositionAndAddLiquidity`) → `permanentLockPosition`. Store every signature and the amounts.
6. Compound: claim fees on the keeper position with `claimPositionFee`; add the SOL to this period's slice before step 5 of the next run.
7. Finalize: `state: "done"`, publish the ledger row; the token page shows it within one poll.

Failure handling: each step retries three times with backoff on RPC or blockhash errors; a step that fails three times sets `state: "failed"` with the error and sends an alert. `POST /admin/settlements/:id/retry` resumes from the stored step. A `maxSliceSolPerRun` guard (env) caps what a single run can spend.

### Token holder utility

A consumer who links a wallet holding at least 1,000,000 tokens of a model (0.1% of supply) gets 10% off that model's prices. The balance is read from the RPC on first use and cached for 5 minutes per wallet and mint. Burn-to-credit is an open decision for after the MVP.

## Backend design (Node.js + TypeScript)

The backend is two deployables from one pnpm monorepo: `api` (HTTP, including the inference gateway) and `keeper` (cron jobs that touch the chain). Both share `packages/shared` (types, zod schemas, pricing math) and `packages/chain` (Meteora and Solana helpers). The provider's model is never called by the keeper, and the API never signs with the keeper key.

```text
.
├── apps/
│   ├── api/          Express HTTP API + OpenAI-compatible gateway
│   ├── keeper/       cron worker: pool poller, migration crank, settlement, health checks
│   └── web/          React + Vite (section Frontend)
├── packages/
│   ├── shared/       zod schemas, DTO types, pricing and split math, constants
│   └── chain/        DBC client, DAMM v2 client, tx builder/sender, deposit parser
├── scripts/          create-config.ts, devnet-e2e.ts, refill-float.ts, seed-models.ts
└── .github/workflows/ci.yml
```

| Dependency | Use |
| --- | --- |
| Node 20, TypeScript 5, pnpm workspaces, tsx | Runtime and build |
| express, helmet, cors, express-rate-limit | HTTP, security headers, rate limits |
| mongoose 8 | MongoDB models, indexes, transactions |
| zod | Request validation and shared schemas |
| pino, pino-http | Structured logs with request ids |
| undici | Upstream inference calls with streaming bodies |
| jose, tweetnacl, bs58 | JWT issue/verify, Ed25519 signature checks for sign-in |
| @solana/web3.js, @solana/spl-token | RPC, transactions, USDC transfers, ATAs |
| @meteora-ag/dynamic-bonding-curve-sdk, @meteora-ag/cp-amm-sdk | DBC and DAMM v2 transaction builders and state reads |
| node-cron | Keeper schedules |
| tiktoken | Token counting fallback |

### API modules

| Module | Responsibility | Notes |
| --- | --- | --- |
| auth | Sign-in with Solana: `POST /auth/nonce` issues a nonce, `POST /auth/verify` checks the Ed25519 signature over a fixed message and returns a 24 h JWT | Nonce single-use, 5 min expiry; JWT carries `userId`, `wallet`, `role` |
| apiKeys | Create, list, revoke | Key = `ibt_` + 32 random bytes base58; only its SHA-256 is stored; shown once |
| models | Provider registry, pricing, upstream endpoint, health | Upstream API key encrypted with AES-256-GCM under `MASTER_KEY`; never returned by any endpoint |
| gateway | `POST /v1/chat/completions`, `GET /v1/models` | See flow below |
| billing | Deposits, ledger, balance | Deposit = client submits a tx signature; server verifies it |
| tokens | Launch confirmation, pool state, swap quotes, settlement history | Transactions are built and signed in the browser; the server verifies results on-chain |
| metadata | `GET /metadata/:mint.json` | Metaplex-style JSON: name, symbol, description, image, external\_url, model slug |
| admin | Retry settlement, pause model, float status | Bearer `ADMIN_TOKEN`, IP allow-list |

### Gateway request flow

1. Authenticate: hash the bearer key, load the key and user; reject revoked keys (401).
2. Resolve the model by `body.model` (slug); reject unknown or paused models (404 / 503).
3. Estimate: `max_tokens` (default 1024) × output price + counted prompt tokens × input price. If `balance − activeHolds < estimate`, return 402 with the shortfall.
4. Hold: insert a ledger row `type: "hold"` for the estimate (status `open`).
5. Forward with undici to the provider's `baseUrl + /chat/completions`, replacing `model` with the provider's upstream model name and the auth header with the decrypted upstream key. Streaming responses are piped through unchanged. Timeouts: 30 s to first byte, 300 s total.
6. Settle: on a billable completion compute the actual cost, write `type: "capture"`, close the hold, insert the request document, and set response headers `X-Request-Id`, `X-Cost-Usdc`, `X-Balance-Usdc`. On failure write `type: "release"` and return 502 (upstream error) or 504 (timeout); nothing is billed.

Holder discount: if the user has a linked wallet, read its token balance for the model's mint (cached 5 min) and apply 10% when it is at least 1,000,000 tokens.

### Keeper jobs

| Job | Schedule | What it does |
| --- | --- | --- |
| poolPoller | every 15 s | `getPool` for each active DBC pool; write a snapshot (reserves, price, progress, fees); detect `isMigrated` flips and derive the DAMM v2 pool |
| migrationCrank | inside poolPoller | When the curve is complete and `isMigrated = 0`, send `migrateToDammV2`; record the signature |
| settle | hourly at :05 | The settlement run (section Token lifecycle), models in parallel with a concurrency of 3 |
| healthCheck | every 60 s | One minimal completion per model; store latency and status; three failures pause the model |
| floatMonitor | every 5 min | Alert when keeper SOL falls below `FLOAT_MIN_SOL` or treasury USDC below the next expected payout |

The keeper takes a lease document in MongoDB (`leases`, TTL 90 s, renewed every 30 s) so only one instance runs jobs at a time.

### Error handling and logging

- Every HTTP response carries `X-Request-Id`; logs are JSON lines with `requestId`, `userId`, `modelId`, `route`, `latencyMs`.
- Chain calls go through one `sendAndConfirm` helper: fresh blockhash, `confirmTransaction` with `lastValidBlockHeight`, resend on blockhash expiry, three attempts, never a second send of the same signed transaction after a confirmed signature.
- RPC errors use exponential backoff (500 ms, 2 s, 8 s). Mongo writes inside a settlement step use a session so a step is all-or-nothing.
- Errors are typed (`AppError` with `code`, `httpStatus`, `publicMessage`); the handler returns `{ error: { code, message, requestId } }` and never leaks stack traces or upstream keys.

## Data model (MongoDB)

Eight collections; money is stored as integer micro-USDC (1 USDC = 1,000,000) and lamports, never floats. All on-chain amounts are strings of base units to stay exact above 2^53.

### users

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | ObjectId |  |
| `wallet` | string | Base58 public key, unique |
| `role` | `"consumer"` / `"provider"` / `"admin"` | Providers are consumers too |
| `depositRef` | string | 8-char code the frontend puts in the deposit memo; unique |
| `balanceMicroUsdc` | number | Cached: deposits + adjustments − captures; recomputed from the ledger on mismatch |
| `createdAt`, `lastSeenAt` | Date |  |

### apiKeys

| Field | Type | Notes |
| --- | --- | --- |
| `userId` | ObjectId | ref users |
| `keyHash` | string | SHA-256 of the full key, unique index |
| `prefix` | string | First 12 chars for display |
| `name` | string |  |
| `status` | `"active"` / `"revoked"` |  |
| `lastUsedAt`, `createdAt` | Date |  |

### models

| Field | Type | Notes |
| --- | --- | --- |
| `providerId` | ObjectId | ref users |
| `slug` | string | Unique, used as the `model` name in API calls |
| `name`, `description`, `imageUrl` | string | Shown on the token page and in metadata JSON |
| `upstream.baseUrl` | string | OpenAI-compatible base URL |
| `upstream.modelName` | string | Model name sent upstream |
| `upstream.apiKeyEnc` | string | AES-256-GCM ciphertext, base64 (iv + tag + data) |
| `pricing.inputPerMTokMicroUsdc`, `pricing.outputPerMTokMicroUsdc` | number | Gross prices per million tokens |
| `splits.providerBps`, `splits.liquidityBps`, `splits.platformBps` | number | Sum to 10,000; MVP 7000 / 2000 / 1000 |
| `status` | `"active"` / `"paused"` / `"delisted"` | Health check sets `paused` after 3 failures |
| `health.lastOkAt`, `health.p50LatencyMs`, `health.consecutiveFailures` | mixed |  |
| `token.status` | `"none"` / `"curve"` / `"graduated"` |  |
| `token.mint`, `token.dbcPool`, `token.dammV2Pool` | string | Base58 |
| `token.launchSignature`, `token.migrationSignature` | string |  |
| `token.keeperPosition` | string | DAMM v2 position address, set on first add |
| `token.escrowBaseUnits` | string | Tokens bought on the curve and not yet paired |
| `token.carryOverMicroUsdc` | number | Provider payout below the 1 USDC minimum |
| `stats` | object | Rolling 24 h: requests, successRate, revenueMicroUsdc, lockedLiquiditySol — recomputed by the keeper |

### requests

| Field | Type | Notes |
| --- | --- | --- |
| `userId`, `apiKeyId`, `modelId` | ObjectId |  |
| `requestId` | string | Equals the `X-Request-Id` header; unique |
| `idempotencyKey` | string | Optional, unique per user within 24 h (partial index) |
| `status` | `"success"` / `"upstream_error"` / `"timeout"` / `"client_abort"` | Only `success` is billable |
| `promptTokens`, `completionTokens`, `usageEstimated` | number, boolean |  |
| `costMicroUsdc`, `discountBps` | number | After discount |
| `latencyMs`, `streamed`, `upstreamStatus` | number, boolean, number |  |
| `settlementId` | ObjectId or null | Set by the settlement run; indexed with `modelId` and `createdAt` |
| `createdAt` | Date | TTL 90 days |

### ledger

| Field | Type | Notes |
| --- | --- | --- |
| `userId` | ObjectId |  |
| `type` | `"deposit"` / `"hold"` / `"capture"` / `"release"` / `"adjust"` |  |
| `amountMicroUsdc` | number | Signed from the user's point of view |
| `ref.txSignature` / `ref.requestId` / `ref.holdId` | string | One of them set |
| `balanceAfterMicroUsdc` | number | Snapshot for audit |
| `createdAt` | Date | Index `(userId, createdAt)` |

### deposits

| Field | Type | Notes |
| --- | --- | --- |
| `userId` | ObjectId |  |
| `txSignature` | string | Unique index: a signature can credit once |
| `amountMicroUsdc` | number | Parsed from the SPL transfer |
| `slot`, `verifiedAt` | number, Date | Commitment `finalized` |
| `status` | `"credited"` / `"rejected"` | Rejected rows keep the reason |

### settlements

| Field | Type | Notes |
| --- | --- | --- |
| `modelId`, `periodStart`, `periodEnd` | ObjectId, Date, Date | Unique index `(modelId, periodStart)` |
| `state` | `"computing"` / `"paid_provider"` / `"converted"` / `"bought"` / `"locked"` / `"done"` / `"failed"` | Linear state machine |
| `revenueMicroUsdc`, `requestCount` | number |  |
| `provider.amountMicroUsdc`, `provider.txSignature` | number, string |  |
| `liquidity.sliceMicroUsdc`, `liquidity.solLamports`, `liquidity.solPriceUsdc`, `liquidity.phase` | mixed | Rate recorded at run time |
| `liquidity.buyTxSignature`, `liquidity.tokensBaseUnits`, `liquidity.addTxSignature`, `liquidity.lockTxSignature` | string | Filled step by step |
| `platformMicroUsdc` | number |  |
| `attempts`, `error`, `updatedAt` | number, string, Date |  |

### poolSnapshots

| Field | Type | Notes |
| --- | --- | --- |
| `modelId`, `pool` | ObjectId, string |  |
| `ts` | Date | TTL 30 days; index `(modelId, ts)` |
| `quoteReserve`, `baseReserve`, `sqrtPrice` | string | Base units |
| `progress` | number | 0–1 on the curve; 1 after migration |
| `priceSolPerToken` | number | Derived for charts |
| `totalTradingQuoteFee` | string | From pool metrics |
| `isMigrated` | boolean |  |

### Invariants

- `users.balanceMicroUsdc` equals the ledger sum; a nightly job recomputes and logs any drift.
- A request is billable exactly once: `status = success` and `settlementId` assigned by exactly one settlement.
- `deposits.txSignature` and `settlements (modelId, periodStart)` are unique, so retries cannot double-credit or double-pay.
- Every settlement in `done` has either a provider signature or a carry-over, and either liquidity signatures or `phase: "none"`.

## API reference

Two surfaces on one host: the inference gateway under `/v1` (bearer API key, OpenAI-compatible so existing SDKs work by changing `baseURL`) and the platform API under `/api` (JWT from wallet sign-in). All responses are JSON except streamed completions.

### Endpoints

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/chat/completions` | API key | Inference; body as OpenAI, `model` = model slug |
| `GET /v1/models` | API key | Active models with prices |
| `POST /api/auth/nonce` | none | `{wallet}` → `{nonce, message}` |
| `POST /api/auth/verify` | none | `{wallet, signature}` → `{token, user}` |
| `GET /api/me` | JWT | Profile, balance, deposit reference |
| `GET /api/keys`, `POST /api/keys`, `DELETE /api/keys/:id` | JWT | API key management; `POST` returns the full key once |
| `GET /api/models`, `GET /api/models/:slug` | none | Public registry, stats, token state |
| `POST /api/models` | JWT | Register a model (provider becomes `role: provider`) |
| `PATCH /api/models/:id` | JWT, owner | Pricing, description, upstream |
| `POST /api/models/:id/health-check` | JWT, owner | Run one check now |
| `POST /api/billing/deposits` | JWT | `{txSignature}` → verify and credit |
| `GET /api/billing/ledger?cursor=` | JWT | Paginated ledger |
| `GET /api/billing/usage?from=&to=` | JWT | Requests and cost per model per day |
| `POST /api/tokens/launch/confirm` | JWT, owner | `{modelId, mint, signature}` → verifies the pool on-chain, stores it |
| `GET /api/tokens/:mint/state` | none | Latest snapshot: phase, progress, price, reserves, pools |
| `GET /api/tokens/:mint/quote?side=buy&amount=` | none | Server-side quote mirror for display; the browser builds the real transaction |
| `GET /api/tokens/:mint/settlements?cursor=` | none | Public settlement ledger |
| `GET /metadata/:mint.json` | none | Token metadata |
| `POST /api/admin/settlements/:id/retry`, `POST /api/admin/models/:id/pause`, `GET /api/admin/float` | admin token | Operations |

### Inference call

Request: identical to OpenAI's chat completions (`messages`, `max_tokens`, `temperature`, `stream`, `tools` passed through). Optional headers: `Idempotency-Key`, `X-Request-Id` (echoed if supplied, generated otherwise).

```json
POST /v1/chat/completions
Authorization: Bearer ibt_3f9...
{"model": "llama-3.1-8b-fast", "messages": [{"role": "user", "content": "Hello"}], "max_tokens": 256, "stream": false}
```

Response: the upstream body unchanged, plus headers `X-Request-Id`, `X-Cost-Usdc` (decimal string), `X-Balance-Usdc`, `X-Discount-Bps`. Streaming responses are `text/event-stream` passed through; the cost headers are sent before the first chunk as a hold estimate and the final cost is available from `GET /api/billing/usage`.

| Status | `error.code` | Billed? | When |
| --- | --- | --- | --- |
| 400 | `invalid_request` | no | Body fails the zod schema |
| 401 | `invalid_api_key` | no | Missing, unknown or revoked key |
| 402 | `insufficient_credits` | no | Balance below the hold estimate; body includes `shortfallUsdc` |
| 404 | `model_not_found` | no | Unknown slug |
| 429 | `rate_limited` | no | More than 60 requests/min per key (default) |
| 502 | `upstream_error` | no | Provider returned non-2xx or malformed body |
| 503 | `model_paused` | no | Health check paused the model |
| 504 | `upstream_timeout` | no | First byte after 30 s or stream after 300 s |

### Platform examples

Deposit confirmation:

```json
POST /api/billing/deposits
{"txSignature": "5Yx..."}
→ 200 {"credited": true, "amountUsdc": "25.000000", "balanceUsdc": "31.420000"}
→ 409 {"error": {"code": "deposit_already_credited"}}
→ 422 {"error": {"code": "deposit_invalid", "message": "memo does not match depositRef"}}
```

Launch confirmation:

```json
POST /api/tokens/launch/confirm
{"modelId": "66f1...", "mint": "9xQe...", "signature": "3kLm..."}
→ 200 {"token": {"status": "curve", "mint": "9xQe...", "dbcPool": "7Hn2...", "progress": 0}}
→ 422 {"error": {"code": "pool_mismatch", "message": "pool creator is not the model owner"}}
```

Token state:

```json
GET /api/tokens/9xQe.../state
→ 200 {"phase": "curve", "progress": 0.42, "quoteReserveSol": "4.2", "priceSolPerToken": "0.0000000061",
        "dbcPool": "7Hn2...", "dammV2Pool": null, "lockedLiquiditySol": "0.8", "stats": {"requests24h": 1180, "successRate": 0.992, "revenueUsdc24h": "14.30"}}
```

All list endpoints page with `cursor` (opaque) and `limit` (max 100). Platform errors share the gateway envelope `{error: {code, message, requestId}}`.

## Frontend design (React + Vite + TypeScript)

The web app is a Vite single-page app that talks to the API for data and to the chain directly for anything that needs a signature: launches, curve and DAMM v2 swaps, USDC deposits. Meteora's fun-launch scaffold is Next.js, so it is used only as a reference for curve-progress and trade UI patterns, not as the base.

| Dependency | Use |
| --- | --- |
| react 18, react-router 6, typescript 5, vite 5 | App shell and routing |
| @tanstack/react-query | Server state, polling, cache invalidation after transactions |
| @solana/wallet-adapter-react, -react-ui, -wallets (Phantom, Solflare, Backpack) | Wallet connection and signing |
| @solana/web3.js, @solana/spl-token | Transactions, USDC transfer, ATAs |
| @meteora-ag/dynamic-bonding-curve-sdk, @meteora-ag/cp-amm-sdk | Quotes and transaction builders in the browser |
| vite-plugin-node-polyfills | `Buffer` and `process` polyfills the Solana libraries expect |
| zod | Form and API response validation (schemas from `packages/shared`) |
| tailwindcss | Styling |
| lightweight-charts | Price and curve-progress charts from `poolSnapshots` |

### Routes

| Route | Page | Main content |
| --- | --- | --- |
| `/` | Explore | Model cards: price per million tokens, 24 h requests, success rate, token phase and progress |
| `/models/:slug` | Token page | Curve progress or DAMM v2 price chart, trade panel, live model stats, settlement ledger, Claim fees (owner only) |
| `/launch` | Launch wizard | Register model → health check → set prices → launch token (sign) |
| `/dashboard` | Consumer | API keys, balance, deposit USDC, usage by model, quickstart snippet |
| `/provider` | Provider | Models, earnings, payouts received, claimable fees, pause/resume |
| `/docs` | API quickstart | `baseURL` swap instructions for the OpenAI SDK, curl examples |

### Key components

| Component | Responsibility |
| --- | --- |
| `WalletGate` | Wraps protected routes; triggers nonce → sign → verify and stores the JWT in memory (not localStorage) |
| `DepositUsdc` | Builds an SPL transfer of USDC to the treasury ATA with a memo = `depositRef`, sends it, then `POST /api/billing/deposits` with the signature; shows pending → credited |
| `TradePanel` | Buy/sell. Curve phase: `swapQuote2` + `swap2` from the DBC SDK. Graduated: `getQuote2` + `swap2` from cp-amm-sdk. Slippage selector, price impact, min received |
| `CurveProgress` | Progress bar and SOL raised vs 10 SOL threshold, polled every 10 s from `/api/tokens/:mint/state` |
| `ModelStats` | Requests, success rate, revenue, locked liquidity — the token's fundamentals |
| `SettlementTable` | Public ledger rows with Solscan links for every signature |
| `LaunchWizard` | Four steps; the launch step generates the mint keypair, builds `createPool`, signs with wallet + mint, sends, then confirms with the API |
| `ApiKeyManager` | Create/revoke; shows the full key once with a copy button |
| `ClaimFees` | Builds `claimCreatorTradingFee` or `claimPartnerTradingFee` plus `claimPositionFee` transactions for the connected wallet |

### Data and transaction patterns

- React Query keys: `['model', slug]`, `['tokenState', mint]` (refetch 10 s), `['me']`, `['ledger']`, `['settlements', mint]` (refetch 60 s).
- Every transaction follows one hook, `useSendTx`: build → `simulateTransaction` → sign → send → confirm with `lastValidBlockHeight` → call the matching confirm endpoint → invalidate queries. Errors map wallet rejections, slippage failures and blockhash expiry to plain messages.
- Amounts are formatted from base units with the token's decimals; no float math on amounts.
- Public pages render without a wallet; the wallet is requested only on an action.

Environment: `VITE_API_URL`, `VITE_RPC_URL`, `VITE_CLUSTER` (`devnet` or `mainnet-beta`), `VITE_DBC_CONFIG`, `VITE_USDC_MINT`, `VITE_TREASURY_USDC_ATA`. Build with `vite build`; output is static and deploys to Vercel.

## Security, key management and reliability

The system holds three kinds of secrets, two hot wallets and other people's money; the controls below are the minimum for a mainnet launch, not a later hardening pass.

| Threat | Control |
| --- | --- |
| Keeper or treasury key leak | Keys live only in the hosting platform's secret store, loaded from env at boot, never in the repo or `.env` files committed. Treasury (fee claimer, USDC balance) is a separate wallet from the keeper; the keeper holds only its SOL float plus one period of USDC. Rotate by creating a new keeper, moving the float, updating env, revoking the old one |
| Provider upstream key leak | AES-256-GCM with a per-row IV under `MASTER_KEY`; decrypted only inside the gateway request; never logged; `PATCH` replaces, no endpoint reads it back |
| Stolen API key | Only the SHA-256 is stored; 60 req/min per key; per-key spend cap per day (default 50 USDC) set by the user; revoke is immediate |
| Sign-in replay | Nonce is random, single-use, expires in 5 min; the signed message includes domain, nonce and issued-at; JWT lives in memory, 24 h, HS256 under `JWT_SECRET` |
| Fake or replayed deposit | Server fetches the transaction at `finalized`, checks: success, SPL transfer instruction, mint = USDC, destination = treasury ATA, memo = the user's `depositRef`; `txSignature` unique index; amount taken from the parsed instruction, not the client |
| Overdraft by concurrent requests | Hold-then-capture ledger: a hold is written before the upstream call; balance checks subtract open holds; holds expire after 10 min if never captured |
| Keeper double-spend or double-pay | One settlement document per `(modelId, periodStart)` with a unique index; signatures stored per step; resumable state machine; single-runner lease; `maxSliceSolPerRun` and `maxPayoutUsdcPerRun` caps |
| Prompt abuse and cost blowups | Body limit 1 MB; `max_tokens` capped at 8192; request timeouts; health checks pause a model after three failures |
| Web attack surface | helmet headers, strict CORS to the web origin, rate limits on auth and deposit endpoints, no cookies (bearer only), admin routes behind a separate token and IP allow-list |
| Wrong config or pool | The API accepts a launch only if the on-chain pool's `config` equals ours and `creator` equals the model owner; the frontend hard-codes the config key per environment |
| RPC outage | All reads go through a small RPC client with retries and a secondary RPC URL; the gateway keeps serving (it does not depend on the chain); settlement waits and retries next hour |

### Monitoring and alerts

- Health endpoints: `GET /healthz` (process) and `GET /readyz` (Mongo + RPC reachable).
- Alerts to a Telegram bot: settlement `failed`, keeper float below `FLOAT_MIN_SOL`, treasury USDC below next payout, model paused, deposit rejected more than 5 times in an hour, 5xx rate above 2% over 5 min.
- Daily reconciliation job: ledger sum vs cached balances, settlements vs on-chain signatures (each signature re-fetched and checked for success).

### Product and legal framing

All copy describes the token as access and utility (discounts, a public market for a model's demand) and the liquidity lock as a mechanism, never as a return. Payouts are to the provider for services rendered. This is not legal advice; confirm the framing with counsel before scaling beyond the hackathon.

## Deployment and environments

Three environments, one codebase: local and staging run against Solana devnet with a devnet config key; production runs against mainnet with its own config key. Nothing in code branches on cluster except the addresses loaded from env.

| Environment | Cluster | Web | API + keeper | MongoDB | RPC |
| --- | --- | --- | --- | --- | --- |
| local | devnet | `vite dev` on :5173 | `tsx watch` on :4000 and :4001 | Docker `mongo:7` or Atlas M0 | Helius devnet |
| staging | devnet | Vercel preview | Railway (two services) | Atlas M0 | Helius devnet |
| production | mainnet-beta | Vercel | Railway (two services, 1 GB each) | Atlas M10 with daily backups | Helius mainnet, secondary public RPC |

Railway, Render or Fly all work; the api and keeper are two services built from the same Dockerfile with different start commands (`node apps/api/dist/main.js`, `node apps/keeper/dist/main.js`). The keeper runs as exactly one replica.

### Environment variables

| Variable | Used by | Example / note |
| --- | --- | --- |
| `CLUSTER` | api, keeper | `devnet` or `mainnet-beta` |
| `RPC_URL`, `RPC_URL_FALLBACK` | api, keeper | Helius URL with key; public RPC as fallback |
| `MONGODB_URI` | api, keeper | Atlas SRV string |
| `JWT_SECRET`, `MASTER_KEY`, `ADMIN_TOKEN` | api | 32 random bytes each, base64 |
| `TREASURY_WALLET` | api, keeper | Public key; fee claimer and USDC holder |
| `TREASURY_SECRET_KEY` | keeper | Only the keeper signs USDC payouts |
| `KEEPER_SECRET_KEY` | keeper | SOL float, buybacks, locks, migration cranks |
| `USDC_MINT` | api, keeper, web | devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `DBC_CONFIG` | api, keeper, web | Config public key from `create-config.ts` |
| `DAMM_V2_FEE_CONFIG` | keeper | `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp` |
| `SETTLEMENT_CRON`, `MAX_SLICE_SOL_PER_RUN`, `MAX_PAYOUT_USDC_PER_RUN`, `FLOAT_MIN_SOL` | keeper | `5 * * * *`, `2`, `500`, `0.5` |
| `WEB_ORIGIN`, `PORT` | api | CORS origin, listen port |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | keeper, api | Alerts |
| `VITE_*` | web | See Frontend design |

### CI/CD

GitHub Actions on every push: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Merges to `main` deploy automatically: Vercel builds `apps/web`; Railway builds the Dockerfile and restarts both services. Devnet end-to-end (`scripts/devnet-e2e.ts`) runs nightly, not on every push, because it spends devnet SOL and takes about 10 minutes.

### Runbooks

1. Create a config: fund the treasury, run `pnpm tsx scripts/create-config.ts --cluster devnet`, paste the printed config key into the env of all three apps, repeat for mainnet.
2. Launch the first model: register via the UI with the treasury's own wallet as provider, run a health check, launch; buy 0.1 SOL to verify quotes and progress.
3. Refill the keeper float: send SOL from the treasury to the keeper; confirm `GET /api/admin/float` is above `FLOAT_MIN_SOL`.
4. Retry a failed settlement: read the error in the settlement document, fix the cause (float, RPC), `POST /api/admin/settlements/:id/retry`.
5. Rotate the keeper key: create a new keypair, transfer float and token escrow balances, update `KEEPER_SECRET_KEY`, restart, then empty and retire the old key.
6. Devnet migration drill: launch on devnet, buy to 1 SOL, confirm the keeper's `migrateToDammV2` signature and the DAMM v2 pool address within one minute; if the crank fails, use the manual migrator and investigate.

## Testing and QA

The money paths (billing ledger, settlement state machine, deposit verification) get the deepest tests; the chain path gets one scripted devnet rehearsal that must pass before any mainnet action.

| Level | Tooling | What is covered |
| --- | --- | --- |
| Unit | vitest in `packages/shared` and `apps/*` | Pricing math at the micro-USDC boundary; split rounding (remainder goes to the platform share); hold/capture/release transitions; deposit instruction parser against recorded transactions; config builder output matches the committed snapshot |
| Integration | vitest + supertest + mongodb-memory-server + a mock OpenAI-compatible upstream | Gateway happy path, streaming pass-through with `[DONE]`, upstream 500 (no bill), timeout (release), 402 on low balance, idempotency replay, discount application, revoked key |
| Settlement | vitest with a fake chain client | Each state transition; crash after every step then resume; carry-over below 1 USDC; `maxSliceSolPerRun` cap; phase switch curve → graduated mid-run |
| Chain end-to-end | `scripts/devnet-e2e.ts` on devnet | Create config → launch → three buys → keeper settlement on curve → buy to threshold → keeper migration → settlement after graduation → assert the keeper position is permanently locked and fees are claimable |
| Load | autocannon, 50 req/s for 60 s against the gateway with the mock upstream | p95 latency overhead under 50 ms, zero negative balances, zero duplicate captures |
| Frontend | vitest + React Testing Library; Playwright smoke on staging | Trade panel quote rendering, deposit flow states, launch wizard validation; smoke: connect wallet, deposit, call API with the new key |

### Acceptance checklist before mainnet

- [ ] Devnet end-to-end script passes twice in a row
- [ ] A real OpenAI SDK call succeeds with only `baseURL` and `apiKey` changed
- [ ] A deposit with the wrong memo is rejected and logged
- [ ] Killing the keeper mid-settlement and restarting completes the same settlement with no extra payment
- [ ] Settlement rows on the token page link to confirmed signatures
- [ ] Provider can claim creator fees and position fees from the dashboard
- [ ] Alerts fire for a forced settlement failure and a low float

## Delivery plan (11 days)

The MVP ships in five phases from Oct 1 to Oct 12, each closed by a gate that must pass before the next phase starts; the Superteam sidetrack closes Oct 13, 2026 at 06:59 UTC (12:29 IST). Budget: about 5 hours on weekdays and 10 on weekend days, 60–70 hours in total, so the cut list below is part of the plan, not a fallback.

&#91;embedded content: delivery roadmap · 5 phases, 5 gates\]

A gate that slips by more than a day does not block the next phase: the slipped item moves to the cut list. If the Chain or Gateway gate has not passed by Oct 5, switch to the DBC backtester fallback discussed earlier.

### In scope for the MVP

- One launch class (the config above), no config wizard
- Prepaid USDC credits only; no subscriptions, no burn-to-credit
- One listed model at mainnet launch (two or three if time allows), run by the platform wallet as provider
- Hourly settlement with the fixed 70/20/10 split; manual float refill
- Pool state by polling; no swap-level indexer or holder counts
- Provider dashboard with claims only; everything else by scripts

### Cut if behind schedule

- [ ] Holder discount (ship pricing without it)
- [ ] Streaming support in the gateway (non-streaming first)
- [ ] Price chart on the token page (progress bar only)
- [ ] Idempotency keys
- [ ] Telegram alerts (logs only)

### Submission checklist

- [ ] Public GitHub repo, or private with `dannxbt` added as reader
- [ ] README: what it is, how the Meteora stack is used, how to run it, mainnet addresses (config, pools, DAMM v2 pools, keeper positions)
- [ ] Architecture section with the diagram from this doc
- [ ] 3-minute demo video: launch → curve buy → API call → settlement row → locked liquidity on Solscan
- [ ] Live URL with at least one mainnet model and real settlements
- [ ] Submit on Superteam Earn (Meteora DBC sidetrack) and on Colosseum (Solana track) before the deadline

## Appendix

### References

| Resource | Link |
| --- | --- |
| DBC developer guide (program IDs, keepers, fee config keys) | [docs.meteora.ag/developer-guides/dbc](https://docs.meteora.ag/developer-guides/dbc) |
| DBC TypeScript SDK functions (createConfig, buildCurve, createPool, swap2, migrateToDammV2, claims) | [SDK functions](https://docs.meteora.ag/developer-guide/guides/dbc/typescript-sdk/sdk-functions.md) |
| DBC program and SDK repos | [dynamic-bonding-curve](https://github.com/MeteoraAg/dynamic-bonding-curve), [dynamic-bonding-curve-sdk](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk) |
| DAMM v2 developer guide and SDK reference | [developer-guides/damm-v2](https://docs.meteora.ag/developer-guides/damm-v2), [SDK reference](https://docs.meteora.ag/developer-guides/damm-v2/typescript-sdk/reference), [damm-v2-sdk](https://github.com/MeteoraAg/damm-v2-sdk) |
| Invent CLI (config, pool, swap, migrate commands) | [docs.meteora.ag/invent/actions](https://docs.meteora.ag/invent/actions), [meteora-invent](https://github.com/MeteoraAg/meteora-invent) |
| fun-launch scaffold (UI reference only; Next.js) | [scaffold guide](https://docs.meteora.ag/invent/scaffold/fun-launch) |
| Agent skill and llms.txt for coding assistants | [agents/skill](https://docs.meteora.ag/agents/skill), [llms-txt](https://docs.meteora.ag/agents/llms-txt), [docs MCP](https://docs.meteora.ag/mcp) |
| Manual migrator (mainnet and devnet) | [migrator.meteora.ag](https://migrator.meteora.ag) |
| Hackathon listing and main hackathon | [Superteam Earn: Best use of Meteora DBC](https://superteam.fun/earn/listing/meteora-dbc), [Colosseum Crypto World's Fair](https://colosseum.com/worldsfair) |
| Developer support | Discord dev channel and Telegram `meteora_dev` as given in the brief |

### Addresses

| Item | Devnet | Mainnet |
| --- | --- | --- |
| DBC program | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | same |
| DAMM v2 program | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | same |
| DAMM v2 fee config, 100 bps | `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp` | same |
| Wrapped SOL mint | `So11111111111111111111111111111111111111112` | same |
| USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Platform DBC config | filled by `create-config.ts` | filled by `create-config.ts` |
| Treasury and keeper wallets | filled at setup | filled at setup |

### Open decisions

| Decision | Current default | Status |
| --- | --- | --- |
| Project and token naming | "Inference-Backed Tokens", symbols chosen by providers | Open |
| Provider token allocation via locked vesting | None | Open; add a launch class with 5% vested over 6 months after the MVP |
| Burn-to-credit (redeem tokens for inference) | Not in MVP; holder discount instead | Open |
| Revenue split per launch class | 70 / 20 / 10 | Confirm |
| Multiple launch classes (thresholds other than 10 SOL) | One class | Later; needs our own migration crank for thresholds Meteora's keepers do not cover |
| Float refill via Jupiter swap job | Manual runbook | After MVP |
| Swap-level indexer (Helius webhooks) for volume and holders | Polling only | After MVP |
| DLMM use (conviction pools) | Not used | Idea for the pitch, not the MVP |
