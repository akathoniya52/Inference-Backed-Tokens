import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

// Imported from main.tsx so both Meteora SDKs land in the production bundle and
// a missing Node polyfill fails `vite build` now rather than in the trade UI.
export const sdkNames: readonly string[] = [DynamicBondingCurveClient.name, CpAmm.name];
