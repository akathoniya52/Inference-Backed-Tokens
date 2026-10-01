import { Link } from 'react-router-dom';

import { ModelCard } from '../components/ModelCard';
import { isApiError } from '../lib/api';
import { useModels } from '../lib/queries';

const SKELETON_COUNT = 6;
const GRID = 'mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3';
const SECONDARY_BUTTON =
  'inline-flex h-9 items-center rounded-sm border border-ink-600 px-4 font-mono text-xs uppercase tracking-label text-ink-200 transition-colors hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-60';

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-sm border border-ink-800 bg-ink-900/60 p-5">
      <div className="flex justify-between gap-3">
        <div className="h-4 w-2/5 rounded-sm bg-ink-800" />
        <div className="h-6 w-20 rounded-sm bg-ink-800" />
      </div>
      <div className="mt-2 h-3 w-1/3 rounded-sm bg-ink-800" />
      <div className="mt-5 grid grid-cols-2 gap-4 border-t border-ink-800 pt-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-2">
            <div className="h-3 w-3/5 rounded-sm bg-ink-800" />
            <div className="h-4 w-2/5 rounded-sm bg-ink-800" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ExplorePage() {
  const models = useModels();
  const items = models.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-6 border-b border-ink-800 pb-8">
        <div>
          <h1 className="page-title">Explore</h1>
          <p className="page-lede">
            Models with live inference stats and the token each one backs.
          </p>
        </div>
        <Link
          to="/launch"
          className="font-mono text-xs uppercase tracking-label text-accent transition-colors hover:text-accent-strong"
        >
          Launch a model <span aria-hidden="true">→</span>
        </Link>
      </div>

      {models.isPending && (
        <div role="status" aria-label="Loading models" className={GRID}>
          {Array.from({ length: SKELETON_COUNT }, (_, index) => (
            <SkeletonCard key={index} />
          ))}
        </div>
      )}

      {models.isError && (
        <div
          role="alert"
          className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-sm border border-negative/40 bg-negative/10 p-5"
        >
          <div>
            <p className="font-medium text-ink-50">Could not load models</p>
            <p className="mt-1 font-mono text-xs text-ink-400">
              {models.error.message}
              {isApiError(models.error) && models.error.requestId !== null
                ? ` · request ${models.error.requestId}`
                : ''}
            </p>
          </div>
          <button type="button" className={SECONDARY_BUTTON} onClick={() => void models.refetch()}>
            Retry
          </button>
        </div>
      )}

      {models.isSuccess && items.length === 0 && (
        <div className="mt-10 rounded-sm border border-dashed border-ink-800 px-6 py-16 text-center">
          <p className="text-lg font-medium text-ink-50">No models yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-400">
            Providers list an OpenAI-compatible endpoint, set per-token prices and can launch a
            token backed by the model&apos;s revenue.
          </p>
          <Link
            to="/launch"
            className="mt-6 inline-flex h-9 items-center rounded-sm bg-accent px-4 font-mono text-xs font-medium uppercase tracking-label text-accent-fg transition-colors hover:bg-accent-strong"
          >
            List a model
          </Link>
        </div>
      )}

      {items.length > 0 && (
        <div className={GRID}>
          {items.map((model) => (
            <ModelCard key={model.id} model={model} />
          ))}
        </div>
      )}

      {models.hasNextPage && (
        <div className="mt-8 flex justify-center">
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={models.isFetchingNextPage}
            onClick={() => void models.fetchNextPage()}
          >
            {models.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </section>
  );
}
