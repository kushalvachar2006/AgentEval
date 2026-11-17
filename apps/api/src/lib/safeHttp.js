// Outbound HTTP to USER-SUPPLIED endpoints (agents). Defences: SSRF guard on every call, DNS pinning (we connect to the
// exact address we validated, so DNS rebinding cannot swap in an internal IP), no redirects, response-size cap, hard deadline.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { assertSafeUrl } from './ssrf.js';
import { UpstreamError } from './upstream.js';

export function buildLookup(addresses) {
  const list = addresses.map((a) => ({ address: a, family: net.isIPv6(a) ? 6 : 4 }));
  return (_host, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (options?.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  };
}

export async function safeRequest(url, { method = 'POST', headers = {}, body, timeoutMs = 30_000, maxBytes = 2 * 1024 * 1024, allowPrivate = false, resolve, assertUrl = assertSafeUrl } = {}) {
  const { url: href, addresses } = await assertUrl(url, { allowPrivate, resolve });
  const u = new URL(href);
  const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const lib = u.protocol === 'https:' ? https : http;

  return new Promise((resolvePromise, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(deadline); fn(v); } };
    const req = lib.request({
      method,
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      headers: { ...headers, ...(payload && { 'content-length': payload.length }) },
      ...(addresses.length ? { lookup: buildLookup(addresses) } : {}),
      agent: false,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); finish(reject, new UpstreamError(`Agent response larger than ${maxBytes} bytes`, { retryable: false })); return; }
        chunks.push(c);
      });
      res.on('end', () => finish(resolvePromise, { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => finish(reject, new UpstreamError('Agent connection dropped', { retryable: true })));
    });
    const deadline = setTimeout(() => { req.destroy(); finish(reject, new UpstreamError('Agent endpoint timed out', { retryable: true })); }, timeoutMs);
    req.on('error', () => finish(reject, new UpstreamError('Could not reach the agent endpoint', { retryable: true })));
    if (payload) req.write(payload);
    req.end();
  });
}
