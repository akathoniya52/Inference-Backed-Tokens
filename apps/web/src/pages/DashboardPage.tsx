import { usdcStringToMicro } from '@ibt/shared';

import { ApiKeyManager } from '../components/ApiKeyManager';
import { DepositUsdc } from '../components/DepositUsdc';
import { Quickstart } from '../components/Quickstart';
import { UsageTable } from '../components/UsageTable';
import { WalletGate } from '../components/WalletGate';
import { useMe } from '../hooks/useAccount';
import { formatUsdc, shortAddress } from '../lib/format';

function usdc(amount: string): string {
  return formatUsdc(usdcStringToMicro(amount));
}

function Account() {
  const me = useMe();

  if (me.isPending) return <p className="mt-10 text-sm text-ink-400">Loading account…</p>;
  if (me.isError) {
    return (
      <p role="alert" className="mt-10 text-sm text-negative">
        Could not load your account: {me.error.message}
      </p>
    );
  }

  const stats = [
    ['Available', usdc(me.data.availableUsdc)],
    ['Balance', usdc(me.data.balanceUsdc)],
    ['Held', usdc(me.data.heldUsdc)],
  ] as const;

  return (
    <div className="mt-10 grid gap-6">
      <section aria-label="Balance" className="rounded-sm border border-ink-800 bg-ink-900 p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-mono text-xs uppercase tracking-label text-ink-600">Account</p>
          <p className="font-mono text-xs text-ink-400" title={me.data.wallet}>
            {shortAddress(me.data.wallet)} · deposit ref{' '}
            <span className="text-ink-200">{me.data.depositRef}</span>
          </p>
        </div>
        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          {stats.map(([label, value], index) => (
            <div key={label}>
              <dt className="text-sm text-ink-400">{label}</dt>
              <dd
                className={`mt-1 font-mono tracking-tight ${index === 0 ? 'text-3xl text-ink-50' : 'text-xl text-ink-200'}`}
              >
                {value} <span className="text-sm text-ink-600">USDC</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <DepositUsdc depositRef={me.data.depositRef} />
        <Quickstart />
      </div>
      <ApiKeyManager />
      <UsageTable />
    </div>
  );
}

export function DashboardPage() {
  return (
    <section>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-lede">API keys, USDC balance and usage across models.</p>
      <WalletGate purpose="see your balance, keys and usage">
        <Account />
      </WalletGate>
    </section>
  );
}
