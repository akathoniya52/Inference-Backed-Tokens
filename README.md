# Inference-Backed Tokens

Inference-Backed Tokens pairs every AI model listed on an OpenAI-compatible inference gateway with a token launched on Meteora's Dynamic Bonding Curve (DBC). Consumers pay for inference in USDC; every hour a keeper splits each model's revenue between the provider, the platform and a liquidity slice, and the liquidity slice buys the model's token on the curve or, after graduation, adds DAMM v2 liquidity that is permanently locked. The token's market follows measured demand for the model (requests, success rate, revenue, liquidity locked) rather than hype.

The project is built for the [Best use of Meteora's DBC](https://superteam.fun/earn/listing/meteora-dbc) sidetrack on Superteam Earn, part of [Colosseum's Crypto World's Fair](https://colosseum.com/worldsfair); the same build is submitted to Colosseum's Solana track. Submissions close **2026-10-13 06:59 UTC**. The design spec is [`Plan.md`](Plan.md) and the build plan is [`.sisyphus/plans/inference-backed-tokens.md`](.sisyphus/plans/inference-backed-tokens.md).

**Demo video:** _placeholder, recorded in H12 (3 minutes: launch → curve buy → API call → settlement row → locked liquidity on Solscan)._
**Live URL:** _placeholder, filled in H12._

## Architecture

Three deployables (web, api, keeper), one MongoDB replica set and two Meteora programs. The browser signs every user transaction with the user's own wallet; the api meters inference and only reads the chain; the keeper holds the only hot keys and is the single component that moves money.

```text
                         ┌──────────────────────────────┐
   wallet (Phantom,      │  apps/web  (Vite + React)    │  builds createPool / swap2 / deposit /
   Solflare) signs ─────▶│  :5173                       │  claim txs with the Meteora SDKs
                         └───────┬──────────────┬───────┘
                       REST + JWT│              │ signed txs
                                 ▼              ▼
┌────────────────────┐   ┌───────────────┐   ┌────────────────────────────────────────┐
│ apps/mock-upstream │◀──│ apps/api      │   │ Solana (devnet / mainnet-beta)         │
│ :4010 (local dev,  │   │ :4000         │rd │  DBC  dbcij3LW…  config, pools, curve  │
│ tests, load)       │   │ gateway /v1,  │──▶│  DAMM v2  cpamdpZC…  pools, positions  │
│ or a real OpenAI-  │   │ auth, billing,│   │  USDC deposits to the treasury ATA     │
│ compatible upstream│   │ launch verify │   └───────────────▲────────────────────────┘
└────────────────────┘   └──────┬────────┘                   │ payouts, buys, add+lock,
                                │                            │ migration crank
                                ▼                            │
                         ┌───────────────┐   ┌───────────────┴──────┐
                         │ MongoDB rs0   │◀──│ apps/keeper  :4001   │
                         │ users, ledger,│   │ hourly settlement,   │
                         │ models, ...   │   │ pool poller, health, │
                         └───────────────┘   │ float monitor        │
                                             └──────────────────────┘
```

| Path                 | What it is                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`           | Explore, token page (`/t/:slug`), launch wizard, dashboard (API keys, USDC deposit), provider page (claim fees, pause/resume), docs                                                                                                                                                                                                                                                     |
| `apps/api`           | Express 5: wallet sign-in, API keys, OpenAI-compatible `/v1/chat/completions` (non-streaming and streaming, idempotency keys, holder discount) and `/v1/models` (per-key rate limit and daily cap), USDC deposits and ledger, model registry and health checks, token launch prepare/confirm, token state/quote/settlements/snapshots, token metadata, admin endpoints (`/api/admin/*`) |
| `apps/keeper`        | Lease-guarded jobs: hourly settlement (`tagAndSum → split → payProvider → convert → buyAndLock → compound → finalize`, retried and resumable), DBC pool poller and migration crank, health-check trigger, float monitor, hold expiry, stats, nightly reconciliation                                                                                                                     |
| `apps/mock-upstream` | Deterministic OpenAI-compatible upstream (`mock-key`) for local runs, tests and the load test                                                                                                                                                                                                                                                                                           |
| `packages/shared`    | Browser-safe constants, money math (BigInt), revenue split, zod schemas, errors; `@ibt/shared/node` adds crypto, logger, env parsing                                                                                                                                                                                                                                                    |
| `packages/db`        | The only mongoose dependency: models, transactions and the ledger service (`hold`, `capture`, `release`, `credit`, `adjust`)                                                                                                                                                                                                                                                            |
| `packages/chain`     | Meteora and Solana wrappers, `RealChainClient`, the in-memory `FakeChainClient` (`@ibt/chain/testing`) and price sources                                                                                                                                                                                                                                                                |
| `scripts`            | Operator and dev scripts: `create-config`, `refill-float`, `seed-models`, `dev-signin`, `devnet-e2e`, `smoke-local`                                                                                                                                                                                                                                                                     |

## How the Meteora stack is used

| Step                                                                                                                                              | Meteora call                                                                           | Where                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Platform partner config (1 SOL threshold on devnet, 10 SOL on mainnet; 50% creator trading fee; migration to DAMM v2 with the 100 bps fee config) | DBC `buildCurve` + `client.partner.createConfig`                                       | `packages/chain/src/config.ts` (`buildPartnerConfigParams`, `buildCreateConfigTx`), run by `scripts/create-config.ts`               |
| Token launch, signed by the provider's wallet                                                                                                     | DBC `client.creator.createPool`                                                        | `apps/web/src/lib/launch.ts`; verified server-side by `verifyLaunch` in `packages/chain/src/dbc.ts`                                 |
| Curve trading (web) and keeper curve buys                                                                                                         | DBC `swapQuote2` / `swap2` (`SwapMode.PartialFill` for the keeper)                     | `apps/web/src/lib/trade.ts`, `packages/chain/src/dbc.ts` (`quoteBuy`, `buildCurveBuyTx`)                                            |
| Graduation crank                                                                                                                                  | DBC `client.migration.migrateToDammV2` (both position NFT keypairs co-sign)            | `packages/chain/src/dbc.ts` (`buildMigrateTx`), `RealChainClient.migrate`, keeper pool poller                                       |
| Keeper liquidity after graduation                                                                                                                 | DAMM v2 `createPositionAndAddLiquidity` / `addLiquidity`, then `permanentLockPosition` | `packages/chain/src/damm.ts` (`buildCreatePositionAndAdd`, `buildAddLiquidity`, `buildPermanentLock`), `RealChainClient.addAndLock` |
| DAMM v2 swaps (keeper half-swap, web trade panel)                                                                                                 | DAMM v2 `getQuote2` / `swap2`                                                          | `packages/chain/src/damm.ts` (`buildSwap`), `apps/web/src/lib/trade.ts`                                                             |
| Fee claims                                                                                                                                        | DBC `claimPartnerTradingFee` / `claimCreatorTradingFee`; DAMM v2 `claimPositionFee`    | `apps/web/src/lib/claims.ts`, `packages/chain/src/damm.ts` (`buildClaimPositionFee`)                                                |
| Pool reads                                                                                                                                        | DBC `getPool` / `getPoolConfig` / `getPoolFeeMetrics`; DAMM v2 `fetchPoolState`        | `packages/chain/src/dbc.ts`, `packages/chain/src/damm.ts`                                                                           |

`scripts/devnet-e2e.ts` exercises the whole chain path on devnet: `createConfig` → `createPool` → three buys → settlement on the curve → buys to the threshold → `migrateToDammV2` → settlement after graduation → asserts the keeper position is permanently locked and that `claimPositionFee` simulates.

## Run it locally

Requires Node 20 (`.nvmrc`), Docker, and pnpm through corepack. The sequence below is the definition of done (work plan §9). `pnpm smoke:local` automates the whole happy path: with only `docker compose up -d mongo` running it starts its own mock and api (4010/4000, or a free port when those are busy; `SMOKE_API_PORT`/`SMOKE_MOCK_PORT`), signs in, seeds, calls the gateway, runs the keeper settlement for that hour, checks the ledger and the fake chain, prints `SMOKE OK`, and drops its `ibt_smoke_<ts>` database unless `SMOKE_KEEP_DB=1`. `pnpm load` runs the gateway load test the same way on ports 4200/4210: 60 keys, 50 req/s for 60 s against the api and then directly against the mock, and fails unless overhead p95 < 50 ms, every response is 2xx and the ledger has no negative balance, duplicate capture, stuck hold or drift (`LOAD_DURATION_S`, `LOAD_RATE`, `LOAD_CONNECTIONS`, `LOAD_USERS`, `LOAD_MAX_OVERHEAD_P95_MS`, `LOAD_KEEP_DB`). Both refuse `CLUSTER=mainnet-beta` and non-localhost Mongo hosts.

```bash
git clone <repo> ibt && cd ibt && corepack enable
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build
docker build -t ibt .
docker compose up -d mongo
cp apps/api/.env.example apps/api/.env && cp apps/keeper/.env.example apps/keeper/.env   # localhost MONGODB_URI, CLUSTER=devnet; then made local-ready by the sed line
K=11111111111111111111111111111111; sed -i.bak -e 's/^CHAIN_MODE=real/CHAIN_MODE=fake/' -e "s|^DBC_CONFIG=.*|DBC_CONFIG=$K|" -e "s|^TREASURY_WALLET=.*|TREASURY_WALLET=$K|" -e "s|^KEEPER_WALLET=.*|KEEPER_WALLET=$K|" -e "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 32)|" -e "s|^MASTER_KEY=.*|MASTER_KEY=$(openssl rand -base64 32)|" -e "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$(openssl rand -base64 32)|" apps/api/.env
pnpm --filter @ibt/mock-upstream start &                      # :4010
(cd apps/api && node --env-file=.env dist/main.js) &          # :4000; nothing loads .env implicitly
eval "$(pnpm --silent exec tsx --env-file=apps/api/.env scripts/dev-signin.ts --export)"   # ephemeral nacl keypair → WALLET, JWT (pnpm 12 rejects `-s` before the command)
pnpm tsx --env-file=apps/api/.env scripts/seed-models.ts --owner $WALLET --fake-token --dev-credit $WALLET 10   # also seeds fake SOL price
KEY=$(curl -s -XPOST http://localhost:4000/api/keys -H 'Content-Type: application/json' -H "Authorization: Bearer $JWT" -d '{"name":"dev"}' | jq -r .key)
curl -si http://localhost:4000/v1/chat/completions -H 'Content-Type: application/json' -H "Authorization: Bearer $KEY" \
  -d '{"model":"mock-llm","messages":[{"role":"user","content":"Hello"}],"max_tokens":64}'
#   → 200, X-Cost-Usdc, X-Balance-Usdc < 10.000000
curl -s "http://localhost:4000/api/billing/ledger" -H "Authorization: Bearer $JWT"   # hold(captured) + capture rows
pnpm --filter @ibt/keeper settle:once --chain fake --period-start "$(date -u +%Y-%m-%dT%H:00:00Z)"   # no `--`: pnpm forwards it and parseArgs then ignores the flags
#   → state "done", provider carry-over (<1 USDC), liquidity buy signature from the fake chain (slice > 0 thanks to seeded price)
pnpm --filter @ibt/web build
kill %1 %2          # stop mock and api so smoke:local can start its own on the same ports
pnpm smoke:local    # automates all of the above → "SMOKE OK"
```

Notes:

- `apps/api/.env` does not start as copied (the `sed` line above fixes it): set `CHAIN_MODE=fake`, the `replace-me` secrets `JWT_SECRET`, `MASTER_KEY` and `ADMIN_TOKEN` (`openssl rand -base64 32` each), and `DBC_CONFIG`, `TREASURY_WALLET` and `KEEPER_WALLET` to any base58 public key (e.g. `11111111111111111111111111111111`). `apps/keeper/.env` runs `settle:once --chain fake` as copied (in fake mode an unparseable keeper or treasury key becomes a throwaway keypair); for the long-running keeper also set `CHAIN_MODE=fake` and the api's `ADMIN_TOKEN`. `CHAIN_MODE=fake` and the `seed-models` flags `--dev-credit` / `--fake-token` refuse `CLUSTER=mainnet-beta` and any `MONGODB_URI` host other than `localhost` / `127.0.0.1`.
- `seed-models.ts` upserts the `mock-llm` model (upstream `http://localhost:${MOCK_UPSTREAM_PORT}/v1`, key `mock-key` encrypted with `MASTER_KEY`). `--fake-token` puts the model on the curve with a fake mint and stores the pool in `fakeChainPools` and a SOL price in `fakeChainPrices` so a `CHAIN_MODE=fake` process on the same Mongo can read them. `--dev-credit <wallet> <usdc>` writes an `adjust` ledger row with reason `dev_credit`.
- `dev-signin.ts` signs the api's sign-in message with an in-memory keypair and prints `{wallet, jwt}` (or `export WALLET=… JWT=…` with `--export`); `API_URL` defaults to `http://localhost:4000`.
- `pnpm dev` runs every app in watch mode (`tsx watch` for api, keeper and mock; `vite` for web on :5173), but nothing passes the `.env` files to it, so the api and keeper exit at startup listing their missing keys. For a dev run start those two from their own directories: `cd apps/api && pnpm exec tsx watch --conditions=development --env-file=.env src/main.ts` (same in `apps/keeper`), with `pnpm --filter @ibt/mock-upstream dev` and `pnpm --filter @ibt/web dev` beside them (vite reads `apps/web/.env` itself). Under pnpm 12, running the same `tsx watch … --env-file=.env` through `exec` with a `--filter` does not find the file; use `cd`.
- Web e2e: `pnpm --filter @ibt/web e2e` (Playwright, stubbed api; the `@staging` wallet flow runs only with `STAGING_URL`).
- Devnet end-to-end: `DEVNET_E2E=1 pnpm --filter @ibt/scripts devnet-e2e` (operator only, H6; prints `skipped` without the flag and refuses mainnet-beta). It needs `apps/keeper/.env` to exist, a local Mongo (`MONGODB_URI`, isolated into a fresh `ibt_devnet_e2e_*` database) and devnet airdrops.

CI (`.github/workflows/ci.yml`) runs install, lint, format check, typecheck, tests, build and the Playwright smoke on every push and pull request, plus a `docker` job (`docker build` and `--version-check`). The nightly job runs `scripts/devnet-e2e.ts` only when the `DEVNET_RPC_URL` secret is set.

## Environment variables

Every app parses its env at startup and fails with the offending key names (values are never printed). Nothing loads `.env` implicitly; use `node --env-file` or `tsx --env-file`.

| Variable                  | Used by                         | Notes                                                                                                         |
| ------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `CLUSTER`                 | api, keeper, scripts            | `devnet` or `mainnet-beta`                                                                                    |
| `RPC_URL`                 | api, keeper, scripts            | Helius URL with key (H2)                                                                                      |
| `RPC_URL_FALLBACK`        | api, keeper                     | Public RPC fallback                                                                                           |
| `CHAIN_MODE`              | api, keeper                     | `real` or `fake` (in-memory chain; local Mongo and non-mainnet only)                                          |
| `USDC_MINT`               | api, keeper                     | Devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `DBC_CONFIG`              | api, keeper, scripts            | Partner config key printed by `scripts/create-config.ts`                                                      |
| `DAMM_V2_FEE_CONFIG`      | keeper                          | `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp`                                                                |
| `TREASURY_WALLET`         | api, keeper, scripts            | Public key; fee claimer and USDC holder                                                                       |
| `KEEPER_WALLET`           | api, scripts                    | Public key; shown on the float report, target of `refill-float`                                               |
| `TREASURY_SECRET_KEY`     | keeper, scripts (`--send` only) | Base58 or JSON byte array; never set for the api                                                              |
| `KEEPER_SECRET_KEY`       | keeper                          | SOL float, buys, locks, migration cranks; never set for the api                                               |
| `MONGODB_URI`             | api, keeper, scripts            | Replica set required (transactions)                                                                           |
| `JWT_SECRET`              | api                             | ≥ 32 chars                                                                                                    |
| `MASTER_KEY`              | api, scripts (`seed-models`)    | 32 bytes, hex or base64; encrypts upstream API keys                                                           |
| `ADMIN_TOKEN`             | api, keeper                     | Same value in both; admin endpoints                                                                           |
| `PORT`                    | api                             | Default `4000`                                                                                                |
| `WEB_ORIGIN`              | api                             | CORS origin and sign-in domain                                                                                |
| `TRUST_PROXY`             | api                             | Express `trust proxy`, default `1`                                                                            |
| `ADMIN_IP_ALLOWLIST`      | api                             | Comma-separated                                                                                               |
| `RATE_LIMIT_PER_MIN`      | api                             | Per-key gateway rate limit override (default 60)                                                              |
| `DAILY_CAP_USDC`          | api                             | Default daily spend cap per API key (default 50)                                                              |
| `JUPITER_PRICE_URL`       | api, keeper                     | SOL price endpoint, e.g. `https://lite-api.jup.ag/price/v3`                                                   |
| `JUPITER_API_KEY`         | api, keeper                     | Optional                                                                                                      |
| `MOCK_UPSTREAM_PORT`      | api, mock-upstream, scripts     | Default `4010`                                                                                                |
| `TELEGRAM_BOT_TOKEN`      | api, keeper                     | Optional; with `TELEGRAM_CHAT_ID` set, alerts are sent to Telegram as well as logged                          |
| `TELEGRAM_CHAT_ID`        | api, keeper                     | Optional, as above; leave both unset to log alerts only                                                       |
| `SETTLEMENT_CRON`         | keeper                          | Default `5 * * * *`                                                                                           |
| `RECONCILE_CRON`          | keeper                          | Daily reconciliation schedule, `0 3 * * *`                                                                    |
| `MAX_SLICE_SOL_PER_RUN`   | keeper                          | Default `2`                                                                                                   |
| `MAX_PAYOUT_USDC_PER_RUN` | keeper                          | Default `500`                                                                                                 |
| `FLOAT_MIN_SOL`           | api, keeper, scripts            | Default `0.5`; the api float report and the keeper float monitor both compare against it                      |
| `API_INTERNAL_URL`        | keeper                          | Api base URL for the health-check trigger                                                                     |
| `KEEPER_PORT`             | keeper                          | `/healthz`, default `4001`                                                                                    |
| `DEVNET_E2E`              | keeper, scripts                 | `1` enables `scripts/devnet-e2e.ts`                                                                           |
| `LOG_LEVEL`               | api, keeper                     | Default `info`                                                                                                |
| `VITE_API_URL`            | web                             | Must be the production api domain before a mainnet launch (H10)                                               |
| `VITE_RPC_URL`            | web                             |                                                                                                               |
| `VITE_CLUSTER`            | web                             |                                                                                                               |
| `VITE_DBC_CONFIG`         | web                             | Same key as `DBC_CONFIG`                                                                                      |
| `VITE_USDC_MINT`          | web                             |                                                                                                               |
| `VITE_TREASURY_USDC_ATA`  | web                             | Treasury USDC token account (H4)                                                                              |
| `API_URL`                 | scripts (`dev-signin`)          | Default `http://localhost:4000`                                                                               |
| `I_AM_HUMAN`              | scripts                         | `1` unlocks `--send`; set only in an operator shell                                                           |

## Runbooks

| #   | Runbook                   | How                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Create a config           | Fund the treasury, then `pnpm tsx scripts/create-config.ts --cluster devnet --dry-run` to review; the operator sends with `I_AM_HUMAN=1 TREASURY_SECRET_KEY=… pnpm tsx scripts/create-config.ts --cluster devnet --send` (mainnet also needs `--confirm-mainnet`). Paste the printed key into `DBC_CONFIG` (api, keeper) and `VITE_DBC_CONFIG` (web).                                                                                           |
| 2   | Launch the first model    | Register the model in the web app with the treasury's wallet as provider, run its health check, launch; buy 0.1 SOL to verify quotes and progress.                                                                                                                                                                                                                                                                                              |
| 3   | Refill the keeper float   | `GET /api/admin/float` (bearer `ADMIN_TOKEN`) reports keeper SOL vs `FLOAT_MIN_SOL` and treasury USDC vs the next expected payout; the keeper's float monitor alerts every 5 minutes on the same checks. `pnpm tsx scripts/refill-float.ts --sol 1 --dry-run` shows the transfer and the resulting float; send with `I_AM_HUMAN=1 … --send`.                                                                                                    |
| 4   | Retry a failed settlement | Read `error` in the settlement document (the token page shows only the `failed` state), fix the cause (float, RPC), then `POST /api/admin/settlements/:id/retry` (bearer `ADMIN_TOKEN`): it resets the settlement to its last completed state and the keeper's next run resumes it from there. Without the api, `pnpm --filter @ibt/keeper settle:once --chain real --period-start <ISO hour>` (no `--` before the flags) resumes the same way. |
| 5   | Rotate the keeper key     | Create a new keypair, transfer the float and token escrow balances, update `KEEPER_SECRET_KEY`, restart the keeper, then empty and retire the old key.                                                                                                                                                                                                                                                                                          |
| 6   | Devnet migration drill    | Launch on devnet, buy to 1 SOL, confirm the keeper's `migrateToDammV2` signature and the DAMM v2 pool within a minute; `scripts/devnet-e2e.ts` runs the whole drill. If the crank fails, use the [manual migrator](https://migrator.meteora.ag).                                                                                                                                                                                                |
| 7   | Pause or resume a model   | Provider page "Pause"/"Resume", or `PATCH /api/models/:id` with `{"status":"paused"}` / `{"status":"active"}` (owner JWT). Failed health checks pause a model automatically; success never auto-resumes it.                                                                                                                                                                                                                                     |

## Addresses

| Item                                                          | Devnet                                         | Mainnet                                        |
| ------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| DBC program                                                   | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`  | same                                           |
| DAMM v2 program                                               | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`  | same                                           |
| DAMM v2 fee config, 100 bps                                   | `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp` | same                                           |
| Wrapped SOL mint                                              | `So11111111111111111111111111111111111111112`  | same                                           |
| USDC mint                                                     | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Platform DBC config                                           | _TBD (H4)_                                     | _TBD (H8)_                                     |
| Treasury wallet                                               | _TBD (H1)_                                     | _TBD (H1)_                                     |
| Treasury USDC ATA                                             | _TBD (H4)_                                     | _TBD (H8)_                                     |
| Keeper wallet                                                 | _TBD (H1)_                                     | _TBD (H1)_                                     |
| Model token mints, DBC pools, DAMM v2 pools, keeper positions | _TBD (H12)_                                    | _TBD (H12)_                                    |

## Scope

The spec's cut list was built after the core gate: streaming responses (`stream: true`, SSE pass-through with `[DONE]`), idempotency keys (`Idempotency-Key` header, replay marked `Idempotency-Replayed: true`), the token-holder discount (`X-Discount-Bps: 1000` for wallets holding at least 1,000,000 tokens, balance cached 5 minutes), Telegram alerts (when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set; alerts are always logged) and the token price chart (`GET /api/tokens/:mint/snapshots`, drawn with lightweight-charts on the token page). Provider vesting, burn-to-credit, an indexer and DLMM are out of scope.

## Human-only steps

Agents never send transactions, hold keys or deploy. These steps belong to the operator (work plan §7); every `--send` runs with `I_AM_HUMAN=1` in the operator's shell only.

| ID  | Step                                                                                                                                                                                     | By      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| H0  | Devnet chain smoke: `create-config --cluster devnet --send`, launch one token on it, one curve swap; record signatures                                                                   | Oct 4   |
| H1  | Create the treasury and keeper wallets (hardware or secret store); never commit them                                                                                                     | Oct 3   |
| H2  | Helius devnet and mainnet keys (`RPC_URL`, `RPC_URL_FALLBACK`); `JUPITER_API_KEY` if needed                                                                                              | Oct 3   |
| H3  | Atlas M0 (staging) and M10 with backups (prod); IP rules                                                                                                                                 | Oct 3   |
| H4  | Fund the devnet treasury, create its USDC ATA (`VITE_TREASURY_USDC_ATA`), create the devnet config and set it in all three apps                                                          | Oct 4   |
| H5  | Railway (api + keeper, keeper 1 replica), Vercel (web), env secrets                                                                                                                      | Oct 8   |
| H6  | Run `DEVNET_E2E=1 scripts/devnet-e2e.ts` twice in a row; devnet migration drill (runbook 6)                                                                                              | Oct 8–9 |
| H7  | Telegram bot and chat id; force a settlement failure and a low float to confirm alerts                                                                                                   | Oct 9   |
| H8  | Mainnet, only after H6, H7 and H9 pass: fund the treasury, mainnet USDC ATA, `create-config --cluster mainnet-beta --send --confirm-mainnet`, refill the float                           | Oct 10  |
| H9  | Record one real devnet deposit as a parser fixture; wrong-memo deposit check                                                                                                             | Oct 9   |
| H10 | Check the deployed `VITE_API_URL` is the production api; first mainnet model launch with the treasury as provider; buy 0.1 SOL; real OpenAI SDK call                                     | Oct 10  |
| H11 | Provider claims creator and position fees from the dashboard; confirm settlement links                                                                                                   | Oct 11  |
| H12 | Fill the address table above, record the 3-minute demo video, add the live URL, add `dannxbt` if the repo is private, submit on Superteam Earn and Colosseum before 2026-10-13 06:59 UTC | Oct 12  |
| H13 | Legal framing review of the copy                                                                                                                                                         | Oct 11  |
