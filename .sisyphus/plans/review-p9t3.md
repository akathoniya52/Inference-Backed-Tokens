# P9-T3 review report: slop and consistency

Reviewer pass over the monorepo at `a984612` (plus `1fc674e`, which landed during the review), checked against `Plan.md` (spec, unchanged: sha1 `8d4f4e39…`) and the work plan. Intentional deviations logged in §13 are not reported. "Spec Lnnn" means a line in `Plan.md`.

## Summary

| Severity | Count | Fixed by the reviewer |
| --- | --- | --- |
| Blockers | 3 | 0. B1 is partly mitigated in the README; each blocker has an exact fix below |
| Majors | 0 | — |
| Minors | 10 | 0 (behaviour changes or design calls) |
| Slop removed | 4 files | 4 |
| Spec/doc drift | 15 items | 13 (11 wrong line refs, 2 README statements) |

Fix commits, one per package: api `4829c42`, keeper `f9b59d9`, web `d804cfa`, scripts `8968c76`, root `0af0b60`. Checks after each commit: api vitest 124/124, keeper 75/75, web 120/120. `tsc -b`, eslint and prettier were clean for every package touched. Scripts: tsc, eslint and prettier clean, and vitest 15/16. The one failing test is B2, which predates `8968c76`.

The P9-T3 accept is "0 blockers", so it is **not met** until B1–B3 are fixed.

## Blockers

### B1. The §9 sequence fails: `apps/api/.env` copied from `.env.example` does not start

- §9 (and the README run block) runs `cp apps/api/.env.example apps/api/.env`, with the comment "localhost MONGODB_URI, CHAIN_MODE=fake, CLUSTER=devnet". The example actually ships `CHAIN_MODE=real` and `replace-me` placeholders.
- Starting the api from that copy (`node --env-file=.env dist/main.js`) exits with `invalid environment variables: DBC_CONFIG, TREASURY_WALLET, KEEPER_WALLET, JWT_SECRET, MASTER_KEY, ADMIN_TOKEN`. Verified with `loadEnv` against the copied file plus `CHAIN_MODE=fake`.
- Every later manual step fails with it: `dev-signin`, `seed-models` (it reads `MASTER_KEY` from `apps/api/.env`), `POST /api/keys` and the curls. `pnpm smoke:local` still passes because it forces its own env.
- `apps/keeper/.env` works as copied for `settle:once --chain fake`: in fake mode, unparseable secret keys fall back to throwaway keypairs (`runtime.ts` `signer`).
- **Mitigated in `0af0b60`:** the README note now lists every value to set. Before, it named only `CHAIN_MODE` and the secrets, which still left `DBC_CONFIG`, `TREASURY_WALLET` and `KEEPER_WALLET` invalid.
- **Still open:** §9 as written (work plan, read-only for this review) and the `.env.example` files (not editable in this task).
- **Exact fix.** Add this line after the `cp` line in work plan §9 and in the README "Run it locally" block. It was verified to parse (`loadEnv` → OK, `CHAIN_MODE` fake); smoke-local starts the api the same way, with throwaway keys.
  ```bash
  K=11111111111111111111111111111111; sed -i.bak -e 's/^CHAIN_MODE=real/CHAIN_MODE=fake/' -e "s|^DBC_CONFIG=.*|DBC_CONFIG=$K|" -e "s|^TREASURY_WALLET=.*|TREASURY_WALLET=$K|" -e "s|^KEEPER_WALLET=.*|KEEPER_WALLET=$K|" -e "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 32)|" -e "s|^MASTER_KEY=.*|MASTER_KEY=$(openssl rand -base64 32)|" -e "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$(openssl rand -base64 32)|" apps/api/.env
  ```
  Also correct the §9 comment to "then made local-ready by the sed line". Shipping working secrets in `.env.example` instead is not recommended.

### B2. Root `pnpm test` (§9 line 2) is red since `1fc674e`

- `1fc674e` added `"test": "vitest run"` to `scripts/package.json`, so root `pnpm test` (`pnpm -r test`) now runs `scripts/test/env-consistency.test.ts`.
- That test fails 1/16 in "every key an app schema reads is in that app's .env.example": `apps/api/src/env.ts` and `apps/keeper/src/env.ts` read `LOG_LEVEL`, and neither `.env.example` has it.
- This also fails the P9-T3 accept command (`pnpm --filter ./scripts exec vitest run test/env-consistency.test.ts`).
- Both files are off-limits to this review. The owner of `scripts/test/**` or the orchestrator should apply the fix.
- **Exact fix:** add `LOG_LEVEL=info` to `apps/api/.env.example` (next to `PORT`) and to `apps/keeper/.env.example` (next to `KEEPER_PORT`). The README already lists `LOG_LEVEL` (api, keeper, default `info`).

