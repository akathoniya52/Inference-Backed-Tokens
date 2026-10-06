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

/** ISO 8601 with an explicit `Z` or `±hh:mm` offset; anything else would parse as local time. */
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * `--period-start` for `settle-once` (KPR-10): needs an explicit UTC offset, an hour
 * boundary, and a period that has ended by `now` unless `force` is set.
 */
export function parsePeriodStart(
  raw: string,
  now: Date,
  { force = false }: { force?: boolean } = {},
): SettlementPeriod {
  if (!ISO_WITH_OFFSET.test(raw)) {
    throw new RangeError(
      '--period-start needs an ISO time with Z or an offset, e.g. 2026-10-06T10:00:00Z',
    );
  }
  const period = periodFromStart(new Date(raw));
  if (!force && period.periodEnd.getTime() > now.getTime()) {
    throw new RangeError('period has not ended yet; pass --force to settle it early');
  }
  return period;
}

export function periodFromStart(periodStart: Date): SettlementPeriod {
  const start = periodStart.getTime();
  if (Number.isNaN(start) || start % PERIOD_MS !== 0) {
    throw new RangeError('periodStart must be on a UTC hour boundary');
  }
  return { periodStart: new Date(start), periodEnd: new Date(start + PERIOD_MS) };
}
