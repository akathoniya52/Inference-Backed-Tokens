import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chartMock, LineSeries, resetChartMock } from '../fixtures/lightweightCharts';
import { curveSnapshots } from '../fixtures/tokens';
import { PriceChart, toLineData } from './PriceChart';

vi.mock('lightweight-charts', () => import('../fixtures/lightweightCharts'));

const points = curveSnapshots.points;
const seconds = (iso: string) => Date.parse(iso) / 1000;

beforeEach(() => {
  resetChartMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PriceChart', () => {
  it('draws a v5 line series with the points as ascending {time, value}', () => {
    render(<PriceChart points={[...points].reverse()} />);

    expect(screen.getByRole('figure', { name: 'Token price chart' })).toBeTruthy();
    expect(chartMock.createChart).toHaveBeenCalledTimes(1);
    expect(chartMock.createChart).toHaveBeenCalledWith(
      screen.getByTestId('price-chart-canvas'),
      expect.objectContaining({ height: 224 }),
    );
    expect(chartMock.addSeries).toHaveBeenCalledWith(LineSeries, expect.any(Object));
    expect(chartMock.setData).toHaveBeenCalledTimes(1);
    expect(chartMock.setData).toHaveBeenLastCalledWith([
      { time: seconds('2026-10-02T13:59:00.000Z'), value: 5.2e-9 },
      { time: seconds('2026-10-02T13:59:15.000Z'), value: 5.5e-9 },
      { time: seconds('2026-10-02T13:59:30.000Z'), value: 5.4e-9 },
      { time: seconds('2026-10-02T13:59:45.000Z'), value: 5.8e-9 },
      { time: seconds('2026-10-02T14:00:00.000Z'), value: 6.1e-9 },
    ]);
    expect(chartMock.fitContent).toHaveBeenCalled();
  });

  it('captions the latest price and the change over the window', () => {
    render(<PriceChart points={points} />);
    const figure = screen.getByRole('figure', { name: 'Token price chart' });
    expect(figure.textContent).toContain('0.0000000061');
    expect(figure.textContent).toContain('+17.31%');
  });

  it('updates the same series when new points arrive', () => {
    const { rerender } = render(<PriceChart points={points.slice(0, 3)} />);
    rerender(<PriceChart points={points} />);
    expect(chartMock.createChart).toHaveBeenCalledTimes(1);
    expect(chartMock.setData).toHaveBeenCalledTimes(2);
    expect(chartMock.setData.mock.lastCall?.[0]).toHaveLength(5);
  });

  it('shows a quiet empty state below two points and never creates a chart', () => {
    const { rerender } = render(<PriceChart points={[]} />);
    expect(screen.getByText('No price data yet')).toBeTruthy();
    rerender(<PriceChart points={points.slice(0, 1)} />);
    expect(screen.getByText('No price data yet')).toBeTruthy();
    expect(chartMock.createChart).not.toHaveBeenCalled();
  });

  it('resizes with its container and removes the chart on unmount', () => {
    let onResize: ResizeObserverCallback = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          onResize = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    const { unmount } = render(<PriceChart points={points} />);

    onResize([{ contentRect: { width: 640 } } as ResizeObserverEntry], {} as ResizeObserver);
    expect(chartMock.applyOptions).toHaveBeenCalledWith({ width: 640 });

    unmount();
    expect(disconnect).toHaveBeenCalled();
    expect(chartMock.remove).toHaveBeenCalledTimes(1);
  });
});

describe('toLineData', () => {
  it('sorts by time, keeps the later point within one second and drops non-numeric prices', () => {
    const at = (ts: string, priceSolPerToken: string) => ({
      ts,
      priceSolPerToken,
      progress: 0.5,
      phase: 'curve' as const,
    });
    expect(
      toLineData([
        at('2026-10-02T12:00:10.000Z', '3'),
        at('2026-10-02T12:00:00.200Z', '1'),
        at('2026-10-02T12:00:00.900Z', '2'),
        at('2026-10-02T12:00:20.000Z', 'NaN'),
      ]),
    ).toEqual([
      { time: seconds('2026-10-02T12:00:00.000Z'), value: 2 },
      { time: seconds('2026-10-02T12:00:10.000Z'), value: 3 },
    ]);
  });
});
