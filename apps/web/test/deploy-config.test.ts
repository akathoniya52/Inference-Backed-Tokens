// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

interface VercelConfig {
  rewrites: { source: string; destination: string }[];
}

interface WebManifest {
  start_url?: string;
  scope?: string;
}

describe('deploy config', () => {
  it('never rewrites a missing /assets/* file to index.html (WEB-14)', () => {
    const { rewrites } = readJson('../vercel.json') as VercelConfig;
    const spa = rewrites.find((rewrite) => rewrite.destination === '/index.html');
    expect(spa?.source).toBe('/((?!assets/).*)');

    // Vercel matches path-to-regexp sources; the group is a plain regex.
    const pattern = new RegExp(`^${spa?.source ?? ''}$`);
    expect(pattern.test('/t/llama-fast')).toBe(true);
    expect(pattern.test('/dashboard')).toBe(true);
    expect(pattern.test('/assets/index-abc123.js')).toBe(false);
  });

  it('pins the PWA start URL and scope to the site root (WEB-15)', () => {
    const manifest = readJson('../public/site.webmanifest') as WebManifest;
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
  });
});
