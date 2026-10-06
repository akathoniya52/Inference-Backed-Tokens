# Issues: Inference-Backed Tokens codebase audit
 
Audit date: 2026-10-06 · Commit: `b8d9286` (main) · Scope: all of `apps/*`, `packages/*`, `scripts/*`, infra/CI config.

Each finding has a severity, location (`file:line`), what goes wrong, how it is triggered, and a suggested fix.
Findings marked **[verified]** were confirmed by re-reading the code (and, where noted, the installed SDK / mongoose source or a runtime repro). The rest were traced through code by the audit but not reproduced at runtime.

## Toolchain baseline

| Check | Result |
| --- | --- |
| `pnpm typecheck` (`tsc -b`) | ✅ passes |
| `pnpm lint` | ✅ passes |
| `pnpm test` | ❌ **fails**: `scripts/test/env-consistency.test.ts` (2/16), see INF-01. All other suites pass (api 212, keeper 93, web 151, chain 97, db 60, shared 121, mock 17). |
| `pnpm audit --prod` | ⚠️ 10 advisories (4 high, 6 moderate), all transitive under `apps/web`, see DEP-01 |

## Summary

| Severity | Count |
| --- | --- |
| Critical / High | 10 |
| Medium | 32 |
| Low | 49 |

Top priorities:
1. **KPR-01**: Mongo transaction retries silently drop settlement writes while keeping model writes (accounting corruption, triggered hourly by the stats job).
2. **CHN-01**: `sendAndConfirm` can double-send payouts/buys after a blockhash expiry.
3. **CHN-02 / WEB-01**: DAMM v2 slippage is passed as percent to an API that expects bps (100× too tight), both in the keeper and in the web trade panel.
4. **GW-01**: reasoning / `function_call` output is never billed; streams with only that output are free.
5. **INF-01**: CI is red on `main`.

---

## 1. Keeper / settlement (`apps/keeper`)

### KPR-01: High. Retried transactions lose settlement writes but keep `Models` writes; the `saveIf` fence is bypassed **[verified]**
- **Where:** `packages/db/src/transaction.ts:4-11`, `apps/keeper/src/settlement/fence.ts:71-88`. Affects every step that does a `Models` update and `saveIf` in one transaction: `steps.ts` reservePayout (~223-234), convert (~395-421), buyOnCurve (~500-516), and the add/lock/compound/finalize steps (~609-621, 720-746, 789-799, 859-877).
- **What:**
  - `withTransaction` calls the driver's `session.withTransaction()` directly instead of mongoose's `connection.transaction()`. Only the mongoose wrapper resets document state between retries.
  - On a retried callback (TransientTransactionError, e.g. WriteConflict), the settlement doc is already marked clean. `save()` sees no changes and goes through `handleEmptyUpdate`, which does a plain `findOne({_id})`. It never applies the custom `$where`, so neither the lease-epoch fence nor the `expected` state is checked.
  - The retried `Models.updateOne` succeeds, because the first attempt was rolled back. The transaction commits the model change without the settlement change.
- **Trigger:** The stats job (`jobs/stats.ts:70`, `15 */5 * * * *`) bulk-writes every model in a transaction at hh:05:15, while hourly settlement (`5 * * * *`) is writing the same docs. A WriteConflict on either side triggers the retry.
- **Impact:**
  - **convert:** consumes `sliceCarryOverMicroUsdc` / `pendingCompoundLamports`, but the settlement stays `paid_provider`. On resume it consumes the next carry too, and the USDC value disappears from accounting.
  - **buyOnCurve:** credits escrow twice / double-counts `pendingCompoundLamports` (phantom SOL).
  - **reservePayout:** carry is consumed twice, and the provider is under-paid.
- **Fix:** Use `mongoose.connection.transaction(fn)`, or perform explicit `Settlements.updateOne({_id, ...fence, ...expected}, {$set})` and assert `matchedCount === 1`. Make `saveIf` throw on an empty delta.

### KPR-02: High. Migration resend loop can strand a settlement permanently
- **Where:** `apps/keeper/src/settlement/steps.ts:~550`, `pendingTx.ts:126-130`.
- **What:** When `settlement.pendingTx` is set, `migrateIfComplete` skips `curveNeedsMigration`. A `dropped`/`failed` pending tx is followed by a fresh `migrate` send, without re-checking whether the pool already migrated (e.g. the pool poller, `poolPoller.ts:97`, migrated it first). Every resend fails on-chain. After 3 attempts the settlement is `failed`, and an admin retry repeats the same loop.
- **Also:** `steps.ts:560-566` overwrites `token.migrationSignature` with the failed signature, clobbering the poller's landed one.
- **Fix:** Re-run `curveNeedsMigration` (re-read `isMigrated`) after any non-landed resolution before sending. Write `migrationSignature` with a CAS on `null`.

### KPR-03: Medium. A resumed first add-and-lock never stores the new position's keys
- **Where:** `steps.ts:~657-663, ~719`.
- **What:** The keys of a newly created DAMM position are only persisted in the final transaction. If the keeper crashes after the lock is signed, resume takes the "lock landed" branch with `keys: keeperPosition(model)`, which is `null`. The position is never recorded:
  - `compound` (`~831`) never claims its fees.
  - The next run creates another position.
  - `lamportsUsed` overstates the SOL actually added.
- **Fix:** Persist the position keys (or include them in the `pendingTx` payload) in `onSigned` before sending the add.

