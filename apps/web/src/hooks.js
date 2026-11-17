import { useCallback, useEffect, useRef, useState } from 'react';

// Polls `fn` every `ms` while the tab is visible and `enabled` is true. Returns the latest data, error, and a manual reload.
// Overlapping requests are never started; a slow response simply delays the next poll.
export function usePolling(fn, ms, { enabled = true, deps = [] } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const busy = useRef(false);
  const run = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try { setData(await fn()); setError(null); setUpdatedAt(new Date()); } catch (e) { setError(e); } finally { busy.current = false; setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { setLoading(true); run(); }, [run]);
  useEffect(() => {
    if (!enabled) return undefined;
    const t = setInterval(() => { if (!document.hidden) run(); }, ms);
    return () => clearInterval(t);
  }, [enabled, ms, run]);
  return { data, error, loading, updatedAt, reload: run };
}

export const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
export const money = (x) => (x === null || x === undefined ? '—' : `$${x < 1 ? x.toFixed(4) : x.toFixed(2)}`);
export const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

// 'awaiting_traces' -> 'Awaiting traces'. Display only; never use the result as a key.
export const humanize = (s) => { const t = String(s ?? '').replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
