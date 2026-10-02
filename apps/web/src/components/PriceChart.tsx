import type { PricePoint } from '@ibt/shared';
import {
  ColorType,
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef, type ReactNode } from 'react';

import { formatDecimal, formatPct } from '../lib/format';

export const MIN_CHART_POINTS = 2;
/** Pixel height of the plot; keep in step with the `h-56` container class. */
const CHART_HEIGHT = 224;

const PRICE_FORMAT = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 3,
  maximumFractionDigits: 18,
});

/**
 * Points → `{ time, value }` in strictly ascending UTC seconds, as `setData`
 * requires. Two snapshots in the same second keep the later one.
 */
export function toLineData(points: readonly PricePoint[]): LineData<UTCTimestamp>[] {
  const bySecond = new Map<number, number>();
  for (const point of points) {
    const value = Number(point.priceSolPerToken);
    if (Number.isFinite(value)) bySecond.set(Math.floor(Date.parse(point.ts) / 1000), value);
  }
  return [...bySecond.entries()]
    .sort(([a], [b]) => a - b)
    .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

/** `rgba()` from a design token in index.css (RGB channels, e.g. `--accent: 242 169 59`). */
function tokenColor(token: string, alpha = 1): string {
  const channels = getComputedStyle(document.documentElement)
    .getPropertyValue(`--${token}`)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return channels.length === 3 ? `rgba(${channels.join(', ')}, ${alpha})` : 'transparent';
}

function ChartFrame({ caption, children }: { caption: ReactNode; children: ReactNode }) {
  return (
    <figure aria-label="Token price chart" className="font-mono">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-xs uppercase tracking-label text-ink-400">Price · SOL per token</span>
        {caption}
      </figcaption>
      {children}
    </figure>
  );
}

function PriceChartCanvas({ points }: { points: readonly PricePoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const grid = tokenColor('ink-800', 0.6);
    const chart = createChart(container, {
      width: container.clientWidth,
      height: CHART_HEIGHT,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: tokenColor('ink-400'),
        fontFamily: getComputedStyle(container).fontFamily,
        fontSize: 11,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: tokenColor('ink-600'), labelBackgroundColor: tokenColor('ink-800') },
        horzLine: { color: tokenColor('ink-600'), labelBackgroundColor: tokenColor('ink-800') },
      },
      handleScroll: { mouseWheel: false },
      handleScale: { mouseWheel: false },
    });
    seriesRef.current = chart.addSeries(LineSeries, {
      color: tokenColor('accent'),
      lineWidth: 2,
      crosshairMarkerBorderColor: tokenColor('ink-950'),
      crosshairMarkerBackgroundColor: tokenColor('accent-strong'),
      priceLineColor: tokenColor('accent', 0.5),
      priceFormat: {
        type: 'custom',
        minMove: 1e-12,
        formatter: (price: number) => PRICE_FORMAT.format(price),
      },
    });
    chartRef.current = chart;

    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(([entry]) => {
            if (entry !== undefined) chart.applyOptions({ width: entry.contentRect.width });
          });
    observer?.observe(container);

    return () => {
      observer?.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    seriesRef.current?.setData(toLineData(points));
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  return <div ref={containerRef} data-testid="price-chart-canvas" className="mt-3 h-56 w-full" />;
}

function LatestPrice({ points }: { points: readonly PricePoint[] }) {
  const first = Number(points[0]?.priceSolPerToken);
  const last = points[points.length - 1];
  if (last === undefined) return null;
  const change = first > 0 ? Number(last.priceSolPerToken) / first - 1 : null;
  return (
    <span className="flex items-baseline gap-2 text-sm tabular-nums">
      <span className="text-ink-50">{formatDecimal(last.priceSolPerToken, 12)}</span>
      {change !== null && (
        <span className={change < 0 ? 'text-negative' : 'text-positive'}>
          {change > 0 ? '+' : ''}
          {formatPct(change, 2)}
        </span>
      )}
    </span>
  );
}

/** Line chart of `priceSolPerToken` over the snapshot series from `/api/tokens/:mint/snapshots`. */
export function PriceChart({ points }: { points: readonly PricePoint[] }) {
  if (points.length < MIN_CHART_POINTS) {
    return (
      <ChartFrame caption={null}>
        <p className="mt-3 flex h-56 items-center justify-center rounded-sm border border-dashed border-ink-800 text-xs uppercase tracking-label text-ink-600">
          No price data yet
        </p>
      </ChartFrame>
    );
  }
  return (
    <ChartFrame caption={<LatestPrice points={points} />}>
      <PriceChartCanvas points={points} />
    </ChartFrame>
  );
}