### KPR-04: Medium. The SOL price guard can lock itself, and its reference is chosen by `updatedAt`
- **Where:** `steps.ts:~295-318`.
- **What:** The reference price only updates when a convert succeeds.
  - If SOL moves more than 30% while the keeper is idle, every convert throws `SolPriceRejectedError` from then on, and nothing can refresh the reference.
  - Any write to an old settlement (retry, fail, finalize) bumps its `updatedAt`, which makes its stale price the reference.
- **Fix:** Sort by a dedicated `pricedAt` field, widen the allowed deviation with the reference's age, or cross-check a second price source.

### KPR-05: Medium. A `processed`-only signature is treated as landed when resolving `pendingTx`
- **Where:** `apps/keeper/src/settlement/pendingTx.ts:56-57`, `packages/chain/src/client.ts:443-450` (returns `landed` for any status with `err === null`).
- **Trigger:** The keeper crashes after a payout send, and resume sees the tx `processed` on a minority fork that is later dropped. The step is marked done and the provider is never paid.
- **Fix:** Treat only `confirmed`/`finalized` as landed; keep polling while the status is `processed`.

### KPR-06: Medium. The per-run payout cap (G18) is bypassed for resumed settlements
- **Where:** `steps.ts:~252` (budget charged only in `reservePayout`), `orchestrator.ts:65-68, 95-96`.
- **Trigger:** Run N reserves 500 USDC and crashes before sending. Run N+1 sends it without charging the budget, then pays up to the cap again (2× `MAX_PAYOUT_USDC_PER_RUN` in one run).
- **Fix:** Charge the reserved amount against the run budget at send time, and defer the payout if it doesn't fit.

### KPR-07: Medium. Reconcile reports false "balance drift" under live traffic
- **Where:** `apps/keeper/src/jobs/reconcile.ts:61-70`, `packages/db/src/ledger.ts:446-458`.
- **What:**
  - Cached balances are read once for all users; `recomputeBalance` later reads the ledger outside that snapshot (it takes no `session`). Any capture or deposit in between produces a drift alert.
  - Held amounts (`heldMicroUsdc`) are never reconciled at all.
- **Fix:** Read the balance and the ledger sum per user in one snapshot transaction. Add a `recomputeHeld`.

### KPR-08: Low. Missed hours are never backfilled, and one model's error blocks all models
- **Where:** `orchestrator.ts:94-113`, `:50-51` (`mapLimit` aborts on the first throw), `scheduler.ts:31-34`.
- **What:**
  - Only the current period is opened, so downtime or an overlapping run leaves gaps in the hourly records (revenue folds into the next hour).
  - One thrown error in `resumeIn` stops new periods from opening for every model.
- **Fix:** Open all missing periods since each model's last settlement. Catch errors per model.

### KPR-09: Low. Delisted models' unsettled revenue is never paid out and is TTL-deleted after 90 days
- **Where:** `orchestrator.ts:97`, `jobs/floatMonitor.ts:31`, `packages/db/src/models/requests.ts:30`.
- **Fix:** Keep settling delisted models while they have untagged billed requests.

### KPR-10: Low. `settle-once` accepts future periods and parses `--period-start` as local time
- **Where:** `apps/keeper/src/cli/settle-once.ts:26`, `settlement/period.ts:14-19`.
- **What:** `new Date('2026-10-06T10:00:00')` (no `Z`) is parsed as local time. On an IST (+5:30) host it throws; on a whole-hour-offset host it silently settles the wrong hour. A future period is also settled early.
- **Fix:** Require an explicit `Z`/offset, and reject `periodEnd > now` without `--force`.

### KPR-11: Low. `isRetryable` matches `429|50[234]` anywhere in an error message
- **Where:** `apps/keeper/src/settlement/engine.ts:32-33, 46`.
- **What:** ObjectIds in messages (e.g. `model 6650...502... not found`) make permanent errors retryable.
- **Fix:** Use word boundaries, or check structured status codes.

### KPR-12: Low. Stats count curve buys as "locked liquidity"
- **Where:** `jobs/stats.ts:45-47`; `steps.ts:~481` sets `solAddedLamports = spend` for curve buys.
- **Fix:** Sum only settlements with `phase: 'graduated'`.

### KPR-13: Low. Float monitor overstates expected payouts
- **Where:** `jobs/floatMonitor.ts:42`.
- **What:** It caps each model at `maxPayout` but not the total at `MAX_PAYOUT_USDC_PER_RUN`, which raises false low-treasury alerts.

### KPR-14: Low. Shutdown doesn't drain running jobs and can produce an unhandled rejection
- **Where:** `apps/keeper/src/main.ts:97-107`.
- **What:** `lease.stop()` → `disconnectDb()` → `process.exit(0)` runs while a settlement transaction is in flight. A throw inside `void shutdown()` becomes an unhandled rejection.
- **Fix:** Add a scheduler `drain()` with a timeout, and wrap shutdown in try/catch.

### KPR-15: Low. Health server `listen` errors are unhandled
- **Where:** `apps/keeper/src/main.ts:88`.
- **What:** `EADDRINUSE` emits `'error'` with no listener and crashes the process.

### KPR-16: Low. One failed lease renewal is treated as losing the lease
- **Where:** `apps/keeper/src/lease.ts:100-114`.
- **What:** A single DB blip calls `onLost`, which aborts the in-flight run even though the lease is still valid for about 60 s.
- **Fix:** Retry until the lease deadline passes before declaring it lost.

### KPR-17: Low (platform-dependent). Lease holder ID is `hostname:pid`
- **Where:** `apps/keeper/src/main.ts:72`, `lease.ts:57,63`.
- **What:** In containers, pid 1 plus a shared or static hostname makes two replicas look like the same holder, which defeats fencing.
- **Fix:** Append `randomUUID()` to the holder ID.

