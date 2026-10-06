import {
  HealthCheckResponseSchema,
  LaunchConfirmResponseSchema,
  LaunchPrepareResponseSchema,
  ModelSlugSchema,
  OwnerModelSchema,
  UsdcInputSchema,
  usdcStringToMicro,
  type CreateModelRequest,
  type HealthCheckResponse,
  type LaunchConfirmRequest,
  type LaunchPrepareRequest,
  type Model,
  type OwnerModel,
  type UpdateModelRequest,
} from '@ibt/shared';
import { Keypair } from '@solana/web3.js';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';

import { useSendTx } from '../hooks/useSendTx';
import { apiFetch, isApiError } from '../lib/api';
import { buildLaunchTransaction } from '../lib/launch';
import {
  clearPendingLaunch,
  loadPendingLaunch,
  savePendingLaunch,
  type PendingLaunch,
} from '../lib/launchAttempt';
import { publicQueryKeys } from '../lib/queries';

const PriceSchema = UsdcInputSchema.refine(
  (value) => UsdcInputSchema.safeParse(value).success && usdcStringToMicro(value) > 0n,
  {
    message: 'must be greater than 0',
  },
);

const PricesSchema = z.object({
  inputPerMTokUsdc: z.string().trim().pipe(PriceSchema),
  outputPerMTokUsdc: z.string().trim().pipe(PriceSchema),
});

const RegisterSchema = PricesSchema.extend({
  name: z.string().trim().min(1, 'Name is required').max(80),
  slug: z.string().trim().pipe(ModelSlugSchema),
  baseUrl: z
    .string()
    .trim()
    .pipe(z.url({ protocol: /^https?$/, message: 'Enter an http(s) URL' })),
  modelName: z.string().trim().min(1, 'Upstream model name is required').max(128),
  apiKey: z.string().min(1, 'Upstream API key is required').max(512),
});

const SymbolSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9]{2,10}$/, 'Symbol must be 2–10 uppercase letters or digits');

type RegisterForm = z.input<typeof RegisterSchema>;
type FieldErrors = Partial<Record<string, string>>;

function fieldErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    errors[key] ??= issue.message;
  }
  return errors;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed.';
}

const STEPS = ['Register', 'Health check', 'Prices', 'Launch'] as const;

const INPUT =
  'h-10 w-full rounded-sm border border-ink-800 bg-ink-950 px-3 text-sm text-ink-50 placeholder:text-ink-600 focus:border-accent focus:outline-none aria-[invalid=true]:border-negative';
const PRIMARY_BUTTON =
  'inline-flex h-10 items-center rounded-sm bg-accent px-4 font-mono text-xs font-medium uppercase tracking-label text-accent-fg transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50';
const GHOST_BUTTON =
  'inline-flex h-10 items-center rounded-sm border border-ink-800 px-4 font-mono text-xs uppercase tracking-label text-ink-200 transition-colors hover:border-ink-600 hover:text-ink-50 disabled:opacity-50';

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error: string | undefined;
  mono?: boolean;
  type?: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

function Field({
  id,
  label,
  hint,
  error,
  mono,
  type = 'text',
  value,
  placeholder,
  onChange,
}: FieldProps) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-sm text-ink-200">
        {label}
      </label>
      <input
        id={id}
        type={type}
        autoComplete="off"
        spellCheck={false}
        className={`mt-1.5 ${INPUT} ${mono ? 'font-mono' : ''}`}
        value={value}
        placeholder={placeholder}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
      />
      {error !== undefined ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-negative">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="mt-1.5 text-xs text-ink-600">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

function StepPanel({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`launch-step-${index}`}
      className="rounded-sm border border-ink-800 bg-ink-900 p-6 sm:p-8"
    >
      <p className="font-mono text-xs uppercase tracking-label text-accent">
        Step {index + 1} of {STEPS.length}
      </p>
      <h2
        id={`launch-step-${index}`}
        className="mt-2 text-xl font-semibold tracking-tight text-ink-50"
      >
        {title}
      </h2>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-4 text-sm text-negative">
      {children}
    </p>
  );
}

interface LaunchWizardProps {
  /** Mint keypair source; tests inject a fixed key. */
  generateMint?: () => Keypair;
  /** A registered model whose token is not live yet: the wizard opens on the launch step. */
  resume?: Model | null;
}

