import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { Agent, buildConnector, type Dispatcher } from 'undici';

/**
 * Ranges a provider's `upstream.baseUrl` may never reach (SSRF): loopback,
 * private, CGNAT, link-local (cloud metadata), unspecified, multicast,
 * documentation/benchmark and reserved space, and the IPv6 forms that embed an
 * IPv4 address. Node checks IPv4-mapped IPv6 (`::ffff:a.b.c.d`) against the
 * IPv4 rules.
 */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible
  ['::ffff:0:0:0', 96], // SIIT IPv4-translated (`::ffff:0:a.b.c.d`)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/** True for an IP literal outside every blocked range; false for anything else. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export class BlockedUpstreamError extends Error {
  override readonly name = 'BlockedUpstreamError';

  constructor() {
    super('upstream address is not allowed');
  }
}

/**
 * Resolves once and connects to the address it checked, so a DNS answer that
 * changes between check and connect (rebinding) is never used. Any blocked
 * address in the answer rejects the whole host.
 */
const guardedLookup: LookupFunction = (hostname, options: LookupOptions, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) {
      callback(err, '');
      return;
    }
    const [first] = addresses;
    if (first === undefined || !addresses.every((entry) => isPublicAddress(entry.address))) {
      callback(new BlockedUpstreamError(), '');
      return;
    }
    if (options.all === true) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};

function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * The dispatcher for every provider upstream call. Unless `allowPrivate`
 * (local dev and tests against mock-upstream on 127.0.0.1), connections go
 * only to public addresses: IP literals are checked here, since `net.connect`
 * skips `lookup` for them, and host names through `guardedLookup`. undici's
 * `request` never follows redirects, so a 3xx cannot bounce the call inward.
 */
export function createUpstreamAgent({ allowPrivate }: { allowPrivate: boolean }): Dispatcher {
  if (allowPrivate) return new Agent();
  const connector = buildConnector({ lookup: guardedLookup });
  return new Agent({
    connect: (options, callback) => {
      const host = unbracket(options.hostname);
      if (isIP(host) !== 0 && !isPublicAddress(host)) {
        callback(new BlockedUpstreamError(), null);
        return;
      }
      connector(options, callback);
    },
  });
}
