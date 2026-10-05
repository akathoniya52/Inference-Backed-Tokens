# The logic behind Inference-Backed Tokens

This document explains _why_ the system works the way it does: the economic idea, the money flow, and the rules each component follows. For setup and commands see [`README.md`](README.md); for the full design spec see [`Plan.md`](Plan.md).

## 1. The core idea

Most launchpad tokens have nothing behind them except attention. Here, every token belongs to an AI model, and the token's market is driven by how much that model is actually used.

```text
consumer pays USDC for inference
        │
        ▼
 revenue is split every hour
        │
        ├── 70% → provider (USDC)
        ├── 20% → buys the model's token and locks it as liquidity forever
        └── 10% → platform
```

Because 20% of real revenue keeps buying the token and locking liquidity:

- more paid requests mean more buy pressure on the token,
- the locked liquidity can never be withdrawn, so the market only gets deeper over time,
- the numbers behind the token (requests, success rate, revenue, liquidity locked) are measured by the platform and shown publicly on the token page.

The token's value follows **measured demand for compute**, not hype.

## 2. Who does what

| Actor            | What they do                                                           | What they get                                                                                   |
| ---------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Provider**     | Lists a model behind an OpenAI-compatible endpoint, launches its token | 70% of inference revenue in USDC, plus the creator share of trading fees                        |
| **Consumer**     | Calls one API (`/v1/chat/completions`) across all listed models        | Pay-per-token inference with a USDC balance                                                     |
| **Token holder** | Buys the model's token                                                 | A market backed by real usage, and a 10% discount on that model when holding ≥ 1,000,000 tokens |
| **Platform**     | Runs the gateway, keeper and website; owns the Meteora partner config  | 10% of revenue plus the partner share of trading fees                                           |
| **Keeper**       | Background worker with the only hot wallet                             | Moves money: pays providers, buys tokens, locks liquidity                                       |

## 3. Separation of powers

The system is split so that no single part can both decide and move money.

| Component            | Can read the chain | Can sign transactions                  | Role                                                                      |
| -------------------- | ------------------ | -------------------------------------- | ------------------------------------------------------------------------- |
| `apps/web` (browser) | Yes                | Only through the **user's own wallet** | Builds launch, trade, deposit and claim transactions; the user signs them |
| `apps/api`           | Yes                | **Never**                              | Meters inference, keeps the ledger, verifies on-chain results             |
| `apps/keeper`        | Yes                | Yes (treasury + keeper keys)           | The only component that moves money                                       |

Rules that follow from this:

- User transactions never pass through the server. The browser builds them, the wallet signs, and the api only **verifies** what landed on-chain.
- The api refuses to start if a secret key is in its environment.
- The keeper never calls a provider's model; the api never signs with the keeper's key.

## 4. Token lifecycle on Meteora

Every model token is launched under **one platform-owned DBC partner config**, so every token has the same rules.

```text
 none ──launch──▶ curve ──threshold reached──▶ graduated
 (no token)      (Meteora DBC)                 (Meteora DAMM v2)
```

### 4.1 The partner config (same rules for every token)

| Rule                 | Value                                    | Why                                                           |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| Supply               | 1,000,000,000 tokens, 6 decimals         | Fixed and predictable                                         |
| Quote token          | SOL                                      | Standard launchpad UX; the keeper's float is in SOL           |
| Curve                | 80% of supply sold along the curve       | The remaining 20% plus the raised SOL seed the graduated pool |
| Graduation threshold | 10 SOL on mainnet, 1 SOL on devnet       | Low enough that real usage can complete the curve             |
| Anti-sniper fee      | 30% → 1% over the first 60 minutes       | Early snipers pay the most                                    |
| Trading fee split    | Protocol 20%, provider 40%, platform 40% | Providers earn from trading, not only from inference          |
| Metadata             | Immutable                                | Name and symbol can't be changed after launch                 |
| Migrated liquidity   | 100% permanently locked                  | Nobody can pull the liquidity after graduation                |

### 4.2 Launch

1. The provider registers the model and its upstream endpoint.
2. The api runs a **health check** (a 1-token completion). The model must answer before launch is allowed.
3. The browser generates a new mint keypair; the api stores token metadata for it (`/metadata/<mint>.json`).
4. The provider's wallet signs DBC `createPool`. The provider pays the fees and becomes the pool creator.
5. The api reads the pool on-chain and checks that the creator is the provider and the config is the platform's before it marks the token `curve`.

### 4.3 On the curve

