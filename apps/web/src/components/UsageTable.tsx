import { usdcStringToMicro } from '@ibt/shared';

import { useUsage } from '../hooks/useAccount';
import { formatUsdc } from '../lib/format';

const COUNT = new Intl.NumberFormat('en-US');

export function UsageTable() {
  const usage = useUsage();

  return (
    <section
      aria-labelledby="usage-title"
      className="rounded-sm border border-ink-800 bg-ink-900 p-6"
    >
      <h2 id="usage-title" className="text-lg font-semibold tracking-tight text-ink-50">
        Usage
      </h2>
      <p className="mt-1 text-sm text-ink-400">Requests and cost per model per day.</p>

      <div className="mt-5 overflow-x-auto">
        {usage.isPending ? (
          <p className="text-sm text-ink-400">Loading usage…</p>
        ) : usage.isError ? (
          <p role="alert" className="text-sm text-negative">
            Could not load usage: {usage.error.message}
          </p>
        ) : usage.data.items.length === 0 ? (
          <p className="text-sm text-ink-400">No requests in this period.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="font-mono text-xs uppercase tracking-label text-ink-600">
                <th className="pb-2 pr-4 font-normal">Date</th>
                <th className="pb-2 pr-4 font-normal">Model</th>
                <th className="pb-2 pr-4 text-right font-normal">Requests</th>
                <th className="pb-2 pr-4 text-right font-normal">Prompt tok</th>
                <th className="pb-2 pr-4 text-right font-normal">Completion tok</th>
                <th className="pb-2 text-right font-normal">Cost USDC</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {usage.data.items.map((row) => (
                <tr key={`${row.date}:${row.modelId}`} className="border-t border-ink-800">
                  <td className="py-2 pr-4 text-ink-400">{row.date}</td>
                  <td className="py-2 pr-4 text-ink-50">{row.modelSlug}</td>
                  <td className="py-2 pr-4 text-right text-ink-200">
                    {COUNT.format(row.requests)}
                  </td>
                  <td className="py-2 pr-4 text-right text-ink-200">
                    {COUNT.format(row.promptTokens)}
                  </td>
                  <td className="py-2 pr-4 text-right text-ink-200">
                    {COUNT.format(row.completionTokens)}
                  </td>
                  <td className="py-2 text-right text-ink-50">
                    {formatUsdc(usdcStringToMicro(row.costUsdc))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
