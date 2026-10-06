import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom';

const PRIMARY_BUTTON =
  'inline-flex h-10 items-center rounded-sm bg-accent px-4 font-mono text-xs font-medium uppercase tracking-label text-accent-fg transition-colors hover:bg-accent-strong';
const GHOST_BUTTON =
  'inline-flex h-10 items-center rounded-sm border border-ink-800 px-4 font-mono text-xs uppercase tracking-label text-ink-200 transition-colors hover:border-ink-600 hover:text-ink-50';

/**
 * Route `errorElement`: a render-time throw (bad API data, an unparsable
 * address) lands here instead of unmounting the whole app. The error itself
 * is never rendered, only a status for route responses.
 */
export function RouteError() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : null;

  return (
    <section role="alert" className="mx-auto max-w-xl py-12">
      <p className="font-mono text-xs uppercase tracking-label text-negative">
        {status === null ? 'Unexpected error' : `Error ${status}`}
      </p>
      <h1 className="page-title mt-2">Something went wrong</h1>
      <p className="page-lede">
        This page hit a problem it could not recover from. Reloading usually fixes it; your wallet
        and funds are not affected.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" className={PRIMARY_BUTTON} onClick={() => window.location.reload()}>
          Reload
        </button>
        <Link to="/" className={GHOST_BUTTON}>
          Back to Explore
        </Link>
      </div>
    </section>
  );
}
