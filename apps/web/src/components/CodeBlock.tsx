import { useEffect, useState } from 'react';

type CopyState = 'idle' | 'copied' | 'failed';

const RESET_MS = 2000;
const LABELS: Record<CopyState, string> = { idle: 'Copy', copied: 'Copied', failed: 'Copy failed' };

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<CopyState>('idle');

  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = setTimeout(() => setState('idle'), RESET_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = () => {
    if (typeof navigator.clipboard?.writeText !== 'function') {
      setState('failed');
      return;
    }
    navigator.clipboard.writeText(value).then(
      () => setState('copied'),
      () => setState('failed'),
    );
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={state === 'idle' ? label : LABELS[state]}
      className="inline-flex h-7 items-center rounded-sm border border-ink-800 px-2 font-mono text-xs uppercase tracking-label text-ink-400 transition-colors hover:border-accent hover:text-accent"
    >
      <span aria-live="polite">{LABELS[state]}</span>
    </button>
  );
}
