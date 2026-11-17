import { UpstreamError } from './upstream.js';

// Talks to the Python evaluation engine (internal network only, shared-secret header).
export function createEngineClient({ url, token, timeoutMs = 60_000, fetchImpl = fetch }) {
  async function call(path, init) {
    let res;
    try {
      res = await fetchImpl(`${url}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-engine-token': token }, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new UpstreamError('Evaluation engine is unreachable', { retryable: true });
    }
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
      let detail = '';
      try { detail = JSON.parse(text).error ?? ''; } catch { /* not JSON */ }
      throw new UpstreamError(`Evaluation engine returned ${res.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`, { retryable, status: res.status });
    }
    try { return JSON.parse(text); } catch { throw new UpstreamError('Evaluation engine returned invalid JSON', { retryable: true }); }
  }
  return {
    evaluate: (payload) => call('/v1/evaluate', { method: 'POST', body: JSON.stringify(payload) }),
    debug: (payload) => call('/v1/debug', { method: 'POST', body: JSON.stringify(payload) }),
    catalog: () => call('/v1/evaluators', { method: 'GET' }),
  };
}
