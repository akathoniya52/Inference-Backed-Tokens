import { parseUnits } from '@ibt/shared';

/** Longer inputs are typos, and would only feed huge strings to `BigInt`. */
const MAX_AMOUNT_INPUT_LENGTH = 40;
const AMOUNT_INPUT = /^(\d*)(?:\.(\d*))?$/;

/**
 * Parses what people type into an amount field (`1`, `0.5`, `.5`, `1.`) into
 * base units with BigInt math. `null` for anything that is not a positive
 * amount with at most `decimals` fractional digits.
 */
export function parseAmountInput(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (trimmed.length > MAX_AMOUNT_INPUT_LENGTH) return null;
  const match = AMOUNT_INPUT.exec(trimmed);
  if (!match) return null;
  const [, whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') return null;
  if (fraction.length > decimals) return null;
  const amount = parseUnits(
    `${whole === '' ? '0' : whole}.${fraction === '' ? '0' : fraction}`,
    decimals,
  );
  return amount > 0n ? amount : null;
}