/** A stored attempt only counts for this model and, once prepared, the mint the api holds. */
function pendingFor(model: Model): PendingLaunch | null {
  const stored = loadPendingLaunch(model.slug);
  if (stored === null) return null;
  const sameModel = stored.modelId === model.id;
  const sameMint = model.token.mint === null || model.token.mint === stored.mint;
  if (!sameModel || !sameMint || stored.signature === null) {
    // Unsent attempts are useless after a reload: the mint keypair is gone.
    clearPendingLaunch(model.slug);
    return null;
  }
  return stored;
}

/**
 * Storage can be full or blocked; the attempt is then kept for this page only,
 * since failing here would abort a launch whose transaction is already out.
 */
function persistAttempt(slug: string, attempt: Omit<PendingLaunch, 'v'>): PendingLaunch {
  try {
    return savePendingLaunch(slug, attempt);
  } catch (error) {
    if (error instanceof Error) return { v: 1, ...attempt };
    throw error;
  }
}

export function LaunchWizard({
  generateMint = () => Keypair.generate(),
  resume = null,
}: LaunchWizardProps) {
  const { send, status: txStatus } = useSendTx();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(resume === null ? 0 : 3);
  const [model, setModel] = useState<OwnerModel | null>(null);
  const launchModel: Model | null = model ?? resume;
  // One mint per launch attempt: a retry after a rejection re-uses it, never a second pool.
  const mintKeypair = useRef<Keypair | null>(null);
  const [pending, setPending] = useState<PendingLaunch | null>(() =>
    resume === null ? null : pendingFor(resume),
  );
  const [confirmRejected, setConfirmRejected] = useState(false);
  const [form, setForm] = useState<RegisterForm>({
    name: '',
    slug: '',
    baseUrl: '',
    modelName: '',
    apiKey: '',
    inputPerMTokUsdc: '',
    outputPerMTokUsdc: '',
  });
  const [prices, setPrices] = useState({ inputPerMTokUsdc: '', outputPerMTokUsdc: '' });
  const [symbol, setSymbol] = useState(resume?.token.symbol ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthCheckResponse | null>(null);
  const [launched, setLaunched] = useState<{ mint: string; signature: string } | null>(null);

  function invalidateLaunch(current: Model, mint: string) {
    return Promise.all(
      [
        publicQueryKeys.models(),
        publicQueryKeys.model(current.slug),
        publicQueryKeys.tokenState(mint),
        ['providerModels'],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  }

  function finish(current: Model, mint: string, signature: string) {
    clearPendingLaunch(current.slug);
    setPending(null);
    setLaunched({ mint, signature });
  }

  function update<K extends keyof RegisterForm>(key: K, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await task();
    } catch (error) {
      setFailure(message(error));
    } finally {
      setBusy(false);
    }
  }

  function onRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = RegisterSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    const { name, slug, baseUrl, modelName, apiKey, inputPerMTokUsdc, outputPerMTokUsdc } =
      parsed.data;
    const body: CreateModelRequest = {
      slug,
      name,
      description: '',
      upstream: { baseUrl, modelName, apiKey, supportsStreamUsage: false },
      pricing: { inputPerMTokUsdc, outputPerMTokUsdc },
    };
    void run(async () => {
      const created = OwnerModelSchema.parse(
        await apiFetch('/api/models', { method: 'POST', body: JSON.stringify(body) }),
      );
      setModel(created);
      setPrices({ inputPerMTokUsdc, outputPerMTokUsdc });
      setStep(1);
    });
  }

  function onHealthCheck(modelId: string) {
    void run(async () => {
      setHealth(
        HealthCheckResponseSchema.parse(
          await apiFetch(`/api/models/${modelId}/health-check`, { method: 'POST' }),
        ),
      );
    });
  }

  function onPrices(event: FormEvent<HTMLFormElement>, modelId: string) {
    event.preventDefault();
    const parsed = PricesSchema.safeParse(prices);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    const body: UpdateModelRequest = { pricing: parsed.data };
    void run(async () => {
      const updated = OwnerModelSchema.parse(
        await apiFetch(`/api/models/${modelId}`, { method: 'PATCH', body: JSON.stringify(body) }),
      );
      setModel(updated);
      setPending(pendingFor(updated));
      setStep(3);
    });
  }

  function onLaunch(event: FormEvent<HTMLFormElement>, current: Model) {
    event.preventDefault();
    if (pending !== null) return;
    const parsed = SymbolSchema.safeParse(symbol);
    if (!parsed.success) {
      setErrors({ symbol: parsed.error.issues[0]?.message });
      return;
    }
    setErrors({});
    void run(async () => {
      mintKeypair.current ??= generateMint();
      const mint = mintKeypair.current;
      const mintAddress = mint.publicKey.toBase58();
      // Before any signature, so /metadata/<mint>.json resolves for indexers (P5-T1).
      const prepare: LaunchPrepareRequest = {
        modelId: current.id,
        mint: mintAddress,
        symbol: parsed.data,
      };
      const prepared = LaunchPrepareResponseSchema.parse(
        await apiFetch('/api/tokens/launch/prepare', {
          method: 'POST',
          body: JSON.stringify(prepare),
        }),
      );
      const attempt = { modelId: current.id, mint: mintAddress, symbol: parsed.data };
      let sent: PendingLaunch | null = null;
      const outcome = await send({
        build: ({ connection, payer, blockhash }) =>
          buildLaunchTransaction({
            connection,
            creator: payer,
            mint,
            name: current.name,
            symbol: parsed.data,
            blockhash,
            ...(prepared.metadataUri === undefined ? {} : { apiMetadataUri: prepared.metadataUri }),
          }),
        onSent: (signature) => {
          sent = persistAttempt(current.slug, { ...attempt, signature });
        },
        onConfirmed: async (signature) => {
          const confirm: LaunchConfirmRequest = {
            modelId: current.id,
            mint: mintAddress,
            signature,
          };
          return LaunchConfirmResponseSchema.parse(
            await apiFetch('/api/tokens/launch/confirm', {
              method: 'POST',
              body: JSON.stringify(confirm),
            }),
          );
        },
        invalidate: [],
      });
      if (outcome.ok) {
        await invalidateLaunch(current, mintAddress);
        finish(current, mintAddress, outcome.signature);
        return;
      }
      if (outcome.signature !== null) {
        // The pool transaction went out: from here on only confirmation is retried.
        setPending(sent ?? { v: 1, ...attempt, signature: outcome.signature });
        setConfirmRejected(false);
      }
      throw new Error(outcome.error.message);
    });
  }

  function onRetryConfirm(current: Model, attempt: PendingLaunch) {
    const { signature } = attempt;
    if (signature === null) return;
    void run(async () => {
      const confirm: LaunchConfirmRequest = {
        modelId: attempt.modelId,
        mint: attempt.mint,
        signature,
      };
      try {
        LaunchConfirmResponseSchema.parse(
          await apiFetch('/api/tokens/launch/confirm', {
            method: 'POST',
            body: JSON.stringify(confirm),
          }),
        );
      } catch (error) {
        // The api checked the chain and found no matching pool: starting over is safe.
        if (isApiError(error) && error.code === 'pool_mismatch') setConfirmRejected(true);
        throw error;
      }
      await invalidateLaunch(current, attempt.mint);
      finish(current, attempt.mint, signature);
    });
  }

  function onDiscardAttempt(current: Model) {
    clearPendingLaunch(current.slug);
    mintKeypair.current = null;
    setPending(null);
    setConfirmRejected(false);
    setFailure(null);
  }

  const txLabel: Partial<Record<typeof txStatus, string>> = {
    building: 'Building the pool transaction…',
    signing: 'Approve the launch in your wallet…',
    sending: 'Sending…',
    confirming: 'Confirming on-chain…',
  };

  return (
    <div className="mt-10 grid gap-8 lg:grid-cols-[14rem_1fr]">
      <nav aria-label="Launch steps">
        <ol className="grid gap-1">
          {STEPS.map((label, index) => {
            const state = index < step ? 'done' : index === step ? 'current' : 'locked';
            return (
              <li
                key={label}
                aria-current={state === 'current' ? 'step' : undefined}
                data-state={state}
                className={`flex items-center gap-3 border-l-2 py-2 pl-3 text-sm ${
                  state === 'current'
                    ? 'border-accent text-ink-50'
                    : state === 'done'
                      ? 'border-ink-600 text-ink-400'
                      : 'border-ink-800 text-ink-600'
                }`}
              >
                <span className="font-mono text-xs">{String(index + 1).padStart(2, '0')}</span>
                {label}
              </li>
            );
          })}
        </ol>
      </nav>

      <div>
        {step === 0 && (
          <StepPanel index={0} title="Register your endpoint">
            <form noValidate className="grid gap-5 sm:grid-cols-2" onSubmit={onRegister}>
              <Field
                id="model-name"
                label="Display name"
                placeholder="Llama 3.1 8B Fast"
                value={form.name}
                error={errors.name}
                onChange={(v) => update('name', v)}
              />
              <Field
                id="model-slug"
                label="Slug"
                mono
                hint="Lowercase; used in /v1 requests and the token URL."
                placeholder="llama-3.1-8b-fast"
                value={form.slug}
                error={errors.slug}
                onChange={(v) => update('slug', v)}
              />
              <div className="sm:col-span-2">
                <Field
                  id="upstream-url"
                  label="Upstream base URL"
                  mono
                  hint="OpenAI-compatible, e.g. https://api.example.com/v1"
                  placeholder="https://"
                  value={form.baseUrl}
                  error={errors.baseUrl}
                  onChange={(v) => update('baseUrl', v)}
                />
              </div>
              <Field
                id="upstream-model"
                label="Upstream model name"
                mono
                value={form.modelName}
                error={errors.modelName}
                onChange={(v) => update('modelName', v)}
              />
              <Field
                id="upstream-key"
                label="Upstream API key"
                type="password"
                mono
                hint="Stored encrypted; never shown again."
                value={form.apiKey}
                error={errors.apiKey}
                onChange={(v) => update('apiKey', v)}
              />
              <Field
                id="price-in"
                label="Input price (USDC / 1M tokens)"
                mono
                placeholder="0.20"
                value={form.inputPerMTokUsdc}
                error={errors.inputPerMTokUsdc}
                onChange={(v) => update('inputPerMTokUsdc', v)}
              />
              <Field
                id="price-out"
                label="Output price (USDC / 1M tokens)"
                mono
                placeholder="0.60"
                value={form.outputPerMTokUsdc}
                error={errors.outputPerMTokUsdc}
                onChange={(v) => update('outputPerMTokUsdc', v)}
              />
              <div className="sm:col-span-2">
                <button type="submit" className={PRIMARY_BUTTON} disabled={busy}>
                  {busy ? 'Registering…' : 'Register model'}
                </button>
              </div>
            </form>
            {failure !== null && <Alert>{failure}</Alert>}
          </StepPanel>
        )}

        {step === 1 && model !== null && (
          <StepPanel index={1} title="Check the endpoint">
            <p className="text-sm text-ink-400">
              Sends one short completion to{' '}
              <span className="font-mono text-ink-200">{model.upstream.baseUrl}</span>. The model
              must answer before you can continue.
            </p>
            {health !== null && (
              <dl
                aria-label="Health check result"
                className="mt-5 grid grid-cols-2 gap-4 rounded-sm border border-ink-800 bg-ink-950 p-4 font-mono text-sm sm:grid-cols-3"
              >
                <div>
                  <dt className="text-xs uppercase tracking-label text-ink-600">Result</dt>
                  <dd className={health.ok ? 'text-positive' : 'text-negative'}>
                    {health.ok ? 'Healthy' : 'Failed'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-label text-ink-600">Latency</dt>
                  <dd className="text-ink-200">
                    {health.latencyMs === null ? '—' : `${Math.round(health.latencyMs)} ms`}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-label text-ink-600">Status</dt>
                  <dd className="text-ink-200">{health.status}</dd>
                </div>
                {health.error && (
                  <div className="col-span-full">
                    <dt className="text-xs uppercase tracking-label text-ink-600">Error</dt>
                    <dd className="break-words text-negative">{health.error}</dd>
                  </div>
                )}
              </dl>
            )}
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                className={GHOST_BUTTON}
                disabled={busy}
                onClick={() => onHealthCheck(model.id)}
              >
                {busy ? 'Checking…' : health === null ? 'Run health check' : 'Run again'}
              </button>
              <button
                type="button"
                className={PRIMARY_BUTTON}
                disabled={busy || health?.ok !== true}
                onClick={() => setStep(2)}
              >
                Continue
              </button>
            </div>
            {failure !== null && <Alert>{failure}</Alert>}
          </StepPanel>
        )}

        {step === 2 && model !== null && (
          <StepPanel index={2} title="Set prices">
            <form
              noValidate
              className="grid gap-5 sm:grid-cols-2"
              onSubmit={(e) => onPrices(e, model.id)}
            >
              <Field
                id="price-in"
                label="Input price (USDC / 1M tokens)"
                mono
                value={prices.inputPerMTokUsdc}
                error={errors.inputPerMTokUsdc}
                onChange={(v) => setPrices((p) => ({ ...p, inputPerMTokUsdc: v }))}
              />
              <Field
                id="price-out"
                label="Output price (USDC / 1M tokens)"
                mono
                value={prices.outputPerMTokUsdc}
                error={errors.outputPerMTokUsdc}
                onChange={(v) => setPrices((p) => ({ ...p, outputPerMTokUsdc: v }))}
              />
              <p className="text-sm text-ink-400 sm:col-span-2">
                Revenue splits {model.splits.providerBps / 100}% to you,{' '}
                {model.splits.liquidityBps / 100}% to locked token liquidity and{' '}
                {model.splits.platformBps / 100}% to the platform.
              </p>
              <div className="sm:col-span-2">
                <button type="submit" className={PRIMARY_BUTTON} disabled={busy}>
                  {busy ? 'Saving…' : 'Save prices'}
                </button>
              </div>
            </form>
            {failure !== null && <Alert>{failure}</Alert>}
          </StepPanel>
        )}

        {step === 3 && launchModel !== null && (
          <StepPanel index={3} title="Launch the token">
            {launched === null && pending !== null ? (
              <div className="grid gap-4">
                <p className="text-sm text-ink-200">
                  The pool transaction for <span className="text-ink-50">{launchModel.name}</span>{' '}
                  was sent, but the launch is not confirmed yet. Retry the confirmation; do not
                  launch again, which would create and pay for a second pool.
                </p>
                <p className="break-all font-mono text-xs text-ink-400">Mint {pending.mint}</p>
                <p className="break-all font-mono text-xs text-ink-600">
                  Signature {pending.signature}
                </p>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    className={PRIMARY_BUTTON}
                    disabled={busy}
                    onClick={() => onRetryConfirm(launchModel, pending)}
                  >
                    {busy ? 'Confirming…' : 'Retry confirmation'}
                  </button>
                  {confirmRejected && (
                    <button
                      type="button"
                      className={GHOST_BUTTON}
                      disabled={busy}
                      onClick={() => onDiscardAttempt(launchModel)}
                    >
                      Discard and launch again
                    </button>
                  )}
                </div>
                {confirmRejected && (
                  <p className="text-xs text-ink-400">
                    The api found no valid pool for this transaction, so launching again is safe.
                  </p>
                )}
              </div>
            ) : launched === null ? (
              <form noValidate className="grid gap-5" onSubmit={(e) => onLaunch(e, launchModel)}>
                <p className="text-sm text-ink-400">
                  Creates a bonding-curve pool for{' '}
                  <span className="text-ink-200">{launchModel.name}</span>. Your wallet pays the
                  fees and becomes the pool creator.
                </p>
                <div className="max-w-xs">
                  <Field
                    id="token-symbol"
                    label="Token symbol"
                    mono
                    placeholder="LLAMA"
                    value={symbol}
                    error={errors.symbol}
                    onChange={(v) => setSymbol(v.toUpperCase())}
                  />
                </div>
                <div>
                  <button type="submit" className={PRIMARY_BUTTON} disabled={busy}>
                    {busy ? 'Launching…' : 'Launch token'}
                  </button>
                </div>
                <p aria-live="polite" className="min-h-5 font-mono text-xs text-ink-400">
                  {busy ? (txLabel[txStatus] ?? 'Preparing metadata…') : ''}
                </p>
              </form>
            ) : (
              <div className="grid gap-3">
                <p className="text-positive">Token launched. The curve is live.</p>
                <p className="break-all font-mono text-xs text-ink-400">Mint {launched.mint}</p>
                <p className="break-all font-mono text-xs text-ink-600">
                  Signature {launched.signature}
                </p>
                <Link to={`/t/${launchModel.slug}`} className={`${PRIMARY_BUTTON} w-fit`}>
                  View token page
                </Link>
              </div>
            )}
            {failure !== null && <Alert>{failure}</Alert>}
          </StepPanel>
        )}
      </div>
    </div>
  );
}
