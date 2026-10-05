import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { request } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BlockedUpstreamError,
  createUpstreamAgent,
  isPublicAddress,
} from '../src/lib/upstreamAgent.js';

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
    '::127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
    'fc00::1',
    'fd00:ec2::254',
    'fe80::1',
    'ff02::1',
    'localhost',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])(
    'allows %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe('createUpstreamAgent', () => {
  let server: Server;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits += 1;
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    ({ port } = server.address() as AddressInfo);
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    ['an IPv4 literal', () => `http://127.0.0.1:${port}/`],
    ['an IPv6 literal', () => `http://[::1]:${port}/`],
    ['an IPv4-mapped IPv6 literal', () => `http://[::ffff:127.0.0.1]:${port}/`],
    ['a host name resolving to loopback', () => `http://localhost:${port}/`],
  ])('refuses %s before connecting', async (_label, url) => {
    const before = hits;
    const dispatcher = createUpstreamAgent({ allowPrivate: false });
    try {
      await expect(request(url(), { dispatcher })).rejects.toBeInstanceOf(BlockedUpstreamError);
      expect(hits).toBe(before);
    } finally {
      await dispatcher.close();
    }
  });

  it('reaches a loopback upstream when private upstreams are allowed', async () => {
    const dispatcher = createUpstreamAgent({ allowPrivate: true });
    try {
      const res = await request(`http://127.0.0.1:${port}/`, { dispatcher });
      expect(res.statusCode).toBe(200);
      expect(await res.body.text()).toBe('ok');
    } finally {
      await dispatcher.close();
    }
  });
});
