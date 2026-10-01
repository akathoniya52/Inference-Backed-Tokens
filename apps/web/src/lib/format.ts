import {
  formatUnits as formatExactUnits,
  SOL_DECIMALS,
  toBigInt,
  USDC_DECIMALS,
} from '@ibt/shared';

// Display formatting for on-chain and ledger amounts. Base-unit conversion is
// integer BigInt math only (shared `formatUnits` does the exact split); the
// only rounding is half away from zero at `maxFractionDigits`.

function assertDigitCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

function roundToDigits(amount: bigint, drop: number): bigint {
  if (drop === 0) return amount;
  const divisor = 10n ** BigInt(drop);
  const magnitude = amount < 0n ? -amount : amount;
  const rounded = (magnitude + divisor / 2n) / divisor;
  return amount < 0n ? -rounded : rounded;
}

function groupThousands(formatted: string): string {
  const [whole = '', fraction] = formatted.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/**
 * Formats integer base units as a grouped decimal string, e.g.
 * `formatUnits(1_234_567_890n, 9, 4)` → `'1.2346'`. Trailing fractional zeros
 * are trimmed.
 */
export function formatUnits(
  baseUnits: bigint | string,
  decimals: number,
  maxFractionDigits: number = decimals,
): string {
  assertDigitCount(decimals, 'decimals');
  assertDigitCount(maxFractionDigits, 'maxFractionDigits');
  const amount = toBigInt(baseUnits, 'baseUnits');
  const digits = Math.min(decimals, maxFractionDigits);
  const scaled = roundToDigits(amount, decimals - digits);
  return groupThousands(formatExactUnits(scaled, digits, { trim: true }));
}

/** Micro-USDC → USDC, up to 6 fraction digits by default. */
export function formatUsdc(micro: bigint | string, maxFractionDigits = USDC_DECIMALS): string {
  return formatUnits(micro, USDC_DECIMALS, maxFractionDigits);
}

/** Lamports → SOL, 4 fraction digits by default. */
export function formatSol(lamports: bigint | string, maxFractionDigits = 4): string {
  return formatUnits(lamports, SOL_DECIMALS, maxFractionDigits);
}

/** `4zMM…ncDU`; strings too short to shorten are returned unchanged. */
export function shortAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

/** Ratio → percentage, e.g. `0.9876` → `'98.8%'`. */
export function formatPct(ratio: number, fractionDigits = 1): string {
  if (!Number.isFinite(ratio)) return '—';
  const fixed = (ratio * 100).toFixed(fractionDigits);
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  return `${trimmed === '-0' ? '0' : trimmed}%`;
}
