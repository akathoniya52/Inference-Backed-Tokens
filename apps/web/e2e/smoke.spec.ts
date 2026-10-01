import { expect, test, type Page, type Route } from '@playwright/test';

import { CURVE_MINT, GRADUATED_MINT, modelsPage1, modelsPage2 } from '../src/fixtures/models';
import { curveTokenState, graduatedTokenState } from '../src/fixtures/tokens';
import { E2E_ENV, PREVIEW_URL } from './env';

const API_ORIGIN = new URL(E2E_ENV.VITE_API_URL).origin;
const APP_ORIGIN = new URL(PREVIEW_URL).origin;
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const TOKEN_STATES: Record<string, unknown> = {
  [CURVE_MINT]: curveTokenState,
  [GRADUATED_MINT]: graduatedTokenState,
};
const TOKEN_STATE_PATH = /^\/api\/tokens\/([^/]+)\/state$/;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({ status, headers: CORS, contentType: 'application/json', json: body });
}

function fulfillApi(route: Route, url: URL): Promise<void> {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  if (url.pathname === '/api/models') {
    return json(route, 200, url.searchParams.has('cursor') ? modelsPage2 : modelsPage1);
  }
  const mint = TOKEN_STATE_PATH.exec(url.pathname)?.[1];
  if (mint !== undefined && mint in TOKEN_STATES) return json(route, 200, TOKEN_STATES[mint]);
  return json(route, 404, {
    error: { code: 'not_found', message: `no e2e fixture for ${url.pathname}`, requestId: null },
  });
}

interface PageWatch {
  consoleErrors: string[];
  failedRequests: string[];
  unexpectedRequests: string[];
}

/**
 * Serves the app from the preview server, the API from fixtures and Google
 * Fonts as empty CSS; anything else is recorded and answered with a 404 so the
 * smoke never reaches the real network.
 */
async function watchPage(page: Page): Promise<PageWatch> {
  const watch: PageWatch = { consoleErrors: [], failedRequests: [], unexpectedRequests: [] };

  page.on('console', (message) => {
    if (message.type() === 'error') watch.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => watch.consoleErrors.push(error.message));
  page.on('requestfailed', (request) => {
    watch.failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ''}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      watch.failedRequests.push(`${response.url()} ${response.status()}`);
  });

  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === APP_ORIGIN) return route.continue();
    if (url.origin === API_ORIGIN) return fulfillApi(route, url);
    if (FONT_HOSTS.has(url.hostname)) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    }
    watch.unexpectedRequests.push(url.href);
    return route.fulfill({ status: 404, body: '' });
  });

  return watch;
}

function expectCleanRun(watch: PageWatch): void {
  expect.soft(watch.consoleErrors, 'console errors').toEqual([]);
  expect.soft(watch.failedRequests, 'failed requests').toEqual([]);
  expect.soft(watch.unexpectedRequests, 'requests outside the app, API and fonts').toEqual([]);
}

test.describe('smoke (stubbed api)', () => {
  test('explore lists the fixture models', async ({ page }) => {
    const watch = await watchPage(page);
    const modelsRequest = page.waitForRequest((request) =>
      request.url().startsWith(`${API_ORIGIN}/api/models`),
    );

    await page.goto('/');
    await modelsRequest;

    await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible();
    for (const model of modelsPage1.items) {
      await expect(page.getByText(model.name, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();
    expectCleanRun(watch);
  });

  test('docs renders the quickstart sections', async ({ page }) => {
    const watch = await watchPage(page);

    await page.goto('/docs');

    await expect(page.getByRole('heading', { level: 1, name: 'API quickstart' })).toBeVisible();
    for (const name of ['Quickstart', 'OpenAI SDK', 'Errors', 'Where the money goes']) {
      await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
    }
    await expect(page.getByText(`${E2E_ENV.VITE_API_URL}/v1`).first()).toBeVisible();
    expectCleanRun(watch);
  });
});

// G29: the live flow runs only against an explicit staging deployment.
test.describe('staging', { tag: '@staging' }, () => {
  const stagingUrl = process.env.STAGING_URL;
  test.skip(!stagingUrl, 'set STAGING_URL to run against a deployed site');

  test('explore and docs render against the live api', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(new URL('/', stagingUrl).href);
    await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    await page.goto(new URL('/docs', stagingUrl).href);
    await expect(page.getByRole('heading', { level: 1, name: 'API quickstart' })).toBeVisible();
    expect(errors, 'console errors').toEqual([]);
  });
});
