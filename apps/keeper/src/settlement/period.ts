export const PERIOD_MS = 3_600_000;

export interface SettlementPeriod {
  periodStart: Date;
  periodEnd: Date;
}

/** The last complete UTC hour `[H-1, H)` before `now` (L172). */
export function settlementPeriod(now: Date): SettlementPeriod {
  const end = Math.floor(now.getTime() / PERIOD_MS) * PERIOD_MS;
  return { periodStart: new Date(end - PERIOD_MS), periodEnd: new Date(end) };
}

export function periodFromStart(periodStart: Date): SettlementPeriod {
  const start = periodStart.getTime();
  if (Number.isNaN(start) || start % PERIOD_MS !== 0) {
    throw new RangeError('periodStart must be on a UTC hour boundary');
  }
  return { periodStart: new Date(start), periodEnd: new Date(start + PERIOD_MS) };
}
