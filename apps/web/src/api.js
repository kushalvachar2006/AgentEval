// Session lives in sessionStorage (cleared when the tab closes). Tokens are never put in URLs.
const KEY = 'agenteval.session';
export const session = {
  get() { try { return JSON.parse(sessionStorage.getItem(KEY)); } catch { return null; } },
  set(v) { sessionStorage.setItem(KEY, JSON.stringify(v)); },
  clear() { sessionStorage.removeItem(KEY); },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

// One refresh at a time: parallel 401s share the same refresh request (the server rotates the token on every use).
let refreshing = null;
async function refreshSession() {
  const s = session.get();
  if (!s?.refreshToken) return false;
  refreshing ??= fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: s.refreshToken }) })
    .then(async (r) => { if (!r.ok) return false; const d = await r.json(); session.set({ ...session.get(), token: d.token, refreshToken: d.refreshToken }); return true; })
    .catch(() => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api(path, { method = 'GET', body, auth = true } = {}, retried = false) {
  const s = auth ? session.get() : null;
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(s?.token && { Authorization: `Bearer ${s.token}` }),
      ...(s?.organizationId && { 'X-Organization-Id': s.organizationId }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (res.status === 401 && s && data?.error?.code === 'INVALID_TOKEN' && !retried && (await refreshSession())) return api(path, { method, body, auth }, true);
  if (res.status === 401 && s && ['INVALID_TOKEN', 'UNAUTHENTICATED'].includes(data?.error?.code)) { session.clear(); window.dispatchEvent(new Event('agenteval:logout')); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// Ends this session on the server (the token stops working immediately), then clears it locally.
export async function signOut({ everywhere = false } = {}) {
  try { await api(everywhere ? '/auth/logout-all' : '/auth/logout', { method: 'POST' }); } catch { /* already invalid: fine */ }
  session.clear();
  window.dispatchEvent(new Event('agenteval:logout'));
}

export const fmtDuration = (ms) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
