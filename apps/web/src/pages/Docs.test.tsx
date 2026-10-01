import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderRoute } from '../test-utils';

afterEach(() => {
  vi.restoreAllMocks();
});

function codeBlock(title: string): HTMLElement {
  return screen.getByRole('figure', { name: title });
}

describe('DocsPage', () => {
  it('shows the OpenAI SDK baseURL swap against VITE_API_URL', () => {
    renderRoute('/docs');
    expect(screen.getByRole('heading', { level: 1, name: 'API quickstart' })).toBeTruthy();

    const js = codeBlock('JavaScript / TypeScript').textContent ?? '';
    expect(js).toContain('baseURL');
    expect(js).toContain("baseURL: 'http://api.test/v1'");
    expect(js).toContain("apiKey: 'ibt_");

    const python = codeBlock('Python').textContent ?? '';
    expect(python).toContain('base_url="http://api.test/v1"');

    const curl = codeBlock('curl').textContent ?? '';
    expect(curl).toContain('http://api.test/v1/chat/completions');
    expect(document.body.textContent).toContain('/v1/chat/completions');
  });

  it('walks through sign in, deposit and key creation', () => {
    renderRoute('/docs');
    const steps = within(screen.getByRole('list', { name: 'Quickstart steps' })).getAllByRole(
      'listitem',
    );
    expect(steps.map((step) => step.querySelector('h3')?.textContent)).toEqual([
      'Sign in with your wallet',
      'Deposit USDC',
      'Create an API key',
    ]);
    expect(screen.getAllByRole('link', { name: 'Dashboard' })[0]?.getAttribute('href')).toBe(
      '/dashboard',
    );
  });

  it('lists the response headers and every gateway error code', () => {
    renderRoute('/docs');
    const headers = screen.getByRole('table', { name: 'Response headers' });
    for (const header of ['X-Request-Id', 'X-Cost-Usdc', 'X-Balance-Usdc', 'X-Discount-Bps']) {
      expect(within(headers).getByText(header)).toBeTruthy();
    }
    const errors = screen.getByRole('table', { name: 'Gateway errors' });
    for (const code of [
      'invalid_request',
      'invalid_api_key',
      'insufficient_credits',
      'model_not_found',
      'rate_limited',
      'upstream_error',
      'model_paused',
      'upstream_timeout',
    ]) {
      expect(within(errors).getByText(code)).toBeTruthy();
    }
  });

  it('marks streaming as coming soon and explains the 70/20/10 split', () => {
    renderRoute('/docs');
    expect(screen.getByText(/Streaming is coming soon/)).toBeTruthy();
    const split = screen.getByRole('table', { name: 'Revenue split' });
    expect(within(split).getByText('70%')).toBeTruthy();
    expect(within(split).getByText('20%')).toBeTruthy();
    expect(within(split).getByText('10%')).toBeTruthy();
  });

  it('copies a snippet', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderRoute('/docs');
    fireEvent.click(within(codeBlock('curl')).getByRole('button', { name: 'Copy curl' }));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('http://api.test/v1/chat/completions'),
    );
    expect(await within(codeBlock('curl')).findByRole('button', { name: 'Copied' })).toBeTruthy();
  });
});