---

## 2. Chain package (`packages/chain`)

### CHN-01: High. The retry after a blockhash expiry can double-send payouts, buys and swaps **[verified]**
- **Where:** `packages/chain/src/send.ts:92-103` (`hasLanded`), `:157-161`. In the keeper, `pendingTx.ts:134-140` replaces the stored signature in `onSigned`.
- **What:** After `TransactionExpiredBlockheightExceededError`, a single `getSignatureStatuses` call that returns `null` (lagging or load-balanced RPC) or `processed` is taken as proof the tx is dead. The code re-signs with a new blockhash and sends again.
  - The robust check already exists in `client.ts:458-474` (`expiredSignatureStatus`: finalized block height plus `getMinimumLedgerSlot`), but `sendAndConfirm` doesn't use it.
  - The first signature is overwritten in `pendingTx`, so the keeper can't detect the duplicate.
- **Impact:** The provider is paid twice (`transferUsdc`), or `curveBuy`/`dammSwap` executes twice.
- **Fix:** In the expiry branch, either throw `chain_send_failed` and let the caller resolve the signature, or run the same finalized-height and min-ledger-slot check before re-signing.

### CHN-02: High. DAMM v2 slippage passed in percent, but the SDK expects bps (100× too tight) **[verified]**
- **Where:** `packages/chain/src/damm.ts:105` (`slippage: slippageBps / 100`). The test `packages/chain/test/damm.test.ts:~115` asserts the wrong value (`slippage: 1` for 100 bps).
- **Proof:** cp-amm-sdk 1.5.1 `getQuote`/`getQuote2` → `swapQuoteExactInput(..., slippage)` → `getAmountWithSlippage(amount, slippageBps)` computes `amount * (10000 - slippageBps) / 10000` (`dist/index.js:10771-10785`).
- **Impact:** 100 bps becomes 1 bps (0.01%), and 50 bps becomes 0.5, which BN truncates to 0. Keeper half-swaps fail with `ExceededSlippage` on any concurrent trade and are retried up to 3× with fees each time.
- **Fix:** Pass `slippage: slippageBps`, and update the test. See WEB-01 for the same bug in the web app.

### CHN-03: Medium. Curve buy records quoted amounts, not actual ones
- **Where:** `packages/chain/src/dbc.ts:162-167` (returns `amountIn: lamports` and ignores PartialFill `amountLeft`/`includedFeeInputAmount`), `client.ts:311` (returns quoted `outAmount`). The keeper uses these at `steps.ts:~497` (escrow) and `~510` (leftover).
- **Impact:**
  - Escrow is overstated, so later `addAndLock(maxTokens: escrow)` fails because the wallet holds fewer tokens.
  - Lamports a partial fill didn't spend are never accounted for.
- **Fix:** Derive the real amounts from post-confirmation token-balance deltas.

### CHN-04: Medium. Add-liquidity has zero slippage room, and the same stale tx is resent after an on-chain failure
- **Where:** `client.ts:378-382, 394, 405`; `damm.ts:184-190`.
- **What:** `tokenA/BAmountThreshold` equal the quoted amounts exactly, and the tx is passed as `{ tx }` rather than `buildTx`. `send.ts:153-155` therefore retries identical, failing instructions.
- **Fix:** Add a slippage buffer to the thresholds and re-quote in `buildTx`, or don't retry on-chain errors for non-rebuildable txs.

### CHN-05: Medium. `verifyLaunch` doesn't bind the signature to the pool or check commitment
- **Where:** `packages/chain/src/dbc.ts:127-131`.
- **What:** Any successful signature (even an unrelated or only `processed` one) is accepted and stored publicly as `token.launchSignature` (`apps/api/src/modules/tokens/service.ts:143`).
- **Also:** The reason `launch_tx_failed` (`dbc.ts:131`) doesn't match the key `tx_failed` in `POOL_MISMATCH_MESSAGES` (`tokens/service.ts:33`), so users get the generic message.
- **Fix:** Fetch the parsed tx at `confirmed`+, require a DBC instruction touching the derived pool, and fix the key.

### CHN-06: Low–Medium. Price fetch has no timeout and no staleness check
- **Where:** `packages/chain/src/price.ts:44`.
- **What:** A hung Jupiter call stalls settlement while the lease is held.
- **Fix:** Use `AbortSignal.timeout(10_000)`, and reject stale quotes (`blockId`).

### CHN-07: Low. `signatureStatus` returns `landed` for `processed`
- **Where:** `client.ts:443-450`. This is the root cause of KPR-05.

### CHN-08: Low (unconfirmed). Deposit parser doesn't check who authorized inner transfers
- **Where:** `packages/chain/src/deposit.ts:60-63, 119-121`.
- **What:** Inner-instruction transfers into the treasury ATA count toward the depositor's credit, and the transfer authority isn't required to be a signer. If any permissionless program path pays USDC into the treasury ATA (the treasury is also the DBC `feeClaimer`/`leftoverReceiver`, `config.ts:106-107`), an attacker could wrap it with their memo and be credited with platform funds.
- **Fix:** Require the transfer's authority/owner to be a signer of the tx.

---

## 3. API: gateway (`apps/api/src/modules/gateway`)

