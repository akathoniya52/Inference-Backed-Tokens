import { ModelSlugSchema, type Model } from '@ibt/shared';
import { useSearchParams } from 'react-router-dom';

import { LaunchWizard } from '../components/LaunchWizard';
import { WalletGate } from '../components/WalletGate';
import { useSessionWallet } from '../hooks/useAuth';
import { isUnlaunched, useProviderModels } from '../lib/queries';

const PANEL = 'rounded-sm border border-ink-800 bg-ink-900/60 p-6';
const GHOST_BUTTON =
  'inline-flex h-9 items-center rounded-sm border border-ink-600 px-4 font-mono text-xs uppercase tracking-label text-ink-200 transition-colors hover:border-accent hover:text-accent';

function ContinueLaunch({
  models,
  onPick,
}: {
  models: readonly Model[];
  onPick: (slug: string) => void;
}) {
  return (
    <section aria-labelledby="continue-launch" className={`${PANEL} mt-10`}>
      <h2 id="continue-launch" className="font-medium text-ink-50">
        Finish a launch
      </h2>
      <p className="mt-1 text-sm text-ink-400">
        These models are registered but their tokens are not live yet. Continue instead of
        registering them again.
      </p>
      <ul className="mt-4 divide-y divide-ink-800 border-y border-ink-800">
        {models.map((model) => (
          <li key={model.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span>
              <span className="text-ink-50">{model.name}</span>{' '}
              <span className="font-mono text-xs text-ink-400">{model.slug}</span>
            </span>
            <button
              type="button"
              className={GHOST_BUTTON}
              aria-label={`Continue launch of ${model.name}`}
              onClick={() => onPick(model.slug)}
            >
              Continue launch
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LaunchFlow() {
  const wallet = useSessionWallet();
  const models = useProviderModels(wallet);
  const [params, setParams] = useSearchParams();
  const requested = ModelSlugSchema.safeParse(params.get('model'));
  const requestedSlug = requested.success ? requested.data : null;
  const unlaunched = models.data?.filter(isUnlaunched) ?? [];
  const resume = unlaunched.find((model) => model.slug === requestedSlug) ?? null;

  if (requestedSlug !== null && models.isPending) {
    return (
      <div role="status" aria-label="Loading your models" className="mt-10 animate-pulse">
        <div className="h-64 rounded-sm bg-ink-900" />
      </div>
    );
  }

  return (
    <>
      {requestedSlug !== null && resume === null && (
        <p role="status" className="mt-10 text-sm text-ink-400">
          <span className="font-mono text-ink-200">{requestedSlug}</span> is not one of your models
          waiting for a launch.
        </p>
      )}
      {resume === null && unlaunched.length > 0 && (
        <ContinueLaunch models={unlaunched} onPick={(slug) => setParams({ model: slug })} />
      )}
      <LaunchWizard key={resume?.id ?? 'new'} resume={resume} />
    </>
  );
}

export function LaunchPage() {
  return (
    <section>
      <h1 className="page-title">Launch a model</h1>
      <p className="page-lede">
        Register an OpenAI-compatible endpoint, set its prices and launch its token.
      </p>
      <WalletGate purpose="register a model and launch its token">
        <LaunchFlow />
      </WalletGate>
    </section>
  );
}