- Anyone can buy or sell on the bonding curve from the token page.
- The keeper's liquidity slice **buys on the curve** every hour, so usage literally pushes the curve toward graduation.
- Tokens the keeper buys are held in an escrow account until graduation.

### 4.4 Graduation

- When the curve's SOL reserve reaches the threshold, the keeper calls `migrateToDammV2` (Meteora's own migrators are the fallback).
- The pool poller sees the flip and marks the token `graduated`.
- From then on, trading and the keeper both use the DAMM v2 pool.

### 4.5 After graduation

The keeper keeps one DAMM v2 position per model. Each hour it:

1. pairs escrowed tokens with SOL (or, when escrow is empty, swaps half the slice into tokens),
2. adds both sides as liquidity,
3. **permanently locks** the position,
4. claims the fees that position earned and folds them into the next hour's slice (compounding).

## 5. Billing logic (consumer side)

All money is stored as **integer micro-USDC** (1 USDC = 1,000,000) using BigInt, never floating point.

### 5.1 Getting a balance

1. The consumer signs in with their wallet (section 8).
2. They send USDC to the treasury with their personal 8-character `depositRef` in the memo.
3. They submit the transaction signature. The api checks it is **finalized**, goes to the treasury, is USDC, and carries the right memo.
4. The deposit is credited **once**: the signature has a unique index, so resubmitting it does nothing.

### 5.2 Paying for a request: hold → capture / release

Every call to `/v1/chat/completions` follows the same pattern as a card authorisation:

```text
estimate ──▶ HOLD ──▶ call upstream ──┬── success ──▶ CAPTURE actual cost, release the rest
                                      └── failure ──▶ RELEASE everything (nothing billed)
```

1. **Authenticate**: the `ibt_…` key is hashed with SHA-256 and looked up; only the hash is ever stored.
2. **Resolve** the model by its slug; unknown → 404, paused → 503.
3. **Estimate the worst case**: prompt tokens × input price + `max_tokens` (default 1024) × output price.
4. **Hold** that amount. If balance minus open holds is too low → **402** with the shortfall.
5. **Forward** to the provider's `baseUrl/chat/completions` with the provider's model name and decrypted upstream key. Timeouts: 30 s to first byte, 300 s total.
6. **Capture** the real cost on success:
   `cost = ceil((prompt_tokens × input_price + completion_tokens × output_price) / 1,000,000)`
   then the holder discount if it applies. Response headers show `X-Cost-Usdc` and `X-Balance-Usdc`.
7. **Release** on upstream error (502) or timeout (504). Holds that are never closed expire after 10 minutes.

### 5.3 What counts as billable

A request is billed only when **all** of these hold:

- the upstream returned 2xx and the response completed (`choices` present, or `[DONE]` for streams),
- token usage is known (reported by the upstream, or counted locally and flagged `usageEstimated`),
- it isn't a replay: the same `Idempotency-Key` within 24 h returns the stored response and is never billed twice.

### 5.4 Guard rails

- 60 requests per minute per key (configurable).
- Daily spend cap per key (default 50 USDC).
- `max_tokens` capped at 8192.

### 5.5 Holder discount

If the consumer's wallet holds at least **1,000,000 tokens** (0.1% of supply) of the model they call, that model costs **10% less**. The balance is read from the chain and cached for 5 minutes.

## 6. Settlement logic (the hourly engine)

At minute 5 of every hour, the keeper settles the previous hour for every model.

### 6.1 The split

| Share     | Default | Destination                            |
| --------- | ------- | -------------------------------------- |
| Provider  | 70%     | USDC transfer to the provider's wallet |
| Liquidity | 20%     | Token buy + locked liquidity           |
| Platform  | 10%     | Stays in the treasury                  |

- Provider and liquidity shares are rounded **down**; the platform gets the remainder, so the three parts always add up exactly to the revenue.
- If the model has **no token yet**, the liquidity share goes to the provider (90% / 10%).
- Splits are stored per model, so different launch classes could use different splits later.

### 6.2 The steps (a resumable state machine)

One settlement document per `(model, hour)` holds the state. Each step saves its result (and transaction signature) before the next step starts.