### GW-01: High. Reasoning / legacy `function_call` / `refusal` output is never billed **[verified]**
- **Where:** `sse.ts:52-55` (`hasOutput`), `sse.ts:105-117` (`onChoice`), `sse.ts:45-49` (`completionText`), `completions.ts:145-154`, `stream.ts:190-193`.
- **What:** Only `delta.content` and `delta.tool_calls` count as output.
- **Trigger A (free output):** On a reasoning upstream (DeepSeek/vLLM `reasoning_content`), a client streams the reasoning deltas and disconnects before any `content` delta. `usage` hasn't arrived and `hasOutput()` is false, so the hold is released and the call is billed 0 while the provider pays its upstream.
- **Trigger B (undercount):** On upstreams without usage, the token-count fallback bills `function_call`/reasoning output as 0.
- **Also:** `assemble()` drops `function_call` from the idempotent replay.
- **Fix:** Treat any non-empty, non-`role` delta field as output, and include it in `completionText`.

### GW-02: Medium. Media prompts are under-estimated and the bill is capped at the hold **[verified]**
- **Where:** `tokenCount.ts:53-68, 85` (flat 2048/8192 tokens per image/file/audio), `:141` (media skips the size check), `completions.ts:247` (`billed = min(cost, estimate)`).
- **Trigger:** A large PDF `file_data` with `max_tokens: 1`. The upstream reports ~150k prompt tokens; the user pays for ~8k.
- **Fix:** Scale the media surcharge with payload size, cap media parts per request, and/or capture up to the actual cost bounded by available balance.

### GW-03: Medium. A client that disconnects before the `close` listener is attached goes undetected **[verified]**
- **Where:** `stream.ts:73` (`openHold`) and `router.ts:115-119` (`prepare()`, including the RPC discount lookup) run before `res.on('close')` at `stream.ts:~103-106`.
- **What:** If the client is already gone, `close` never fires. `res.write()` on a destroyed response returns `false` without emitting `drain`, so `await once(res,'drain')` waits until the 300 s total timer.
- **Impact:** The hold and an upstream socket stay occupied for 5 minutes, and output nobody received can be billed (status `timeout`).
- **Fix:** After attaching the listener, call `stop('client')` immediately if `res.destroyed || req.socket.destroyed`; check `res.destroyed` around each write.

### GW-04: Medium. Upstream responses have no size limit (providers are untrusted, since any user can register a model)
- **Where:** `completions.ts:127` (`res.body.text()`), `sse.ts:31-33` (buffer), `sse.ts:116-117` (accumulated text).
- **What:**
  - A multi-GB body, or an SSE stream that never sends `\n\n`, grows memory until the process runs out (OOM).
  - The buffer is re-split in full on every push, so a large event in small chunks costs O(n²) CPU.
- **Fix:** Byte caps (e.g. 8 MB non-stream, 1 MB pending SSE event); scan only the newly appended bytes for the separator.

### GW-05: Medium. The idempotency key is freed after the call was already billed
- **Where:** `router.ts:145-149` (partial stream is captured but returns `null`, so `abandonIdempotency` runs), `router.ts:157-166` (`completeIdempotency` throws after capture, and the key is abandoned).
- **Impact:** A retry with the same `Idempotency-Key` is charged a second time.
- **Fix:** Store a terminal "billed, not replayable" record instead of deleting, or write the idempotency response in the capture transaction.

### GW-06: Medium. In-flight idempotency rows block the key for 24 h after a crash
- **Where:** `packages/db/src/models/idempotency.ts:9-10, 20`.
- **What:** If the API restarts mid-request, the `response: null` row only expires via the 24 h TTL. Every retry gets 409 `idempotency_in_progress`.
- **Fix:** Add `lockedUntil = now + TOTAL_TIMEOUT_MS`, and let `claimIdempotency` take over expired locks with a CAS.

### GW-07: Medium. `X-Request-Id` is client-chosen but globally unique across tenants
- **Where:** `apps/api/src/middleware/requestId.ts:13-14`, `completions.ts:204`, unique indexes in `packages/db/src/models/ledger.ts:44-47` and `models/requests.ts:29`.
- **Impact:**
  - User A can pre-claim predictable IDs (`req-1`…) and make user B's requests fail with 400 "X-Request-Id was already used".
  - It works as an existence oracle across users.
  - An SDK that reuses its request ID on retry is permanently rejected.
- **Fix:** Generate the internal ID server-side and store the client's ID separately, or scope the indexes by `userId`.

### GW-08: Low. The rate limit can be bypassed with multiple keys, and auth runs before limiting
- **Where:** `router.ts:96-103`, `middleware/rateLimit.ts:18-27`, `modules/keys/router.ts:19-23`.
- **What:**
  - The limit is per API key, and key creation is unlimited and not rate-limited, so N keys give N× throughput.
  - The store is in memory per replica.
  - Invalid-key floods hit Mongo with no limit.
- **Fix:** Add a per-user bucket, an IP limiter before auth, a max-keys-per-user cap, and a shared store.

### GW-09: Low. The holder discount is cached per wallet for 5 min, so the same tokens can be moved between wallets
- **Where:** `discount.ts:28`.

