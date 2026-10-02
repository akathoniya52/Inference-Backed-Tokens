import { vi } from 'vitest';

// Stand-in for `lightweight-charts` (jsdom has no canvas). Wire it with
// `vi.mock('lightweight-charts', () => import('../fixtures/lightweightCharts'))`
// and call `resetChartMock()` before each test.

export const LineSeries = { type: 'Line' } as const;
export const ColorType = { Solid: 'solid' } as const;

const series = { setData: vi.fn() };
const timeScale = { fitContent: vi.fn() };
const chart = {
  addSeries: vi.fn(() => series),
  applyOptions: vi.fn(),
  timeScale: vi.fn(() => timeScale),
  remove: vi.fn(),
};

export const createChart = vi.fn(() => chart);

export const chartMock = {
  createChart,
  addSeries: chart.addSeries,
  setData: series.setData,
  applyOptions: chart.applyOptions,
  fitContent: timeScale.fitContent,
  remove: chart.remove,
};

export function resetChartMock(): void {
  for (const spy of Object.values(chartMock)) spy.mockClear();
}
