import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderRoute } from './test-utils';

vi.mock('./pages/DocsPage', () => ({
  DocsPage: () => {
    throw new Error('render-time failure');
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('route errorElement (WEB-05)', () => {
  it('keeps the layout and offers reload and a way back when a page throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderRoute('/docs');

    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Explore' }).getAttribute('href')).toBe('/');
    expect(screen.queryByText(/render-time failure/)).toBeNull();
  });
});
