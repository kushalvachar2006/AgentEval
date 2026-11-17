// SSRF guard for user-supplied agent endpoints. Every resolved address must be public.
// The caller must connect to one of the returned `addresses` (DNS pinning) to avoid rebinding.
import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError } from '../middleware/errors.js';

const v4ToInt = (s) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const V4_BLOCKS = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];

export function isBlockedIPv4(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([b, p]) => { const base = v4ToInt(b); return n >= base && n < base + 2 ** (32 - p); });
}

export function ipv6ToBigInt(input) {
  if (input.includes('%')) return null;
  let s = input;
  if (s.includes('.')) {
    const i = s.lastIndexOf(':');
    const v4 = s.slice(i + 1);
    if (!net.isIPv4(v4)) return null;
    const n = v4ToInt(v4);
    s = `${s.slice(0, i + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 1) groups = head;
  else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

const inRange = (n, base, prefix) => (n >> BigInt(128 - prefix)) === (ipv6ToBigInt(base) >> BigInt(128 - prefix));
const V6_BLOCKS = [['::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['2001::', 32], ['2002::', 16]];

export function isBlockedIPv6(ip) {
  const n = ipv6ToBigInt(ip);
  if (n === null) return true;
  if (inRange(n, '::ffff:0:0', 96) || inRange(n, '64:ff9b::', 96)) return isBlockedIPv4(Array.from({ length: 4 }, (_, i) => Number((n >> BigInt(24 - 8 * i)) & 0xffn)).join('.'));
  return V6_BLOCKS.some(([b, p]) => inRange(n, b, p));
}

export const isBlockedAddress = (ip) => (net.isIPv4(ip) ? isBlockedIPv4(ip) : net.isIPv6(ip) ? isBlockedIPv6(ip) : true);

const defaultResolve = (host) => dns.lookup(host, { all: true, verbatim: true });
const unsafe = (msg) => new AppError(422, 'UNSAFE_ENDPOINT', msg);

export async function assertSafeUrl(raw, { allowPrivate = false, resolve = defaultResolve } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new AppError(422, 'INVALID_URL', 'endpointUrl is not a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw unsafe('endpointUrl must use http or https');
  if (url.username || url.password) throw unsafe('endpointUrl must not contain credentials');

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');   // "localhost." is the same name as "localhost"
  if (allowPrivate) return { url: url.href, hostname: host, addresses: [] };

  if (host === 'localhost' || /\.(localhost|local|internal|localdomain|home|lan|svc|corp|intranet|private)$/.test(host)) throw unsafe('endpointUrl host is not allowed');
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    if (!host.includes('.')) throw unsafe('endpointUrl host must be a public domain name');
    try { addresses = (await resolve(host)).map((a) => a.address); } catch { throw unsafe('endpointUrl host could not be resolved'); }
    if (!addresses.length) throw unsafe('endpointUrl host could not be resolved');
  }
  if (addresses.some(isBlockedAddress)) throw unsafe('endpointUrl points to a private or reserved network address');
  return { url: url.href, hostname: host, addresses };
}
