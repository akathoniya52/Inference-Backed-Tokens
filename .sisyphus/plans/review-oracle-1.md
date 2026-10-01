# Oracle review 1 of `inference-backed-tokens.md` against `Plan.md`

Verdict: APPROVE WITH FIXES. Every item below must be folded into the work plan before execution.

Local fact checked: `curl :4999/healthz` with curl 8.7.1 exits 3 "URL malformed". Every curl that starts with `:PORT` fails.

## BLOCKERS

1. Commands in P0-T4 accept and section 9 DoD: `curl :4000/...` does not work. Use `http://localhost:4000`. P0-T4 leaves `node … &` running, so later tasks hit a port conflict. Add `kill %1` at the end.
2. curl requests in section 9 DoD and P4-T1: the `-d` calls send no `Content-Type`, so `express.json()` leaves the body empty and returns 400. Add `-H 'Content-Type: application/json'` to every JSON curl.
3. P6-T7 holdExpiry, P6-T8 reconcile, P8-T2 `--dev-credit` all need `expireHolds`, `recomputeBalance`, `adjust`, which live in `apps/api/src/modules/billing/ledger.ts`; keeper and scripts cannot import it. Move the ledger service into `packages/db/src/ledger.ts` (P3-T6) and have the api import it.
4. P3-T6, wave 7: its tests run under `@ibt/api`, but the Mongo test harness (`test/helpers.ts`, MongoMemoryReplSet) is only created in P3-T2 (wave 9). Fixing item 3 fixes this: test the ledger in `@ibt/db` with the global setup from P0-T3. Otherwise add dep P3-T2 and move P3-T6 to wave 10.
5. P4-T4 accept curls a running api, but no user, key, model or credit exists until P8-T2 (wave 14). Drop the curl; keep the supertest cases. The live curl moves to P9-T1.
6. P9-T2 "kill keeper mid-settlement": `FakeChainClient` is in memory, so after SIGKILL there is no record to prove "no extra payment". Give the fake chain optional persistence (a `fakeChainTxs` Mongo collection) and assert one transfer per settlement from it.
7. Double-pay window, P2-T3 and P6-T3/T4/T5: if the keeper crashes after a tx lands but before its signature is stored, resume sends it again (breaks L599 and L172). `sendAndConfirm` needs an `onSigned(sig)` hook that persists the signature before sending. On resume, check `getSignatureStatuses` on the stored signature before rebuilding. Add a P6-T6 case: crash between landing and persist.
8. P8-T6 load test: at 50 req/s one key hits the 60/min rate limit (L423) and the 50 USDC daily cap. Seed >= 50 keys, or make both limits env-overridable and raise them in the load profile.
9. P9-T4 deps "all CUT tasks", and Wave C runs before Wave 16. Make P9-T4 depend on CORE only and run Wave C after P9-T4 as optional.

## GAPS (spec requirement without an owning task)

| Spec | Gap | Put it in |
|---|---|---|
| L172, L182, L525, L599 | No task resumes in-progress settlements left from earlier runs (state not done/failed, including admin re-queued with retry). `retry` only rewrites the doc; nothing executes it. | P6-T5: orchestrator scans for these settlements at boot and every run |
| L172, L175 | Missed hours leave requests orphaned because `tagAndSum` filters on `createdAt` in period. | P6-T3: tag `createdAt < periodEnd, settlementId: null` |
| L375 | Zero-revenue periods and dust slices (0 lamports after flooring) break the invariant. Section 9 "liquidity buy signature" will likely fail at mock prices. | P6-T3/T4: rev = 0 -> `done` with phase `none`; dust -> `sliceCarryOver`. Seed prices in P8-T2 so the smoke slice is > 0 |
| L122 | Metadata URI is immutable but `token.mint` is only stored at `/launch/confirm`; indexers can fetch first, get 404, cache it. | P5-T1 + P7-T7: add `POST /api/tokens/launch/prepare {modelId, mint}` before signing; P5-T3 serves pending mints |
| L519 | A deposit submitted right after confirm is not finalized yet; rejected with 422 and counts toward the "rejected > 5/h" alert. | P3-T7: return retryable `deposit_pending` (202) without a rejected row; P7-T6 polls |
| L483 | Provider pause/resume UI has no endpoint (admin pause needs ADMIN_TOKEN). | P3-T5: owner PATCH accepts `status: active|paused` and resets `consecutiveFailures` |
| L127 | `claimPositionFee` can pay out in base tokens too; only lamports are compounded. | P6-T5: add base fees to `escrowBaseUnits` |
| L308, L454 | How `lockedLiquiditySol` is computed is never defined. | P6-T7: sum of SOL added in settlements |
| L457 | `GET /api/models` and `/api/keys` have no cursor/limit. | P3-T4, P3-T5 |
| L523, L230 | No `trust proxy`. On Railway, IP rate limits and ADMIN_IP_ALLOWLIST see the proxy IP; express-rate-limit throws on X-Forwarded-For. | P3-T2: `app.set('trust proxy', 1)` via env |
| L610 | G-Chain gate is only `--dry-run`. First real DBC/DAMM tx happens at H6 around Oct 9 with no fallback. | New H-task, Oct 4: devnet `create-config`, launch, one swap |