### B3. `sendAndConfirm` can send a second, different transaction when the first may still land (money)

- **Where:** `packages/chain/src/send.ts`, `sendAndConfirm`.
- **What happens:**
  1. Any error from `sendRawTransaction`/`confirmTransaction` other than `TransactionExpiredBlockheightExceededError` falls through to the next attempt.
  2. That attempt re-signs with a **fresh blockhash** and sends again. It does not check whether the first signature landed and does not wait for its blockhash to expire.
  3. `onSigned` then overwrites `settlement.pendingTx` with the new signature.
- **When it bites:** in web3.js 1.99, `confirmTransaction` (block-height strategy) only throws the expiry error or the on-chain tx error. `sendRawTransaction`, though, throws plain fetch or network errors (`fetch failed`, `ECONNRESET`, a proxy 5xx) that can arrive after the RPC already forwarded the transaction. Then both transactions land.
- **Cost:** a second provider USDC payout of up to `MAX_PAYOUT_USDC_PER_RUN` (500) from the treasury, or a second buy/add.
- **Why nothing catches it:** `RealChainClient.send` calls the primary connection directly, so there is no retry layer in between. The nightly reconcile re-checks only the stored (last) signature, so it cannot see the first transfer.
- **Spec:** contradicts spec L258 ("resend on blockhash expiry … never a second send").
- **Tests:** `packages/chain/test/send.test.ts` exercises only the expiry path.
- **Scope:** does not affect the §9 run (fake chain). It must be fixed before H8 (mainnet).
- **Exact fix** (in the attempt loop's `catch`; also import `SendTransactionError` from `@solana/web3.js`):
  ```ts
  } catch (err) {
    lastError = err;
    if (err instanceof TransactionExpiredBlockheightExceededError) {
      if (await hasLanded(connection, signature, commitment)) {
        return { signature, landed: true, attempts: attempt };
      }
      continue;
    }
    // The RPC answered with an error, so nothing was forwarded: safe to re-sign.
    if (err instanceof SendTransactionError) continue;
    // Not provably dropped (network error, on-chain failure): never re-sign here (L258).
    // Callers resolve the stored signature first (keeper: pendingTx, G20).
    throw new AppError('chain_send_failed', { cause: err });
  }
  ```
- **What the fix does to callers:**
  - Keeper: `chain_send_failed` is retryable. The engine re-runs the step, and `sendWithPendingTx` → `pendingTxOutcome` polls the stored signature until it has landed (no resend) or is dropped (rebuild).
  - Pool poller: keeps its own `shouldSendMigration` guard.
  - Operator scripts: fail fast instead of resending blind.
- **Tests to add:**
  - `sendRawTransaction` rejects with a network error → one send, `chain_send_failed`, `onSigned` called once.
  - `sendRawTransaction` rejects with a `SendTransactionError` → re-signed and sent again.

## Majors

None.

## Minors

1. **Duplicate concurrent `X-Request-Id`** (`apps/api/src/modules/gateway/completions.ts` L173–189).
   - Both requests pass `Requests.exists`, both hold, and both call the upstream.
   - The second `capture` fails on the unique `requestId`: the client gets a 500, and the hold stays open until `holdExpiry` (10 min). The provider serves an unbilled call. No platform money is lost.
   - Fix: on a duplicate key in `capture`, `release` the hold and return 400 `invalid_request`. Alternatively, claim the id before the upstream call.
2. **Dead query invalidations.** `LaunchWizard.tsx` L314 invalidates `['token', current.slug]` and `DepositUsdc.tsx` L124 invalidates `['ledger']`, but no query uses either key. The live keys are `['tokenState', mint]` and, for deposits, `['me', wallet]`. Fix: use `publicQueryKeys.tokenState(mintAddress)` and drop `['ledger']`.
3. **Curve price is not the spot price.** On the curve, `priceSolPerToken` is `quoteReserve / baseReserve` (`apps/keeper/src/jobs/poolPoller.ts` `curvePriceSolPerToken`). That is an average price, and it is 0 at launch. `GET /api/tokens/:mint/state` returns it; the web does not render it today. Fix: derive the price from the DBC `sqrtPrice`, as the DAMM path does.
4. **Retry classification is too broad.** In `apps/keeper/src/settlement/engine.ts`, `TRANSIENT_MESSAGE` matches any message containing `rpc`, `429` or `502`/`503`/`504`, including amounts inside messages. A permanent failure can therefore spend all 3 attempts (2.5 s of backoff) before `failed`. The damage is bounded. Fix: classify by error class or code.
5. **Fee claims with nothing to claim.** `compound` sends `claimPositionFee` on every hourly run for every graduated model, even when nothing accrued, which costs one tx fee per model-hour. Fix: skip when the position reports zero claimable fees.
6. **No sanity band on the SOL price.** `convert` only rejects non-finite or ≤ 0 Jupiter prices (`steps.ts` `solPriceMicro`). A bad low quote overspends the keeper float, up to `MAX_SLICE_SOL_PER_RUN` per model-run. Fix: add a band, or compare against a second source, before spending.
7. **`killGroup` swallows every error.** In `scripts/load/processes.ts` it catches everything although its comment says ESRCH. `smoke-local.ts` checks `err.code === 'ESRCH'`. Fix: rethrow anything else.
8. **Env names missing from the README env table:**
   - `MOCK_UPSTREAM_MODE` and `MOCK_UPSTREAM_API_KEY` (`apps/mock-upstream/src/main.ts`);
   - `LOAD_API_PORT`, `LOAD_MOCK_PORT`, `LOAD_WARMUP_S` and `LOAD_ENV_FILE` (`scripts/load/gateway-load.ts`);
   - `SMOKE_ENV_FILE` (documented only in the `smoke-local.ts` header).

   `LOG_LEVEL` is missing from both `.env.example` files; see B2.
9. **Unused shared exports.** These are scaffolding for the cut list and are covered by shared tests: the `idempotency_in_progress` catalog entry, `RevokeApiKeyResponseSchema`, `GATEWAY_RESPONSE_HEADERS`, `GATEWAY_REQUEST_HEADERS`, `ChatCompletionChunkSchema`, `applyDiscount`, `holderDiscountBps` and `HOLDER_DISCOUNT_BPS`. Keep them for Wave C (P4-T6/T7/T8) or prune them after P9-T4. Not removed here.
10. **`payProvider` can record the wrong amount after a "changed mid-run" retry** (`steps.ts` L183–213). The retry recovers a landed transfer's signature but records the recomputed amount, which differs if the carry-over moved between attempts. The per-model serial orchestrator plus the keeper lease make this unreachable today. FYI.

## Slop removed (file list)

- `scripts/smoke-local.ts`: removed the only section divider in the repo (`// ---- child processes ----`).
- `apps/web/src/lib/queryKeys.ts`: removed 8 unused factory entries (`models`, `model`, `token`, `settlements`, `me`, `keys`, `ledger`, `usage`). Nothing referenced them in source or tests. `token(slug)` and `settlements(slug)` also disagreed with spec L502, which keys those by mint. The header no longer claims all keys live "in one place"; it now points to `publicQueryKeys` and `accountKeys`.
- `apps/web/src/pages/TokenPage.tsx`: the slot props were documented as "Mount point for the P7-T5/P7-T8 …", which is stale now that both tasks have landed. They now say the slots replace the defaults so tests can inject stubs.
- `apps/keeper/src/ctx.ts`: dropped "used from P6-T4" from the `maxSliceLamports` doc.

No other slop surfaced:
- no `TODO`/`FIXME`/`XXX`/`HACK`;
- no `console.*` in app or package source, except a code sample string in `DocsPage.tsx`;
- no `as any`, `@ts-ignore`, `@ts-expect-error` or `eslint-disable`;
- none of the 54 `catch` blocks in non-test source is empty or silently swallows (except minor 7);
- no filler docstrings.

## Spec drift found

Wrong spec line references, all fixed:

| # | File | Was | Now | Spec line content |
| --- | --- | --- | --- | --- |
| 1 | `apps/api/src/modules/gateway/router.ts` | L388 | L386 | `GET /v1/models` |
| 2 | `apps/api/src/modules/auth/router.ts` | L389 | L388 | `POST /api/auth/verify {wallet, signature}` |
| 3 | `apps/api/src/modules/keys/service.ts` | L230 step 1 | L234 step 1 | gateway step 1, authenticate the key |
| 4 | `apps/api/src/modules/models/service.ts` | L224 | L392 | `POST /api/models`: provider becomes `role: provider` |
| 5 | `apps/api/src/modules/billing/router.ts` | L519 | L523 | rate limits on auth and deposit endpoints |
| 6 | `apps/keeper/src/jobs/floatMonitor.ts` | L529 | L530 | alert list (L529 is `/healthz`, `/readyz`) |
| 7 | `apps/web/src/fixtures/models.ts` | L396 | L391 | `GET /api/models` |
| 8 | `apps/web/src/hooks/useAuth.ts` | L489 | L490 | `WalletGate`: JWT in memory (L489 is a table separator) |
| 9 | `apps/web/src/lib/auth.ts` | L489 | L490 | same |
| 10 | `apps/web/src/lib/claims.ts` | L120 | L125 | "Claim fees" step (L120 is a heading) |
| 11 | `apps/web/src/lib/solana.ts` | L432–437 | L491, L519 | deposit tx shape and the server checks (L432–437 is the API example) |

Other drift:

12. Work plan §13, P7-T8 bullet: cites "spec L120" for `claimPositionFee`; it should be L125. Not fixed (plan is read-only here).
13. README runbook 4 said a settlement's `error` is "also shown on the token page". The public settlements DTO never carries `error`; the page shows only the `failed` state. Fixed in `0af0b60`.
14. README notes on the local `.env` were incomplete (B1). Fixed in `0af0b60`; §9 and `.env.example` are still open under B1.
15. The §9 comment "CHAIN_MODE=fake" contradicts the `CHAIN_MODE=real` that `.env.example` ships (B1).

Note: `env-consistency.test.ts` only checks that each `L<n>` falls inside `Plan.md`, not what the line says. That is why refs 1–11 passed it.

## Verified-OK list

- **Money math** (`packages/shared` `money.ts`, `pricing.ts`, `split.ts`): BigInt only; G16 ceil for cost, floor for the discount and splits, remainder to the platform; G17 90% to the provider with no token.
- **Ledger** (`packages/db/src/ledger.ts`):
  - the hold is a conditional `$inc` on `balance − held ≥ estimate` (G14);
  - capture is idempotent;
  - release and expiry close only `open` holds and write a `release` row;
  - `recomputeBalance` matches L372.
- **Gateway** (`completions.ts`, `router.ts`):
  - every upstream failure releases the hold, and the cost is capped at the hold;
  - a hold can only stay open if `capture` itself throws, and `holdExpiry` then releases it;
  - the undici first-byte timer comment and the never-log-the-error note are intact.
- **Keeper settlement** (`steps.ts`, `pendingTx.ts`, `engine.ts`):
  - every step is guarded by `lastCompletedState`;
  - the signature is persisted before send (G20);
  - optimistic carry-over updates;
  - the L375 invariant is enforced at finalize;
  - non-retryable errors fail at once with an alert.

  The `strict: false` workaround comment and the settle-once test hook (`SETTLE_ONCE_PAUSE_*`) are intact.
- **Fake-mode signer fallback** (`apps/keeper/src/runtime.ts` `signer`) is intentional: it lets the plain-copied keeper `.env` run `settle:once --chain fake`.
- **USDC payouts** are `bigint` end to end (`spl.ts`, idempotent ATA then `transferChecked`). The only `Number(...)` conversions on amounts are display values: progress, curve and DAMM price, price impact.
- **Errors:** `ERROR_CATALOG` matches spec L417–426 and L436–446. The envelope is `{error:{code,message,requestId}}` (L260).
- **Endpoints:** every endpoint in spec L383–403 is mounted, plus the documented additions (`/api/tokens/launch/prepare`, `/api/admin/health-checks/run`, `/healthz`, `/readyz`). Auth (10/min per IP) and deposits (10/min per user) are rate-limited (L523).
- **api ↔ web shapes:** the web parses responses with the shared zod schemas (`OwnerModelSchema`, `LaunchPrepare/ConfirmResponseSchema`, `MeResponseSchema`, `ListApiKeysResponseSchema`, `UsageResponseSchema`, `DepositResponseSchema`, `HealthCheckResponseSchema`) or the shared types (`ListModelsResponse`, `Model`, `TokenStateResponse`, `SettlementsResponse`). No drift. The 202 `deposit_pending` envelope is handled and tested.
- **Env:**
  - api and keeper schemas equal their `.env.example` files except `LOG_LEVEL` (B2);
  - the api refuses `KEEPER_SECRET_KEY` and `TREASURY_SECRET_KEY` (L190);
  - web `.env.example` = the six `VITE_*` of spec L507;
  - every spec env variable (L551–566) is in the README table.
- **Spec line references:** about 75 checked by hand against `Plan.md`. 11 were wrong (fixed); the rest are correct.
- **`docs/acceptance-checklist.md`:** all 30 cited test names exist in the named files.
- **Intentional §13 deviations** were left alone: `/t/:slug`, router-level 409 `token_already_launched`, `pool_mismatch` matched by shape, api `FLOAT_MIN_SOL`, `settle:once` without `--`, `LOAD_CONNECTIONS` 5, `SeededFakePriceSource`, the cut list, and the platform `claimPositionFee` follow-up.
- `Plan.md` is byte-identical.
