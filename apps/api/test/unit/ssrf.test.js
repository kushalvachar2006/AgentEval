import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeUrl, isBlockedIPv4, isBlockedIPv6, ipv6ToBigInt } from '../../src/lib/ssrf.js';

const pub = async () => [{ address: '93.184.216.34', family: 4 }];
const rejects = (url, opts = {}) => assert.rejects(() => assertSafeUrl(url, { resolve: pub, ...opts }), (e) => ['UNSAFE_ENDPOINT', 'INVALID_URL'].includes(e.code), url);

test('blocks private/reserved IPv4', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '198.18.0.1'])
    assert.equal(isBlockedIPv4(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255']) assert.equal(isBlockedIPv4(ip), false, ip);
});

test('blocks private/reserved IPv6 incl. mapped and NAT64', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::1', '::127.0.0.1'])
    assert.equal(isBlockedIPv6(ip), true, ip);
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) assert.equal(isBlockedIPv6(ip), false, ip);
  assert.equal(ipv6ToBigInt('1::'), 1n << 112n);
  assert.equal(ipv6ToBigInt('1:2:3'), null);
});

test('rejects bad schemes, credentials, localhost names, and IP literal tricks', async () => {
  await rejects('ftp://example.com');
  await rejects('file:///etc/passwd');
  await rejects('not a url');
  await rejects('http://user:pw@example.com');
  await rejects('http://localhost:8080');
  await rejects('http://foo.localhost');
  await rejects('http://metadata.internal/latest');
  await rejects('http://intranet/');
  await rejects('http://127.0.0.1/');
  await rejects('http://2130706433/');         // decimal form of 127.0.0.1
  await rejects('http://0x7f.0.0.1/');         // hex form
  await rejects('http://127.1/');              // short form
  await rejects('http://169.254.169.254/latest/meta-data');
  await rejects('http://[::1]/');
  await rejects('http://[::ffff:127.0.0.1]/');
});

test('rejects hostnames that resolve to a private address, even if only one of several does', async () => {
  await rejects('https://rebind.example.com', { resolve: async () => [{ address: '10.0.0.5', family: 4 }] });
  await rejects('https://mixed.example.com', { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await rejects('https://nxdomain.example.com', { resolve: async () => { throw new Error('ENOTFOUND'); } });
  await rejects('https://empty.example.com', { resolve: async () => [] });
});

test('accepts public hosts and returns addresses for pinning', async () => {
  const r = await assertSafeUrl('https://agent.example.com/run', { resolve: pub });
  assert.deepEqual(r.addresses, ['93.184.216.34']);
  const ip = await assertSafeUrl('http://8.8.8.8:8080/x', { resolve: pub });
  assert.equal(ip.hostname, '8.8.8.8');
});

test('allowPrivate (self-hosted opt-in) skips network checks but still blocks credentials/schemes', async () => {
  assert.ok(await assertSafeUrl('http://localhost:9000', { allowPrivate: true }));
  await rejects('http://user:pw@localhost', { allowPrivate: true });
  await rejects('gopher://localhost', { allowPrivate: true });
});
