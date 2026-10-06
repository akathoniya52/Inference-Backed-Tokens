import { CreateApiKeyRequestSchema, type ApiKey, type CreateApiKeyResponse } from '@ibt/shared';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '../hooks/useAccount';

const INPUT =
  'h-10 w-full rounded-sm border border-ink-800 bg-ink-950 px-3 text-sm text-ink-50 placeholder:text-ink-600 focus:border-accent focus:outline-none';
const PRIMARY_BUTTON =
  'inline-flex h-10 items-center rounded-sm bg-accent px-4 font-mono text-xs font-medium uppercase tracking-label text-accent-fg transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50';
const GHOST_BUTTON =
  'inline-flex h-8 items-center rounded-sm border border-ink-800 px-3 font-mono text-xs uppercase tracking-label text-ink-200 transition-colors hover:border-ink-600 hover:text-ink-50 disabled:opacity-50';

function formatDate(iso: string | null): string {
  return iso === null ? 'Never' : iso.slice(0, 10);
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab and Shift+Tab inside `container`, as a modal dialog must. */
function trapFocus(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (event.key !== 'Tab' || container === null) return;
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * The key exists only in this dialog: Escape asks before closing, a reload or
 * tab close triggers the browser's leave-page warning, and focus stays inside.
 */
function NewKeyDialog({ created, onDone }: { created: CreateApiKeyResponse; onDone: () => void }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [confirmClose, setConfirmClose] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    doneRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    if (confirmClose) keepRef.current?.focus();
  }, [confirmClose]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers only show the prompt when returnValue is set.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setConfirmClose(true);
      return;
    }
    trapFocus(event, dialogRef.current);
  }

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(created.key);
      setCopy('copied');
    } catch (_error) {
      setCopy('failed');
    }
  }

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-ink-950/80 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-key-title"
        aria-describedby="new-key-description"
        className="w-full max-w-lg rounded-sm border border-ink-800 bg-ink-900 p-6"
        onKeyDown={onKeyDown}
      >
        <p className="font-mono text-xs uppercase tracking-label text-accent">Shown once</p>
        <h3 id="new-key-title" className="mt-2 text-lg font-semibold text-ink-50">
          Key “{created.name}” created
        </h3>
        <p id="new-key-description" className="mt-2 text-sm text-ink-400">
          Copy it now. Only a hash is stored, so this key cannot be shown again.
        </p>
        <code
          data-testid="full-api-key"
          className="mt-4 block break-all rounded-sm border border-ink-800 bg-ink-950 p-3 font-mono text-sm text-ink-50"
        >
          {created.key}
        </code>
        {confirmClose ? (
          <div
            role="alert"
            className="mt-5 rounded-sm border border-negative/40 bg-negative/10 p-4"
          >
            <p className="text-sm text-ink-50">
              Close without saving? The key cannot be shown again; you would have to create a new
              one.
            </p>
            <div className="mt-3 flex items-center gap-3">
              <button
                ref={keepRef}
                type="button"
                className={GHOST_BUTTON}
                onClick={() => setConfirmClose(false)}
              >
                Keep it open
              </button>
              <button
                type="button"
                className={`${GHOST_BUTTON} border-negative/60 text-negative`}
                onClick={onDone}
              >
                Close anyway
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-5 flex items-center gap-3">
            <button type="button" className={GHOST_BUTTON} onClick={() => void copyKey()}>
              {copy === 'copied'
                ? 'Copied'
                : copy === 'failed'
                  ? 'Copy failed, select it'
                  : 'Copy key'}
            </button>
            <button ref={doneRef} type="button" className={PRIMARY_BUTTON} onClick={onDone}>
              I have saved it
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function KeyRow({ apiKey }: { apiKey: ApiKey }) {
  const revoke = useRevokeApiKey();
  const [confirming, setConfirming] = useState(false);
  const active = apiKey.status === 'active';

  return (
    <tr className="border-t border-ink-800">
      <td className="py-3 pr-4 text-ink-50">{apiKey.name}</td>
      <td className="py-3 pr-4 font-mono text-ink-200">{apiKey.prefix}…</td>
      <td className="py-3 pr-4 font-mono text-ink-200">{apiKey.dailyCapUsdc}</td>
      <td className="py-3 pr-4 font-mono text-ink-400">{formatDate(apiKey.lastUsedAt)}</td>
      <td className="py-3 pr-4">
        <span
          className={`font-mono text-xs uppercase tracking-label ${active ? 'text-positive' : 'text-ink-600'}`}
        >
          {apiKey.status}
        </span>
      </td>
      <td className="py-3 text-right">
        {active &&
          (confirming ? (
            <span className="inline-flex gap-2">
              <button
                type="button"
                className={`${GHOST_BUTTON} border-negative/60 text-negative`}
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(apiKey.id)}
              >
                Confirm revoke
              </button>
              <button type="button" className={GHOST_BUTTON} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className={GHOST_BUTTON}
              aria-label={`Revoke ${apiKey.name}`}
              onClick={() => setConfirming(true)}
            >
              Revoke
            </button>
          ))}
        {revoke.isError && (
          <p role="alert" className="mt-1 text-xs text-negative">
            {revoke.error.message}
          </p>
        )}
      </td>
    </tr>
  );
}

export function ApiKeyManager() {
  const keys = useApiKeys();
  const create = useCreateApiKey();
  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateApiKeyResponse | null>(null);
  const items = keys.data?.pages.flatMap((page) => page.items) ?? [];

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = CreateApiKeyRequestSchema.safeParse({ name });
    if (!parsed.success) {
      setFieldError('Name the key (1–64 characters).');
      return;
    }
    setFieldError(null);
    create.mutate(parsed.data, {
      onSuccess: (data) => {
        setCreated(data);
        setName('');
      },
    });
  }

  return (
    <section
      aria-labelledby="keys-title"
      className="rounded-sm border border-ink-800 bg-ink-900 p-6"
    >
      <h2 id="keys-title" className="text-lg font-semibold tracking-tight text-ink-50">
        API keys
      </h2>
      <p className="mt-1 text-sm text-ink-400">
        Bearer keys for <span className="font-mono">/v1</span>. Each has a daily spend cap.
      </p>

      <form className="mt-5 flex flex-wrap items-start gap-3" onSubmit={onSubmit}>
        <div className="min-w-0 flex-1">
          <label htmlFor="key-name" className="sr-only">
            Key name
          </label>
          <input
            id="key-name"
            placeholder="Key name, e.g. production"
            className={INPUT}
            value={name}
            maxLength={64}
            aria-invalid={fieldError !== null}
            onChange={(e) => setName(e.target.value)}
          />
          {fieldError !== null && <p className="mt-2 text-sm text-negative">{fieldError}</p>}
        </div>
        <button type="submit" className={PRIMARY_BUTTON} disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create key'}
        </button>
      </form>
      {create.isError && (
        <p role="alert" className="mt-2 text-sm text-negative">
          {create.error.message}
        </p>
      )}

      <div className="mt-6 overflow-x-auto">
        {keys.isPending ? (
          <p className="text-sm text-ink-400">Loading keys…</p>
        ) : keys.isError ? (
          <p role="alert" className="text-sm text-negative">
            Could not load keys: {keys.error.message}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-400">No keys yet. Create one to call the API.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="font-mono text-xs uppercase tracking-label text-ink-600">
                <th className="pb-2 pr-4 font-normal">Name</th>
                <th className="pb-2 pr-4 font-normal">Prefix</th>
                <th className="pb-2 pr-4 font-normal">Daily cap</th>
                <th className="pb-2 pr-4 font-normal">Last used</th>
                <th className="pb-2 pr-4 font-normal">Status</th>
                <th className="pb-2 font-normal">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((apiKey) => (
                <KeyRow key={apiKey.id} apiKey={apiKey} />
              ))}
            </tbody>
          </table>
        )}
        {keys.hasNextPage && (
          <button
            type="button"
            className={`${GHOST_BUTTON} mt-4`}
            disabled={keys.isFetchingNextPage}
            onClick={() => void keys.fetchNextPage()}
          >
            {keys.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>

      {created !== null && <NewKeyDialog created={created} onDone={() => setCreated(null)} />}
    </section>
  );
}