## ORDERING / ACCEPTANCE fixes

- P2-T3, P2-T6: add dep P1-T5 (they throw `AppError('chain_send_failed')` and `pool_mismatch`).
- P2-T1: run the import check as `pnpm --filter @ibt/chain exec node -e "…"`. From the root, strict pnpm cannot resolve the SDK.
- P2-T6, P2-T7: SDK builders fetch accounts through `Connection`, so "builds a tx on a fixture pool" has no RPC. Accept on SDK-call parameters via `vi.spyOn`, or stub `getAccountInfo`/`getMultipleAccountsInfo` with encoded fixtures.
- All `-t <word>` accepts: if no test name matches, vitest skips everything and exits 0. Use file paths (`vitest run test/pricing.test.ts`). Root `pnpm test -t acceptance` (P9-T2) does not pass `-t` through reliably; use `--filter`.
- P1-T6: "web build passes" proves nothing because web does not import shared yet. Add an ESLint `no-restricted-imports` rule in `apps/web` for `@ibt/shared/node`, `@ibt/db`, `@ibt/chain/testing`.
- P0-T1: `grep` does not prove one web3.js copy. Use `pnpm why @solana/web3.js | grep -c '1\.'` showing a single version.
- P0-T2: add a `format:check` script. `pnpm format --check` appends `--check` to `--write`.
- P0-T5: an rs initiated with the container hostname is unreachable from the host. Initiate with `localhost:27017` or use `?directConnection=true` in `MONGODB_URI`.
- P3-T1: `token.mint` unique with `partialFilterExpression {$type:'string'}`, not sparse. The requests `(userId, idempotencyKey)` index must be non-unique (rows live 90 days, key reuse allowed after 24 h). The idempotency TTL needs its own single-field index.
- P4-T4, P6-T1: make timeouts and the lease TTL injectable so tests do not wait 30 s / 90 s.
- P4-T2: the heap-growth assertion is flaky. Assert that the encoder is constructed once.
- P6-T1: add the keeper's own Mongo test harness. Only db (P0-T3) and api (P3-T2) have one.
- P6-T5, section 9: `settle:once` needs `MONGODB_URI` and a running mongo. Load env explicitly with `node --env-file` or `tsx --env-file`; nothing in the plan loads `.env` files.
- P7-T11: `/` fetches the API under `vite preview`, so "no console errors" fails. Stub the API with `page.route`.
- Critical path line: P6-T5 does not go through P4. Real path: P3-T7/P5-T1 -> P8-T2 -> P9-T1. Hours add to ~110, not 106.

## TECH RISKS (each could cost > 1 h)