### GW-10: Low. Discount rounding makes 1-micro calls free **[verified]**
- **Where:** `packages/shared/src/pricing.ts:~55-57` (floor applied after `computeCostMicro`'s ceil).
- **Example:** `floor(1 × 9000 / 10000) = 0`.
- **Fix:** Use ceil, or charge a minimum of 1 micro when the gross cost is above 0.

### GW-11: Low. The idempotency body hash depends on JSON key order
- **Where:** `idempotency.ts:35`.
- **Fix:** Hash a canonical (key-sorted) serialization.

### GW-12: Low (unconfirmed)
- **Release after delivery:** If `capture` throws after a fully delivered stream, `stream.ts:76-80` releases the hold, so the output is free.
- **SIIT addresses:** `::ffff:0:a.b.c.d` (SIIT) addresses pass `isPublicAddress` in `lib/upstreamAgent.ts`; add `::ffff:0:0:0/96` to the blocklist.
- **SSE parsing:** The parser ignores bare-CR line endings and `event: error` frames.

---

## 4. API: auth, keys, admin, billing, app

### API-01: Medium. `TRUST_PROXY=1` by default, so a spoofed `X-Forwarded-For` bypasses the admin IP allowlist and every IP rate limit
- **Where:** `apps/api/src/env.ts:18-26`, `app.ts:127`, `middleware/adminAuth.ts:46`, `modules/auth/router.ts:15`, `modules/admin/router.ts:15`, `apps/api/.env.example:23-24`.
- **What:** If the origin port is reachable directly (not only through the proxy), the client controls `req.ip`.
  - It can spoof any allowlisted IP. The startup warning (`main.ts:43-48`) only covers loopback-only allowlists.
  - It gets a fresh rate-limit bucket on every request (unlimited nonce creation and admin-token guessing).
  - An empty `ADMIN_IP_ALLOWLIST` allows every IP.
- **Fix:** Make `TRUST_PROXY` required (or a subnet list) in production, warn whenever an allowlist is set, and reject an empty allowlist on mainnet.

### API-02: Medium. An owner can undo an admin pause **[verified]**
- **Where:** `apps/api/src/modules/models/service.ts:192-199` (only `delisted` is blocked), `modules/admin/service.ts:55-57`.
- **Trigger:** An admin pauses an abusive model; the owner sends `PATCH {"status":"active"}`, which re-activates it and resets the failure counter.
- **Fix:** Record `pausedBy` and refuse owner resumes of admin or health pauses.

### API-03: Low. Delist race on model update **[verified]**
- **Where:** `models/service.ts:209-215`.
- **What:** The update filter is `{_id, providerId}` only, so a delist between the read and the write can be reverted.
- **Fix:** Add `status: {$ne: 'delisted'}` to the filter.

### API-04: Medium. `/metadata` is covered by the global CORS rule **[verified]**
- **Where:** `apps/api/src/app.ts:143` (`cors({ origin: [WEB_ORIGIN] })` applied globally).
- **Impact:** Browser-based wallets, explorers and DEX UIs on other origins cannot fetch `/metadata/<mint>.json`.
- **Fix:** Mount `/metadata` with `cors({ origin: '*' })`.

### API-05: Medium. Public token quote endpoint has no rate limit and costs 3 RPC calls per request
- **Where:** `apps/api/src/modules/tokens/router.ts:53-56`.
- **What:** An anonymous loop can drain the RPC quota shared with deposits and the keeper.
- **Fix:** Add an IP limiter and a short-lived cache of pool state.

### API-06: Medium. Launched token's on-chain name, symbol and URI are never checked
- **Where:** `apps/api/src/modules/tokens/service.ts:122-147`, `packages/chain/src/dbc.ts:133-138`.
- **What:** A creator can launch with an impersonating symbol or name and a phishing metadata URI, and still be listed.
- **Fix:** Read the Metaplex metadata PDA; require `uri === ${API_ORIGIN}/metadata/<mint>.json` and a matching symbol.

### API-07: Low. `prepareLaunch` ignores model status and can orphan an on-chain mint
- **Where:** `tokens/service.ts:55-83`.
- **What:**
  - Paused or delisted models can launch.
  - Re-preparing while `pending` overwrites `token.mint` even if a pool already exists for it. Combined with WEB-02, this costs users a second pool.
- **Fix:** Require `status === 'active'`, and refuse to change the mint once its pool exists.

### API-08: Low. Oversized USDC strings return a 500 instead of a 400 (and feed the 5xx alert)
- **Where:** `packages/shared/src/schemas/common.ts:40-42`, `modules/keys/service.ts:53-56`.
- **What:** `"99999999999999"` becomes about 1e20 micro, which is above int64, so mongoose `castBigInt` throws. Quote amounts have the same problem (`schemas/tokens.ts:57`, unbounded `^[1-9]\d*$`).
- **Fix:** Cap the digits / refine to ≤ 2^63-1 (u64 for quotes).

### API-09: Low. Users can trigger the rejected-deposit alert and burn RPC calls with random signatures
- **Where:** `apps/api/src/modules/billing/service.ts:58-78, 95-102`.
- **What:** `tx_not_found` with status `unknown` is recorded as a rejection, which raises an alert after 6 per hour. A genuine deposit submitted before the RPC has indexed it gets a non-retryable `deposit_invalid`.
- **Fix:** Return a retryable error and don't record or alert for `tx_not_found`.

### API-10: Low. One auth limiter (10/min per IP) is shared by nonce, verify and logout
- **Where:** `modules/auth/router.ts:15`.
- **What:** Each sign-in uses 2 requests, so about 5 users behind one NAT lock each other out.

### API-11: Low. Usage query rejects valid same-day ranges
- **Where:** `packages/shared/src/schemas/billing.ts:42` vs `billing/service.ts:177-180`.
- **Example:** `from=2024-01-01T12:00:00Z&to=2024-01-01` → 400.

### API-12: Low. Errors after headers are sent, and streamed failures, never reach the 5xx alert
- **Where:** `middleware/errorHandler.ts:49-51`, `alerts.ts:118`.

### API-13: Low. The alert window stores every response timestamp, and `/healthz` is unauthenticated
- **Where:** `alerts.ts:18-38`.
- **What:** Unbounded array growth with an O(n) `splice` on every request.
- **Fix:** Use a ring of per-second counters.

### API-14: Low. `syncIndexes()` runs on every boot
- **Where:** `apps/api/src/main.ts:51` → `packages/db/src/models/index.ts:43-48`.
- **What:** It drops undeclared, operator-created indexes, and concurrent boots race on create/drop.
- **Fix:** Run index sync as a migration step, or use `createIndexes()`.

### API-15: Low. `internal` AppError messages leak to clients
- **Where:** `packages/shared/src/errors.ts:62, 77`; e.g. `ledger.ts:302-304` (`hold <id> is expired`).
- **Fix:** For `httpStatus >= 500`, serialize the catalog message only.

### API-16: Low. Health latency map grows without bound
- **Where:** `apps/api/src/modules/models/health.ts:20` (`latencySamples`).

### API-17: Low. `UpstreamBaseUrlSchema` allows `http://`, so provider API keys are sent in cleartext

---

## 5. Data layer (`packages/db`) and shared (`packages/shared`)

### DB-01: Medium. The ledger doesn't enforce capture ≤ hold
- **Where:** `packages/db/src/ledger.ts:290, 314-320`.
- **What:** Only the gateway's `billedCost` clamp prevents a negative spendable balance. Any other caller can overdraw and inflate the daily-cap reservation.
- **Fix:** Throw or clamp when `costMicro > hold.amount` inside the transaction.

### DB-02: Low–Medium. `adjust()` has no floor for negative deltas
- **Where:** `ledger.ts:421-443`.
- **Fix:** Add an `$expr` guard (`balance - held ≥ -delta`), or require an explicit `allowNegative`.

### DB-03: Medium (latent). `credit()` isn't idempotent on its own
- **Where:** `ledger.ts:393-419`, `models/ledger.ts:41-47`.
- **What:** Deposits are only safe because `Deposits.txSignature` is inserted in the same transaction. The `settlementId` credit path has no protection.
- **Fix:** Add partial unique indexes on `ref.txSignature` (deposit) and `ref.settlementId`.

### DB-04: Medium (performance). The capture lookup by `ref.holdId` has no index
- **Where:** query at `ledger.ts:306`; indexes at `models/ledger.ts:41-47`.
- **What:** A collection scan inside a transaction, which gets slower as the ledger grows.
- **Fix:** `index({'ref.holdId': 1}, {unique: true, partialFilterExpression: {type: 'capture'}})`.

### DB-05: Low. Daily-cap spend is double-counted across UTC midnight
- **Where:** `ledger.ts:141-169, 320`.
- **What:** A hold opened at 23:59 and captured at 00:00 is counted on both days' rows.

### DB-06: Low (latent). Telegram alerts throw on BigInt and serialize `Error` as `{}` **[runtime-verified by audit]**
- **Where:** `packages/shared/src/node/telegram.ts:45, 93-94`.
- **What:** `formatTelegramText` runs outside the try/catch, so `alert()` rejects.
- **Fix:** Use a JSON replacer and move the formatting inside the try.

### DB-07: Low. Logger redaction gaps
- **Where:** `packages/shared/src/node/logger.ts:4-26`.
- **What:**
  - `*.apiKey` only matches one level deep.
  - `RPC_URL`/`RPC_URL_FALLBACK` (Helius key in the URL), `MONGODB_URI`, `JUPITER_API_KEY` and `DEVNET_FUNDER_SECRET_KEY` aren't listed.
  - Settlement alerts forward raw error strings (`keeper/src/settlement/engine.ts:84-92`) that may contain the RPC URL.

### DB-08: Low. `selfPing` drops any path in `baseUrl`
- **Where:** `packages/shared/src/node/selfPing.ts:40`.
- **What:** `new URL('/healthz', 'https://host/api')` resolves to `https://host/healthz`.

---

## 6. Web app (`apps/web`)

### WEB-01: High. Trade panel DAMM slippage is 100× too tight (same bug as CHN-02) **[verified]**
- **Where:** `apps/web/src/lib/trade.ts:143-144`. The comment "cp-amm takes slippage in percent" is wrong for `getQuote`/`getQuote2`.
- **Impact:** The default 1% slippage becomes 0.01%. Post-graduation trades fail with `ExceededSlippage` whenever the price moves at all.
- **Fix:** Pass `slippage: request.slippageBps`.

### WEB-02: High. A failed launch confirm leads to a second paid pool, and the first is orphaned
- **Where:** `apps/web/src/components/LaunchWizard.tsx:276-318` with `apps/api/src/modules/tokens/service.ts:65-68`.
- **What:** `generateMint()` runs on every click. If `/launch/confirm` fails after `createPool` landed, the button returns. A retry signs and pays for a new pool, and the API overwrites the pending mint.
- **Fix:** Persist `{mint, signature}` once signed, offer "Retry confirmation", and on the server refuse a re-prepare while a pool exists (API-07).

### WEB-03: High (functional). A registered but unlaunched model can never be launched from the UI
- **Where:** `LaunchWizard.tsx:175-194` (always starts at step 0, which POSTs a new model), `lib/auth.ts:1-2` (session is memory-only), `pages/ProviderPage.tsx:249-254`.
- **What:** After a reload, JWT expiry or wallet switch, re-registering conflicts on the slug, and the provider page has no "continue launch" flow.

### WEB-04: Medium. The partner (platform) share of DBC fees can't be claimed anywhere
- **Where:** `components/ClaimFees.tsx:42, 146-149`, `pages/ProviderPage.tsx:247`, `lib/queries.ts:122`, `lib/claims.ts:16-17`.
- **What:** `resolveClaimRole` returns `'creator'` before it checks `feeClaimer`, and the component only renders for the provider, so `claimPartnerTradingFee` is never built.

### WEB-05: Medium. No route `errorElement`; any render-time throw replaces the whole app
- **Where:** `apps/web/src/router.tsx:13-26`.
- **Throwing sites:**
  - `new PublicKey(...)` in `TradePanel.tsx:39,44`.
  - `formatDecimal`/`usdcStringToMicro` in `ModelStats`, `ModelCard`, `DashboardPage`, `SettlementTable`, `ProviderPage` and `PriceChart`.
  - API responses cast without schema parsing in `queries.ts:42,53,64,118`.
- **Fix:** Add an `errorElement`, and zod-parse responses in `queryFn`.

### WEB-06: Medium. Program and token errors are shown as raw simulation JSON
- **Where:** `apps/web/src/hooks/useSendTx.ts:93-99, 111`.
- **What:**
  - The insufficient-funds regex misses SPL `Error: insufficient funds` / `Custom: 1`.
  - `AccountNotFound` is reported as "Not enough SOL".

### WEB-07: Low. Deposit invalidates the nonexistent `['ledger']` key, and "Check again" never refreshes `['me']`
- **Where:** `components/DepositUsdc.tsx:124, 135-144`.

### WEB-08: Low. Deposit polling keeps running after the component unmounts
- **Where:** `DepositUsdc.tsx:41-63`.
- **What:** Up to 24 POSTs, with no abort.

### WEB-09: Low. No scroll reset on navigation
- **Where:** `router.tsx` / `components/Layout.tsx`.
- **Fix:** Add `<ScrollRestoration/>`.

### WEB-10: Low. The "shown once" API key dialog has no focus trap, and the key is lost if the session drops
- **Where:** `components/ApiKeyManager.tsx:35-41`.

### WEB-11: Low. Amount inputs reject `.5` and `1.`
- **Where:** `TradePanel.tsx:51-61`, `DepositUsdc.tsx:104`.

### WEB-12: Low. Provider-models pagination loop has no termination guard and downloads the whole registry
- **Where:** `lib/queries.ts:117-124`.

### WEB-13: Low. Launch invalidates wrong query keys
- **Where:** `LaunchWizard.tsx:314`.
- **What:** `['token', slug]` matches nothing; `providerModels` and `tokenState` are never invalidated.

### WEB-14: Low. The SPA rewrite serves `index.html` for missing `/assets/*`, cached as immutable
- **Where:** `apps/web/vercel.json:7, 10-11`.
- **What:** After a redeploy, stale chunks are served as HTML, which breaks lazy imports (e.g. a wallet adapter).
- **Fix:** Use `"source": "/((?!assets/).*)"`.

### WEB-15: Low. `site.webmanifest` has no `start_url`/`scope`

### WEB-16: Hygiene. Local secrets in untracked files
- `apps/web/.env` contains a plaintext Google `generativelanguage` API key. It is gitignored and not `VITE_`-prefixed, so it isn't bundled, but it should be rotated and removed.
- `apps/web/playwright-report/.env.production` is also present.

---

## 7. Infrastructure, CI, scripts

### INF-01: High. CI is failing on `main`: `.env.example` files and the README are missing env keys **[verified]**
- **Where:** `apps/api/.env.example`, `apps/keeper/.env.example`, README env table. The keys are read at `apps/api/src/env.ts:83-84` and `apps/keeper/src/env.ts:32-33`.
- **What:** `SELF_PING_URL` and `RENDER_EXTERNAL_URL` are missing, so 2 of 16 tests in `scripts/test/env-consistency.test.ts` fail.
- **Fix:** Add both (commented) to both `.env.example` files and to the README table with "api, keeper".

### INF-02: High. `scripts/devnet-e2e.ts` never checks that `RPC_URL` is devnet
- **Where:** `scripts/devnet-e2e.ts:143-155, 250-259`.
- **What:** Unlike `refill-float`/`create-config`, there is no `assertRpcCluster` call. With a mainnet RPC and a funder key that holds real SOL, about 2 SOL is sent to throwaway keypairs that are never saved.
- **Fix:** Call `await assertRpcCluster(connection, 'devnet')` before `fund()`.

### INF-03: Medium. Node 20 is end-of-life (2026-04-30) everywhere, and engines `<21` blocks upgrading
- **Where:** `Dockerfile:2, 33`, `.github/workflows/ci.yml:34, 108`, `.nvmrc`, `package.json:8`.

### INF-04: Medium. Keeper and api can use different USDC mints
- **Where:** `apps/keeper/src/runtime.ts:93, 104` (uses `env.USDC_MINT`, validated only with `min(32)`) vs `apps/api/src/main.ts:16, 36-41` (uses `USDC_MINT[CLUSTER]`).
- **What:** The `.env.example` files ship the devnet mint. On mainnet the keeper would pay out on the devnet mint address.
- **Fix:** Refuse to start when `env.USDC_MINT !== USDC_MINT[CLUSTER]`.

### INF-05: Medium. The web deposit address is configured independently of the api's treasury
- **Where:** `apps/web/src/lib/solana.ts:32-38`, `apps/web/src/env.ts:9-10` vs `apps/api/src/modules/billing/service.ts:49`.
- **What:** A wrong `VITE_TREASURY_USDC_ATA` sends users' USDC to an account that is never credited.
- **Fix:** Derive the ATA from the treasury wallet and mint, or serve the deposit address from the api.

### INF-06: Medium. `scripts/seed-models.ts` writes an active mock model to any database
- **Where:** `scripts/seed-models.ts:180-199, 264-282`.
- **What:** The local-only guard applies only to `--dev-credit`/`--fake-token`. A plain run against prod upserts or overwrites `mock-llm`.
- **Fix:** Apply `assertLocalOnly` to every mode, or require `--allow-remote`.

### INF-07: Medium. The mock upstream's `calls` array grows forever and stores bearer tokens
- **Where:** `apps/mock-upstream/src/server.ts:132, 144-147`.
- **What:** The standalone server is deployed long-running (Render).

### INF-08: Low. The keeper parses env keys it never uses, and its validation is weaker than the api's
- **Where:** `apps/keeper/src/env.ts:14, 17-19, 22, 29, 38`.
- **What:**
  - `DBC_CONFIG`, `DAMM_V2_FEE_CONFIG`, `TREASURY_WALLET` and `DEVNET_E2E` are unused.
  - `TREASURY_WALLET` is never checked against `TREASURY_SECRET_KEY`.
  - `ADMIN_TOKEN` has no minimum length, so `replace-me` passes.
  - `RPC_URL_FALLBACK` isn't validated as a URL.

### INF-09: Low. Dockerfile issues
- No `HEALTHCHECK` (the api has `/readyz`; the keeper serves `:4001`).
- `COPY --chown=node:node /app /app` (`Dockerfile:36`) lets the runtime user rewrite its own code.
- The whole build tree (web source, scripts, tests, `tsx`) ships in the runtime image; use `pnpm deploy --prod`.
- `docker-compose.yml:4` uses a floating `mongo:7` tag, while tests pin 7.0.14.

### INF-10: Low. The CI nightly job exposes secrets job-wide
- **Where:** `ci.yml:96-102`.
- **What:** `RPC_URL`, `DEVNET_RPC_URL` and `JUPITER_API_KEY` are visible to `pnpm install` lifecycle scripts.
- **Fix:** Move them to step-level `env`.

### INF-11: Low. Mock server mishandles empty env values
- **Where:** `apps/mock-upstream/src/main.ts:5, 14`.
- **What:** `MOCK_UPSTREAM_PORT=` binds a random port (`Number('') === 0`). `MOCK_UPSTREAM_API_KEY=` rejects every request.
- **Fix:** Use `||` instead of `??`.

### INF-12: Low. Miscellaneous config
- `apps/mock-upstream/tsconfig.test.json:9` has `"references": []` but imports `@ibt/shared/node`.
- `.npmrc` lacks `engine-strict=true`.
- `scripts/devnet-e2e.ts:239-243` never drops its `ibt_devnet_e2e_<ts>` database.

### DEP-01: Medium. Vulnerable transitive dependencies (`pnpm audit --prod`)
| Severity | Package | Fixed in | Path |
| --- | --- | --- | --- |
| High | `bigint-buffer` ≤1.1.5 (buffer overflow in `toBigIntLE`) | none | `@solana/spl-token > @solana/buffer-layout-utils` |
| High | `toml` <4.2.0 (prototype pollution, uncontrolled recursion) | 4.2.0 | `@meteora-ag/dynamic-bonding-curve-sdk > @coral-xyz/anchor` |
| High | `braces` ≤3.0.3 (stack-exhaustion DoS) | none | wallet-adapter → react-native → metro |
| Moderate | `react-router` <7.18.0 (open redirect via backslash in `<Link>`/`useNavigate`) | 7.18.0 | `react-router-dom` (**direct dependency**, upgrade it) |
| Moderate | `stream-json` <3.6.0 (prototype pollution, DoS) ×3 | 3.6.0 | `@solana/web3.js > jayson` |
| Moderate | `uuid` <11.1.1 | 11.1.1 | `@solana/web3.js > jayson` |

**Fix:** Bump `react-router-dom` to ≥7.18. Add `pnpm.overrides` for `toml`, `stream-json` and `uuid`. Most of these are browser-side or build-time only, so their real risk is lower than the advisory severity suggests.

---

## Checked and found sound (not issues)
- **Sign-in:** nonces are single-use (atomic `findOneAndDelete`) with an expiry check and TTL; the message is rebuilt server-side.
- **JWT:** HS256 pinned; `iss`/`aud`/`sub`/`exp` required; `tokenVersion` revocation; secret ≥ 32 characters.
- **Admin token:** `timingSafeEqual` over SHA-256 digests.
- **API keys:** 32 random bytes, stored as SHA-256 with a unique index.
- **Deposits:** unique `txSignature`; credited at `finalized`; mint, destination ATA and memo `depositRef` checked; `meta.err` rejected.
- **Holds:** concurrent holds can't overdraw (atomic `$expr` update); capture vs release is a CAS on `status: 'open'`.
- **Money:** BigInt end-to-end (`useBigInt64`); splits are exact, with the platform taking the remainder.
- **SSRF:** decimal/hex/octal IPv4 and IPv4-mapped IPv6 are blocked; address checked at connect time (DNS-rebinding safe); undici doesn't follow redirects.
- **Gateway request shape:** user `Authorization` is never forwarded upstream; `max_tokens` is forced to the held value; `n = 1`.
- **NoSQL injection:** Express 5 `simple` query parser, zod-validated inputs, `strictQuery`, validated cursors.
- **Web:** no `dangerouslySetInnerHTML`; JWT kept in memory only; signs out on wallet switch; BigInt amount parsing; double-submit guarded.
- **Container and CI:** container runs as `node`; `.env*` excluded from the image; CI actions pinned to SHAs; `contents: read` permissions.
