import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  CURVE_DBC_POOL,
  curveModel,
  GRADUATED_DAMM_POOL,
  GRADUATED_DBC_POOL,
  graduatedModel,
} from '../fixtures/models';
import { curveTokenState, graduatedTokenState } from '../fixtures/tokens';
import { ModelStats } from './ModelStats';

function figure(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: 'dt' });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`no value for ${label}`);
  return value;
}

describe('ModelStats', () => {
  it('renders the 24 h fundamentals from the token state fixture', () => {
    render(<ModelStats model={graduatedModel} state={graduatedTokenState} />);
    expect(figure('Requests 24h').textContent).toBe('48,211');
    expect(figure('Success rate').textContent).toBe('99.9%');
    expect(figure('Revenue 24h').textContent).toBe('312.45 USDC');
    expect(figure('Locked liquidity').textContent).toBe('3.215 SOL');
  });

  it('links pool addresses to Solscan with ?cluster=devnet on devnet', () => {
    render(<ModelStats model={graduatedModel} state={graduatedTokenState} />);
    const dbc = within(figure('DBC pool')).getByRole('link');
    expect(dbc.getAttribute('href')).toBe(
      `https://solscan.io/account/${GRADUATED_DBC_POOL}?cluster=devnet`,
    );
    const damm = within(figure('DAMM v2 pool')).getByRole('link');
    expect(damm.getAttribute('href')).toBe(
      `https://solscan.io/account/${GRADUATED_DAMM_POOL}?cluster=devnet`,
    );
    expect(damm.getAttribute('target')).toBe('_blank');
    expect(damm.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('omits the cluster query on mainnet-beta', () => {
    render(<ModelStats model={curveModel} state={curveTokenState} cluster="mainnet-beta" />);
    const dbc = within(figure('DBC pool')).getByRole('link');
    expect(dbc.getAttribute('href')).toBe(`https://solscan.io/account/${CURVE_DBC_POOL}`);
    expect(figure('DAMM v2 pool').textContent).toBe('Not migrated');
  });

  it('falls back to the model stats before the token state loads', () => {
    render(<ModelStats model={curveModel} />);
    expect(figure('Requests 24h').textContent).toBe('1,180');
    expect(figure('Revenue 24h').textContent).toBe('14.30 USDC');
    expect(figure('Locked liquidity').textContent).toBe('0 SOL');
  });
});