1. G10 conditions: TS ignores the `development` condition. Without `types` -> `dist/*.d.ts` plus `tsc -b` reference order, `pnpm typecheck` fails on a clean clone. Do not add `customConditions` to the build tsconfig (TS6059 rootDir errors). Confirm in P0-T3 that vitest resolves `development` for SSR (`ssr.resolve.conditions` too), or fall back to `resolve.alias`.
2. Two mongoose copies: if api and keeper depend on mongoose directly, models can register on a different singleton and queries hang on buffering. `@ibt/db` must re-export the connection and models. In tests call `syncIndexes()` before any transaction; `autoIndex` races cause WriteConflicts. Use `session.withTransaction` so transient errors retry.
3. pnpm 10+ changes (verify in P0-T1): `pnpm.overrides` belongs in `pnpm-workspace.yaml`. Build scripts need allow-listing (`onlyBuiltDependencies`: esbuild, mongodb-memory-server, bufferutil, utf-8-validate) or `--frozen-lockfile` may fail. `pnpm deploy` in P8-T5 needs `injectWorkspacePackages: true`.
4. Express 5: `req.query` is a getter, validation middleware must not reassign it. `res.json` throws on BigInt; convert to strings at the DTO boundary.
5. ESLint `recommendedTypeChecked` errors on files outside any tsconfig (`*.config.ts`, `eslint.config.js`). Set `projectService.allowDefaultProject`.
6. Vite polyfills: including `crypto` and `stream` pulls in crypto-browserify and often breaks the build. Start with `buffer` + `process` only. Add a DBC and cp-amm SDK import to P7-T1's build accept so failures show up in wave 6, not at P7-T5.
7. Jupiter API key (G25): Jupiter's price API may now require an API key. Add `JUPITER_API_KEY` to G26 and H2.
8. G28 (cut task): some upstreams reject `stream_options` with 400. Put it behind a per-model flag.

## SAFETY

- Logger redaction (P1-T6): paths must be exact: `req.headers.authorization`, `err.headers`, `*.apiKey`, `MASTER_KEY`, `JWT_SECRET`, `ADMIN_TOKEN`, `*_SECRET_KEY`. Add a test that the decrypted upstream key never appears in logs on upstream error.
- G23/G24: `--dev-credit`, `--fake-token` and `CHAIN_MODE=fake` only check `CLUSTER`. Pointed at prod Atlas with `CLUSTER=devnet` they would mint free credits in prod. Also refuse unless `MONGODB_URI` is localhost.
- P8-T1: make `--send` also require `I_AM_HUMAN=1`. The agents' environment must never contain `*_SECRET_KEY`.
- API env schema: reject `KEEPER_SECRET_KEY` / `TREASURY_SECRET_KEY` (L190).
- H10: check that `VITE_API_URL` is the production domain before mainnet launch (metadata URI is immutable).
- H4: include creating the treasury USDC ATA.
- Mainnet ordering: gate H8 on H6 + H7 + H9 passing (L594).

## SCHEDULE

Verdict: over budget as written. Agent work is ~110 h; chain and settlement `ub` tasks are probably underestimated 1.5–2x. No time budgeted for the human side (reviewing 73 commits plus H1–H13, ~15–20 h). Oct 12 holds all of mainnet, demo and submission, leaving no time for real settlements.

Reorder:
- Real devnet chain smoke by Oct 4 (new H-task).
- H6 on Oct 8–9.
- Mainnet launch (H8/H10) by Oct 10 so settlements accumulate for 2+ days.
- Oct 12 for video and submission only.

Cuts, in order:
1. The spec's own cut list: P4-T6, P4-T7, P4-T8, P6-T9, P7-T10.
2. P7-T11 Playwright.
3. P8-T6 load test (run once by hand).
4. P9-T3 review.
5. P5-T5 5xx-rate counter.
6. P6-T8 signature re-check (keep the ledger recompute).
7. P8-T7.
8. P7-T9 becomes a static page.

Never cut: P2-T3, P3-T6, P6-T3–T6, P2-T4, P4-T5 caps.

## Minimum edits to reach APPROVE

1. Fix the curl URLs and Content-Type headers (Blockers 1–2).
2. Move the ledger to `@ibt/db` and fix the P3-T6 harness ordering (3–4).
3. Remove the live curl from P4-T4 (5).
4. Add fake-chain persistence and persist-before-send signatures (6–7).
5. Use multiple keys or env-overridable limits in the load test (8).
6. Decouple P9-T4 from the CUT tasks (9).
7. In the orchestrator: resume pending settlements, tag with `createdAt < periodEnd`, handle zero/dust periods.
8. Add launch-prepare for metadata and `deposit_pending`.
9. Add `trust proxy`.
10. Add the P1-T5 deps to P2-T3/T6.
11. Replace vacuous `-t` accepts with file-path filters.
12. Add an Oct 4 devnet chain smoke H-task and move mainnet to Oct 10.