| #   | Step        | State after         | What it does                                                                                                                                   |
| --- | ----------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | lease       | `computing`         | Creates the document; the unique index stops a second runner                                                                                   |
| 2   | tagAndSum   |                     | Stamps every billable request of that hour with this settlement's id, then sums them. Tagging first means a request can never be counted twice |
| 3   | split       |                     | Applies the 70/20/10 split                                                                                                                     |
| 4   | payProvider | `paid_provider`     | Pays the provider if they're owed ≥ 1 USDC; otherwise carries the amount over to the next hour                                                 |
| 5   | convert     | `converted`         | Prices the slice in SOL (Jupiter price at run time, recorded) and takes it from the keeper's SOL float                                         |
| 6   | buyAndLock  | `bought` / `locked` | Curve: buy the token (and migrate if this buy completes the curve). Graduated: add liquidity and permanently lock it                           |
| 7   | compound    |                     | Claims fees from the keeper's locked position for the next slice                                                                               |
| 8   | finalize    | `done`              | Publishes the row on the token page                                                                                                            |

### 6.3 Failure handling

- Each step retries 3 times with backoff on RPC or blockhash errors.
- After 3 failures the settlement goes to `failed`, stores the error and sends an alert.
- An admin retry (`POST /api/admin/settlements/:id/retry`) resumes from the **last completed step**, so nothing is paid or bought twice.
- `MAX_SLICE_SOL_PER_RUN` and `MAX_PAYOUT_USDC_PER_RUN` cap what one run can spend.

## 7. Keeper jobs

Only one keeper instance works at a time: it holds a lease document in MongoDB (90 s TTL, renewed every 30 s). If it dies, another instance takes over.

| Job          | When            | Why                                                                                                       |
| ------------ | --------------- | --------------------------------------------------------------------------------------------------------- |
| poolPoller   | every 15 s      | Snapshots reserves, price and curve progress; detects graduation; cranks migration                        |
| healthCheck  | every minute    | Asks the api to probe each model; 3 failures in a row **pause** the model (success never auto-resumes it) |
| holdExpiry   | every minute    | Releases holds older than 10 minutes                                                                      |
| floatMonitor | every 5 min     | Alerts when keeper SOL < `FLOAT_MIN_SOL` or treasury USDC can't cover the next payout                     |
| stats        | every 5 min     | Recomputes 24 h requests, success rate, revenue, locked liquidity                                         |
| settle       | hourly at :05   | The settlement engine (section 6)                                                                         |
| reconcile    | daily 03:00 UTC | Recomputes every balance from the ledger and reports any drift                                            |

## 8. Sign-in logic

Sign-in proves wallet ownership without a password and without a transaction:

1. The browser asks the api for a nonce for the wallet (single-use, 5 minutes).
2. The api returns a Sign-In-With-Solana message:

   ```text
   web-token-infer.vercel.app wants you to sign in with your Solana account:
   <wallet>

   Sign in with your Solana account.

   URI: https://web-token-infer.vercel.app
   Version: 1
   Chain ID: solana:devnet
   Nonce: <nonce>
   Issued At: <time>
   ```

3. The browser checks the message is exactly this template for this wallet and nonce, so a compromised api can't make the wallet sign something else.
4. The wallet signs (Wallet Standard `signIn` when available, `signMessage` otherwise).
5. The api rebuilds the same message, verifies the Ed25519 signature, deletes the nonce, and returns a 24 h JWT. The JWT lives in memory only, never in localStorage or cookies.

The domain is the host of `WEB_ORIGIN`, which is also the only CORS origin, so the message always names the site the user is on.

## 9. Invariants (what must always be true)

- A user's balance equals the sum of their ledger rows.
- A request is billed at most once and counted in at most one settlement.
- A deposit signature credits at most once.
- One settlement per `(model, hour)`, so a retry can't pay or buy twice.
- Every `done` settlement has either a provider payout signature or a carry-over, and either liquidity signatures or `phase: none`.
- Upstream API keys are stored encrypted (AES-256-GCM) and are never returned by any endpoint.
- Locked liquidity can never be withdrawn by anyone, including the platform.

## 10. Why each choice was made

| Choice                                   | Reason                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| Hourly settlement instead of per request | One on-chain transaction per model per hour instead of per call; cheaper and auditable |
| Hold before calling upstream             | A consumer can never spend more than they have, even with concurrent requests          |
| 1 USDC minimum payout                    | Avoids paying more in fees than the transfer is worth; the rest carries over           |
| Permanent liquidity locks                | Removes rug-pull risk; the market can only deepen                                      |
| Buying on the curve before graduation    | Real revenue drives tokens toward graduation instead of only speculation               |
| One shared partner config                | Every token has identical, auditable rules; providers can't change them                |
| Integer micro-USDC and BigInt            | No rounding drift in money                                                             |
| Browser builds and wallet signs          | The server never holds user keys                                                       |
