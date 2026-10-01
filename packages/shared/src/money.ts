import { SOL_DECIMALS, USDC_DECIMALS } from './constants.js';

/** Integer accepted at JSON / DB boundaries; converted to bigint before any math. */
export type IntLike = bigint | number | string;

const INTEGER_STRING = /^-?\d+$/;

export function toBigInt(value: IntLike, name = 'value'): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${name} must be a safe integer, got ${value}`);
    }
    return BigInt(value);
  }
  if (!INTEGER_STRING.test(value)) {
    throw new RangeError(`${name} must be an integer string, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

export function toNonNegativeBigInt(value: IntLike, name = 'value'): bigint {
  const result = toBigInt(value, name);
  if (result < 0n) throw new RangeError(`${name} must be >= 0, got ${result}`);
  return result;
}

export interface FormatUnitsOptions {
  /** Drop trailing fractional zeros (and the dot when nothing is left). */
  trim?: boolean;
}

export function formatUnits(
  amount: bigint,
  decimals: number,
  { trim = false }: FormatUnitsOptions = {},
): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  let fraction = digits.slice(digits.length - decimals);
  if (trim) fraction = fraction.replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fraction.length > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

const DECIMAL_STRING = /^(-?)(\d+)(?:\.(\d+))?$/;

export function parseUnits(value: string, decimals: number): bigint {
  const match = DECIMAL_STRING.exec(value);
  if (!match) throw new RangeError(`not a decimal amount: ${JSON.stringify(value)}`);
  const [, sign, whole = '', fraction = ''] = match;
  if (fraction.length > decimals) {
    throw new RangeError(`${JSON.stringify(value)} has more than ${decimals} decimals`);
  }
  const units = BigInt(whole + fraction.padEnd(decimals, '0'));
  return sign === '-' ? -units : units;
}

export function microToUsdcString(micro: bigint): string {
  return formatUnits(micro, USDC_DECIMALS);
}

export function usdcStringToMicro(usdc: string): bigint {
  return parseUnits(usdc, USDC_DECIMALS);
}

export function lamportsToSol(lamports: bigint): string {
  return formatUnits(lamports, SOL_DECIMALS, { trim: true });
}

export function solToLamports(sol: string): bigint {
  return parseUnits(sol, SOL_DECIMALS);
}

/** Integer division rounding toward +∞, for non-negative operands. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
