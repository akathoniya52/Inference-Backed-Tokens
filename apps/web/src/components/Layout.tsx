import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Link, NavLink, Outlet, ScrollRestoration } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/', label: 'Explore', end: true },
  { to: '/launch', label: 'Launch', end: false },
  { to: '/dashboard', label: 'Dashboard', end: false },
  { to: '/provider', label: 'Provider', end: false },
  { to: '/docs', label: 'Docs', end: false },
] as const;

export function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/95 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-shell items-center gap-4 px-4 sm:gap-6 sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-3">
            <img src="/logo.svg" alt="" aria-hidden="true" className="h-8 w-8" />
            <span className="hidden text-sm font-medium tracking-tight text-ink-50 md:inline">
              Inference-Backed Tokens
            </span>
          </Link>
          <nav aria-label="Primary" className="flex min-w-0 flex-1 items-center overflow-x-auto">
            {NAV_ITEMS.map(({ to, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) => (isActive ? 'nav-link nav-link-active' : 'nav-link')}
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="shrink-0">
            <WalletMultiButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-shell flex-1 px-4 py-12 sm:px-6">
        <Outlet />
      </main>
      <ScrollRestoration />
    </div>
  );
}
