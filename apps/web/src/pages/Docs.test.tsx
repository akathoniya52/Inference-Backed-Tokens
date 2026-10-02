import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderRoute } from '../test-utils';

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
});

function codeBlock(title: string): HTMLElement {
  return screen.getByRole('figure', { name: title });
}

function tocLink(name: string): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'On this page' })).getByRole('link', {
    name,
  });
}

function current(name: string): string | null {
  return tocLink(name).getAttribute('aria-current');
}

const SECTION_IDS = ['quickstart', 'sdk', 'curl', 'streaming', 'headers', 'errors', 'revenue'];
const VIEWPORT_HEIGHT = 1000;
const READING_LINE_Y = VIEWPORT_HEIGHT * 0.2;
const PAGE_HEIGHT = 5000;
const OFFSCREEN_BELOW = PAGE_HEIGHT;

function setScrollGeometry({ scrollY, atBottom }: { scrollY: number; atBottom: boolean }) {
  Object.defineProperty(window, 'innerHeight', { value: VIEWPORT_HEIGHT, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true });
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    value: atBottom ? scrollY + VIEWPORT_HEIGHT : PAGE_HEIGHT,
    configurable: true,
  });
}

function scrollPage(sectionTops: Record<string, number>, { atBottom = false } = {}) {
  setScrollGeometry({ scrollY: 500, atBottom });
  for (const id of SECTION_IDS) {
    const section = document.getElementById(id);
    if (section === null) throw new Error(`no section #${id}`);
    vi.spyOn(section, 'getBoundingClientRect').mockReturnValue({
      top: sectionTops[id] ?? OFFSCREEN_BELOW,
    } as DOMRect);
  }
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
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

  describe('on this page', () => {
    it('highlights the first section until the hash or the scroll position says otherwise', () => {
      renderRoute('/docs');
      expect(current('Quickstart')).toBe('location');
      expect(tocLink('Quickstart').className).toContain('border-accent');
      expect(current('Errors')).toBeNull();
      expect(tocLink('Errors').className).toContain('border-transparent');
    });

    it('highlights the section named by the URL hash', () => {
      renderRoute('/docs#errors');
      expect(current('Errors')).toBe('location');
      expect(current('Quickstart')).toBeNull();
    });

    it('follows the last section whose top has passed the reading line', () => {
      const { unmount } = renderRoute('/docs');
      scrollPage({
        quickstart: READING_LINE_Y - 1100,
        sdk: READING_LINE_Y - 600,
        curl: READING_LINE_Y - 50,
        streaming: READING_LINE_Y + 400,
      });
      expect(current('curl')).toBe('location');
      expect(current('Quickstart')).toBeNull();
      expect(current('Streaming')).toBeNull();

      const remove = vi.spyOn(window, 'removeEventListener');
      unmount();
      expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
    });

    it('returns to the first section when the page is scrolled above it', () => {
      renderRoute('/docs');
      scrollPage({ errors: READING_LINE_Y - 300 });
      expect(current('Errors')).toBe('location');

      scrollPage({ quickstart: READING_LINE_Y + 100 });
      expect(current('Quickstart')).toBe('location');
      expect(current('Errors')).toBeNull();
    });

    it('highlights the last section at the bottom of the page even if it never reaches the line', () => {
      renderRoute('/docs');
      scrollPage(
        { errors: READING_LINE_Y - 150, revenue: READING_LINE_Y + 300 },
        { atBottom: true },
      );
      expect(current('Where the money goes')).toBe('location');
      expect(current('Errors')).toBeNull();
    });

    it('reads the scroll position on mount when the page is already scrolled', () => {
      setScrollGeometry({ scrollY: 500, atBottom: false });
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        top: READING_LINE_Y - 250,
      } as DOMRect);
      renderRoute('/docs');
      expect(current('Where the money goes')).toBe('location');
      expect(current('Quickstart')).toBeNull();
    });
  });
});
