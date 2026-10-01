import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderRoute } from '../src/test-utils';

describe('@ibt/web', () => {
  it('renders the app title in the shell', () => {
    renderRoute('/');
    expect(screen.getByText('Inference-Backed Tokens')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Explore' })).toBeTruthy();
  });

  it.each([
    ['/t/llama-3', 'Token llama-3'],
    ['/launch', 'Launch a model'],
    ['/dashboard', 'Dashboard'],
    ['/provider', 'Provider'],
    ['/docs', 'API quickstart'],
    ['/nowhere', 'Not found'],
  ])('routes %s to its page', (path, heading) => {
    renderRoute(path);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeTruthy();
  });

  it('links the nav to every static route and marks the active one', () => {
    renderRoute('/dashboard');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const links = Array.from(nav.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/',
      '/launch',
      '/dashboard',
      '/provider',
      '/docs',
    ]);
    expect(links.find((a) => a.getAttribute('aria-current') === 'page')?.textContent).toBe(
      'Dashboard',
    );
  });

  it('shows the wallet button', () => {
    renderRoute('/');
    expect(screen.getByRole('button', { name: /select wallet/i })).toBeTruthy();
  });
});
