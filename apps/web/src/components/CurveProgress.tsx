import { MIGRATION_THRESHOLD_SOL, type Cluster } from '@ibt/shared';

import { env } from '../env';
import { formatDecimal, formatPct } from '../lib/format';
import { useTokenState } from '../lib/queries';

type Size = 'sm' | 'lg';

interface CurveProgressViewProps {
  /** Ratio 0–1 from the latest pool snapshot; values outside are clamped. */
  progress: number;
  raisedSol: string;
  thresholdSol: number;
  graduated?: boolean;
  size?: Size;
}

const TICKS = [25, 50, 75] as const;

export function CurveProgressView({
  progress,
  raisedSol,
  thresholdSol,
  graduated = false,
  size = 'lg',
}: CurveProgressViewProps) {
  const ratio = Math.min(Math.max(Number.isFinite(progress) ? progress : 0, 0), 1);
  const percent = Number((ratio * 100).toFixed(1));
  const label = formatPct(ratio);
  const raised = formatDecimal(raisedSol, 4);
  const large = size === 'lg';

  return (
    <div className="font-mono">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs uppercase tracking-label text-ink-400">
          {graduated ? 'Graduated to DAMM v2' : 'Bonding curve'}
        </span>
        <span className={`tabular-nums ${large ? 'text-2xl text-ink-50' : 'text-sm text-accent'}`}>
          {label}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Bonding curve progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${label}, ${raised} of ${thresholdSol} SOL raised`}
        className={`relative mt-2 overflow-hidden rounded-sm bg-ink-800 ${large ? 'h-2.5' : 'h-1.5'}`}
      >
        <div
          className={`h-full transition-[width] duration-700 ease-out ${graduated ? 'bg-positive' : 'bg-accent'}`}
          style={{ width: `${percent}%` }}
        />
        {TICKS.map((tick) => (
          <span
            key={tick}
            aria-hidden="true"
            className="absolute inset-y-0 w-px bg-ink-950/70"
            style={{ left: `${tick}%` }}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between gap-3 text-xs tabular-nums text-ink-400">
        <span className="text-ink-200">{raised} SOL raised</span>
        <span>of {thresholdSol} SOL to graduate</span>
      </div>
    </div>
  );
}

interface CurveProgressProps {
  mint: string;
  size?: Size;
  cluster?: Cluster;
}

/** Live curve progress for `mint`, polled from `/api/tokens/:mint/state` every 10 s. */
export function CurveProgress({
  mint,
  size = 'lg',
  cluster = env.VITE_CLUSTER,
}: CurveProgressProps) {
  const state = useTokenState(mint);

  if (state.isPending) {
    return (
      <div aria-hidden="true" className="animate-pulse space-y-2">
        <div className="h-3 w-1/3 rounded-sm bg-ink-800" />
        <div className={`rounded-sm bg-ink-800 ${size === 'lg' ? 'h-2.5' : 'h-1.5'}`} />
        <div className="h-3 w-1/2 rounded-sm bg-ink-800" />
      </div>
    );
  }

  if (state.isError) {
    return (
      <p className="font-mono text-xs uppercase tracking-label text-ink-400">
        Curve state unavailable
      </p>
    );
  }

  return (
    <CurveProgressView
      progress={state.data.progress}
      raisedSol={state.data.quoteReserveSol}
      thresholdSol={MIGRATION_THRESHOLD_SOL[cluster]}
      graduated={state.data.phase === 'graduated'}
      size={size}
    />
  );
}
