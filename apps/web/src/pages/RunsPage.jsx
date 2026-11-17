import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../components/Dialog.jsx';
import { Button, Card, Checkbox, Empty, ErrorBox, Field, Input, PageHeader, Pill, RelTime, SegmentedBar, Select, Table, TableSkeleton, linkCls } from '../components/ui.jsx';

export default function RunsPage() {
  const [agents, setAgents] = useState([]);
  const [suites, setSuites] = useState([]);
  const [judge, setJudge] = useState(null);
  const [runs, setRuns] = useState(null);
  const [next, setNext] = useState(null);
  const [form, setForm] = useState({ agentId: '', suiteId: '', mode: 'sdk', useJudge: false, maxJudgeCalls: 100 });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const loadRuns = useCallback(async (cursor) => {
    try {
      const r = await api(`/evaluations?limit=15${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      setRuns((p) => (cursor ? [...(p ?? []), ...r.items] : r.items)); setNext(r.nextCursor);
    } catch (e) { setError(e); setRuns((p) => p ?? []); }
  }, []);
  useEffect(() => {
    loadRuns();
    api('/agents?limit=100').then((r) => { setAgents(r.items); setForm((f) => ({ ...f, agentId: f.agentId || r.items[0]?.id || '' })); }).catch(setError);
    api('/test-suites?limit=100').then((r) => { setSuites(r.items); setForm((f) => ({ ...f, suiteId: f.suiteId || r.items[0]?.id || '' })); }).catch(setError);
    api('/evaluator-config').then((r) => setJudge(r.judge)).catch(() => {});
  }, [loadRuns]);

  const agent = agents.find((a) => a.id === form.agentId);
  const endpointOk = agent?.integrationType === 'api';
  const ready = agents.length > 0 && suites.length > 0;

  async function start(e) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const body = { agentId: form.agentId, suiteId: form.suiteId, mode: form.mode, useJudge: form.useJudge, limits: { maxJudgeCalls: Number(form.maxJudgeCalls) } };
      const r = await api('/evaluations', { method: 'POST', body });
      window.location.hash = `#/runs/${r.id}`;
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Evaluations" description="Run a test suite against an agent and see which answers pass, fail or can’t be judged." actions={<Button icon="play" onClick={() => { setError(null); setOpen(true); }}>New evaluation</Button>} />
      {!open && <ErrorBox error={error} />}
      <Card flush title="Evaluation runs" action={<Button variant="secondary" size="sm" icon="refresh" onClick={() => loadRuns()}>Refresh</Button>}>
        {runs === null ? <TableSkeleton cols={5} /> : !runs.length ? (
          <Empty icon="runs" title="No evaluations yet" action={<Button icon="play" onClick={() => setOpen(true)}>Start an evaluation</Button>}>Pick an agent and a test suite. Metrics are chosen from what your test cases contain.</Empty>
        ) : (
          <Table>
            <thead><tr><th>Run</th><th>Status</th><th>Progress</th><th className="text-right">Pass rate</th><th>Started</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><a className={linkCls} href={`#/runs/${r.id}`}>{r.name}</a></td>
                  <td><Pill>{r.status}</Pill></td>
                  <td><div className="flex items-center gap-3"><SegmentedBar className="w-28" label={`${r.progress.completed} of ${r.progress.total} cases`} segments={[{ value: r.progress.completed, tone: 'brand' }]} total={r.progress.total} /><span className="text-xs text-muted">{r.progress.completed}/{r.progress.total}</span></div></td>
                  <td className="text-right">{r.summary?.passRate != null ? `${Math.round(r.summary.passRate * 100)}%` : '—'}</td>
                  <td className="text-muted"><RelTime iso={r.createdAt} /></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {next && <div className="border-t border-line p-3 text-center"><Button variant="ghost" size="sm" onClick={() => loadRuns(next)}>Load more</Button></div>}
      </Card>

      <Dialog
        open={open} onClose={() => setOpen(false)} onSubmit={ready ? start : undefined} title="Start an evaluation" description="Metrics are chosen automatically from what your test cases contain."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>{ready && <Button type="submit" loading={busy}>{busy ? 'Starting…' : 'Start evaluation'}</Button>}</>}
      >
        {!ready ? (
          <Empty icon="runs" title="You need an agent and a test suite first">Create an <a className={linkCls} href="#/agents">agent</a> and a <a className={linkCls} href="#/suites">test suite</a>, then come back.</Empty>
        ) : (
          <div className="space-y-4">
            <ErrorBox error={error} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Agent"><Select value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
              <Field label="Test suite"><Select value={form.suiteId} onChange={(e) => setForm({ ...form, suiteId: e.target.value })}>{suites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.caseCount})</option>)}</Select></Field>
            </div>
            <Field label="Who runs the agent?">
              <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                <option value="sdk">My own code (Python SDK)</option>
                <option value="endpoint" disabled={!endpointOk}>AgentEval calls the agent’s HTTP endpoint{endpointOk ? '' : ' (agent has none)'}</option>
              </Select>
            </Field>
            <div className="rounded-lg border border-line p-3.5">
              <Checkbox checked={form.useJudge} disabled={!judge?.enabled} onChange={(e) => setForm({ ...form, useJudge: e.target.checked })}>Use the AI judge for fuzzy checks</Checkbox>
              {!judge?.enabled && <p className="mt-1.5 text-xs text-muted">Not configured. Set one up under <a className={linkCls} href="#/settings">Evaluators</a>.</p>}
              {form.useJudge && <Field label="Max judge calls" className="mt-3"><Input type="number" min={0} max={5000} value={form.maxJudgeCalls} onChange={(e) => setForm({ ...form, maxJudgeCalls: e.target.value })} className="!w-32" /></Field>}
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
