import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import bs58 from 'bs58';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AppError } from '../src/errors.js';
import {
  decrypt,
  encrypt,
  generateApiKey,
  generateDepositRef,
  keyPrefix,
  parseEnv,
  sha256Hex,
} from '../src/node/index.js';

const masterKey = randomBytes(32);
const masterKeyHex = masterKey.toString('hex');

function flipBit(ciphertext: string, offset: number): string {
  const bytes = Buffer.from(ciphertext, 'base64');
  bytes.writeUInt8(bytes.readUInt8(offset) ^ 0x01, offset);
  return bytes.toString('base64');
}

describe('encrypt / decrypt (AES-256-GCM)', () => {
  it('round-trips with the master key given as hex or base64', () => {
    const plaintext = 'upstream key ünïcode ✓';
    const ciphertext = encrypt(plaintext, masterKeyHex);
    expect(decrypt(ciphertext, masterKeyHex)).toBe(plaintext);
    expect(decrypt(ciphertext, masterKey.toString('base64'))).toBe(plaintext);
  });

  it('packs base64(iv[12] | tag[16] | data) with a fresh IV per call', () => {
    const plaintext = 'same plaintext';
    const a = Buffer.from(encrypt(plaintext, masterKeyHex), 'base64');
    const b = Buffer.from(encrypt(plaintext, masterKeyHex), 'base64');
    expect(a).toHaveLength(12 + 16 + Buffer.byteLength(plaintext));
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
  });

  it('decrypts a ciphertext packed independently in the documented layout', () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
    const data = Buffer.concat([cipher.update('interop', 'utf8'), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    expect(decrypt(packed, masterKeyHex)).toBe('interop');
  });

  it.each([
    ['iv', 0],
    ['tag', 12],
    ['data', 28],
  ])('throws when the %s is tampered with', (_part, offset) => {
    const ciphertext = encrypt('tamper me', masterKeyHex);
    expect(() => decrypt(flipBit(ciphertext, offset), masterKeyHex)).toThrow();
  });

  it('throws under a different master key', () => {
    const ciphertext = encrypt('wrong key', masterKeyHex);
    expect(() => decrypt(ciphertext, randomBytes(32).toString('hex'))).toThrow();
  });

  it('rejects a ciphertext too short to hold the iv and a full tag', () => {
    expect(() => decrypt(randomBytes(12 + 15).toString('base64'), masterKeyHex)).toThrow(
      /too short/,
    );
  });

  it.each([
    ['16-byte hex', randomBytes(16).toString('hex')],
    ['33-byte hex', randomBytes(33).toString('hex')],
    ['31-byte base64', randomBytes(31).toString('base64')],
    ['33-byte base64', randomBytes(33).toString('base64')],
    ['non-hex, non-base64', 'z'.repeat(63) + '!'],
    ['empty', ''],
  ])('rejects a %s master key', (_label, badKey) => {
    expect(() => encrypt('x', badKey)).toThrow(/32 bytes/);
    expect(() => decrypt(encrypt('x', masterKeyHex), badKey)).toThrow(/32 bytes/);
  });
});

describe('ids', () => {
  it('generateApiKey is ibt_ + base58 of 32 random bytes', () => {
    const key = generateApiKey();
    expect(key.startsWith('ibt_')).toBe(true);
    expect(bs58.decode(key.slice(4))).toHaveLength(32);
    expect(generateApiKey()).not.toBe(key);
  });

  it('sha256Hex matches the FIPS 180-2 "abc" vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('keyPrefix keeps the first 12 characters', () => {
    const key = generateApiKey();
    expect(keyPrefix(key)).toBe(key.slice(0, 12));
    expect(keyPrefix(key)).toHaveLength(12);
  });

  it('generateDepositRef yields 8 base58 characters', () => {
    const refs = new Set(Array.from({ length: 1000 }, () => generateDepositRef()));
    expect(refs.size).toBe(1000);
    for (const ref of refs) expect(ref).toMatch(/^[1-9A-HJ-NP-Za-km-z]{8}$/);
  });
});

describe('parseEnv', () => {
  const schema = z.object({
    PORT: z.coerce.number().int().positive(),
    PUBLIC_URL: z.url(),
    LOG_LEVEL: z.enum(['debug', 'info']).default('info'),
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the parsed, defaulted values', () => {
    expect(parseEnv(schema, { PORT: '4000', PUBLIC_URL: 'http://localhost:4000' })).toEqual({
      PORT: 4000,
      PUBLIC_URL: 'http://localhost:4000',
      LOG_LEVEL: 'info',
    });
  });

  it('throws AppError(internal) naming the failing keys, never their values', () => {
    let caught: unknown;
    try {
      parseEnv(schema, {
        PORT: 'port-value-leak',
        PUBLIC_URL: 'url-value-leak',
        LOG_LEVEL: 'loud',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe('internal');
    expect(err.message).toBe('invalid environment variables: PORT, PUBLIC_URL, LOG_LEVEL');
    expect(JSON.stringify(err)).not.toMatch(/value-leak|loud/);
  });

  it('reports a missing key', () => {
    expect(() => parseEnv(schema, { PORT: '4000' })).toThrow(
      'invalid environment variables: PUBLIC_URL',
    );
  });

  it('reads process.env by default', () => {
    vi.stubEnv('IBT_PARSE_ENV_PROBE', 'from-process-env');
    expect(parseEnv(z.object({ IBT_PARSE_ENV_PROBE: z.string() }))).toEqual({
      IBT_PARSE_ENV_PROBE: 'from-process-env',
    });
  });
});

describe('entry points', () => {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
  const SPECIFIER = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g;

  function rootEntryGraph(): { files: string[]; specifiers: string[] } {
    const files = new Set<string>();
    const specifiers = new Set<string>();
    const visit = (file: string): void => {
      if (files.has(file)) return;
      files.add(file);
      for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
        const specifier = match[1] ?? match[2] ?? '';
        specifiers.add(specifier);
        if (specifier.startsWith('.')) {
          visit(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
        }
      }
    };
    visit(resolve(srcDir, 'index.ts'));
    return { files: [...files], specifiers: [...specifiers] };
  }

  it('the browser-safe root entry never reaches ./node or node: built-ins', () => {
    const { files, specifiers } = rootEntryGraph();
    expect(specifiers).toContain('./errors.js');
    expect(specifiers.filter((s) => s.startsWith('./node'))).toEqual([]);
    expect(specifiers.filter((s) => s.startsWith('node:') || s === 'pino')).toEqual([]);
    expect(files.filter((f) => f.startsWith(resolve(srcDir, 'node')))).toEqual([]);
  });

  it('package.json exposes ./node with the same condition layout as .', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports['./node']).toEqual({
      development: './src/node/index.ts',
      types: './dist/node/index.d.ts',
      default: './dist/node/index.js',
    });
  });
});
