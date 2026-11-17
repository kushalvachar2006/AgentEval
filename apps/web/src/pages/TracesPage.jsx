import { useCallback, useEffect, useState } from 'react';
import { api, fmtDuration, fmtTime } from '../api.js';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Pill, Select, Table, TableSkeleton, Tag, linkCls } from '../components/ui.jsx';

const EMPTY = { agentId: '', status: '', environment: '', version: '', from: '', to: '', minDurationMs: '', q: '', demo: '' };

export default function TracesPage({ query }) {
  const initial = new URLSearchParams(query || '');
  const [f, setF] = useState({ ...EMPTY, agentId: initial.get('agentId') || '', status: initial.get('status') || '' });
  const [applied, setApplied] = useState(f);
  const [more, setMore] = useState(false);
  const [agents, setAgents] = useState([]);
  const [items, setItems] = useState([]);
  const [next, setNext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => { api('/agents?limit=100').then((r) => setAgents(r.items)).catch(() => {}); }, []);
  useEffect(() => { const t = setTimeout(() => setApplied(f), 300); return () => clearTimeout(t); }, [f]);   // debounce typing

  const load = useCallback(async (cursor) => {
    setLoading(true); setError(null);
    const q = new URLSearchParams({ limit: '25' });
    for (const [k, v] of Object.entries(applied)) {
      if (!v) continue;
      if (k === 'from' || k === 'to') q.set(k, new Date(k === 'to' ? `${v}T23:59:59` : `${v}T00:00:00`).toISOString());
      else q.set(k, v);
    }
    if (cursor) q.set('cursor', cursor);
    try {
      const r = await api(`/traces?${q}`);
      setItems((p) => (cursor ? [...p, ...r.items] : r.items)); setNext(r.nextCursor);
    } catch (e) { setError(e); } finally { setLoading(false); }
  }, [applied]);
  useEffect(() => { load(); }, [load]);

  const name = (id) => agents.find((a) => a.id === id)?.name ?? id.slice(-6);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const activeMore = ['environment', 'version', 'from', 'to', 'minDurationMs', 'demo'].filter((k) => f[k]).length;
  const changed = JSON.stringify(f) !== JSON.stringify(EMPTY);
  const open = (e, id) => { if (!e.target.closest('a,button')) window.location.hash = `#/traces/${id}`; };

  return (
    <div className="space-y-6">
      <PageHeader title="Traces" description="Every execution your agents have run. Open one to see each step, or debug it to find what went wrong." />
      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr]">
          <Field label="Search the question or answer" hint="Last 30 days unless you set From."><Input type="search" value={f.q} onChange={set('q')} maxLength={100} placeholder="e.g. refund" /></Field>
          <Field label="Agent"><Select value={f.agentId} onChange={set('agentId')}><option value="">All agents</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          <Field label="Status"><Select value={f.status} onChange={set('status')}><option value="">Any</option><option value="success">success</option><option value="error">error</option><option value="cancelled">cancelled</option><option value="timeout">timeout</option></Select></Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" icon="filter" aria-expanded={more} onClick={() => setMore(!more)}>
            More filters{activeMore > 0 && <span className="ml-1 rounded-full bg-brand-soft px-1.5 text-xs font-semibold text-link">{activeMore}</span>}
          </Button>
          {changed && <Button variant="ghost" size="sm" onClick={() => setF(EMPTY)}>Reset filters</Button>}
        </div>
        {more && (
          <div className="mt-3 grid gap-3 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Environment"><Select value={f.environment} onChange={set('environment')}><option value="">Any</option><option value="production">production</option><option value="test">test</option><option value="evaluation">evaluation</option></Select></Field>
            <Field label="Version"><Input value={f.version} onChange={set('version')} placeholder="e.g. 1.1.0" maxLength={64} /></Field>
            <Field label="Slower than (ms)"><Input type="number" min={0} value={f.minDurationMs} onChange={set('minDurationMs')} /></Field>
            <Field label="From"><Input type="date" value={f.from} onChange={set('from')} /></Field>
            <Field label="To"><Input type="date" value={f.to} onChange={set('to')} /></Field>
            <Field label="Demo data"><Select value={f.demo} onChange={set('demo')}><option value="">Include</option><option value="false">Hide demo data</option><option value="true">Only demo data</option></Select></Field>
          </div>
        )}
      </Card>
      <ErrorBox error={error} />
      <Card flush title="Executions" action={<Button variant="secondary" size="sm" icon="refresh" onClick={() => load()}>Refresh</Button>}>
        {loading && !items.length ? <TableSkeleton cols={6} rows={8} /> : !items.length ? (
          <Empty icon="search" title="No traces match these filters">{changed ? 'Try removing a filter.' : 'Send traces with the Python SDK and they’ll appear here.'}</Empty>
        ) : (
          <Table>
            <thead><tr><th>Started</th><th>Agent</th><th>Status</th><th className="text-right">Duration</th><th className="text-right">LLM / tool</th><th className="text-right">Tokens</th><th>Question</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.traceId} className="cursor-pointer" onClick={(e) => open(e, t.traceId)}>
                  <td className="whitespace-nowrap"><a className={linkCls} href={`#/traces/${t.traceId}`}>{fmtTime(t.startedAt)}</a></td>
                  <td className="whitespace-nowrap">{name(t.agentId)}{t.agentVersion ? <span className="ml-1 text-xs text-muted">v{t.agentVersion}</span> : null}</td>
                  <td className="whitespace-nowrap"><Pill>{t.status}</Pill>{t.isDemo && <Tag tone="warning" className="ml-2">demo</Tag>}</td>
                  <td className="text-right">{fmtDuration(t.durationMs)}</td><td className="text-right">{t.llmCallCount} / {t.toolCallCount}</td><td className="text-right">{t.usage?.totalTokens ?? '—'}</td>
                  <td className="max-w-xs truncate text-muted">{t.inputPreview}</td>
                  <td className="text-right"><Button size="xs" variant="secondary" icon="bug" href={`#/debug/${t.traceId}`}>Debug</Button></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {next && <div className="border-t border-line p-3 text-center"><Button variant="ghost" size="sm" loading={loading} onClick={() => load(next)}>Load more</Button></div>}
      </Card>
    </div>
  );
}
