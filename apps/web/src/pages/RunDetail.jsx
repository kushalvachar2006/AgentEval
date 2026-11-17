import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, fmtDuration, fmtTime } from '../api.js';
import Icon from '../components/Icon.jsx';
import { useConfirm } from '../components/feedback.jsx';
import { Button, Card, Code, CopyButton, Empty, ErrorBox, Meta, Notice, PageHeader, Pill, SegmentedBar, Select, Skeleton, Stat, StatStrip, Table, Tag, cx, linkCls } from '../components/ui.jsx';
import { humanize } from '../hooks.js';

const ACTIVE = ['queued', 'awaiting_traces', 'running'];
const pct = (n) => (n == null ? '—' : `${Math.round(n * 100)}%`);

function Finding({ f }) {
  if (f.classification) {
    const tone = f.classification === 'supported' ? 'success' : f.classification === 'contradicted' ? 'danger' : 'warning';
    return (
      <li className="rounded-md bg-sunken p-2.5">
        <Pill tone={tone}>{f.classification}</Pill> <span className="ml-1">“{f.claim}”</span>
        {f.reason && <span className="text-muted"> {f.reason}</span>}
        {f.evidence?.[0]?.text && <div className="mt-1.5 text-xs text-muted">Evidence ({f.evidence[0].source}): {f.evidence[0].text}</div>}
        {f.evidence?.[0]?.spanId && <div className="text-xs text-muted">Step id: <code>{f.evidence[0].spanId}</code></div>}
      </li>
    );
  }
  return <li className="rounded-md bg-sunken p-2.5 text-xs"><code>{JSON.stringify(f)}</code></li>;
}

function ResultRow({ r }) {
  const [open, setOpen] = useState(false);
  return (
    <Fragment>
      <tr className="cursor-pointer" onClick={() => setOpen(!open)}>
        <td><Pill>{r.status}</Pill></td>
        <td className="max-w-xs truncate">{r.inputPreview}</td>
        <td className="max-w-xs truncate text-muted">{r.outputPreview ?? r.error}</td>
        <td className="text-right">{fmtDuration(r.latencyMs)}</td>
        <td className="text-right">
          <button type="button" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} details`} onClick={(e) => { e.stopPropagation(); setOpen(!open); }} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs font-medium text-link hover:bg-brand-soft">
            Details <Icon name="chevron-down" size={13} className={cx('transition-transform', open && 'rotate-180')} />
          </button>
        </td>
      </tr>
      {open && (
        <tr className="!bg-sunken/40 hover:!bg-sunken/40">
          <td colSpan={5} className="!px-5 !pb-5">
            {r.error && <p className="mb-3 text-sm text-danger-fg">{r.error}</p>}
            <div className="space-y-3">
              {r.metrics.map((m) => (
                <div key={m.metric} className="rounded-lg border border-line bg-surface p-3.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{humanize(m.metric)}</strong> <Pill>{m.status}</Pill>
                    <span className="text-xs text-muted">Score {m.score ?? '—'}, confidence {m.confidence ?? '—'}, passes at {m.threshold ?? '—'} or above, evaluator v{m.evaluatorVersion}</span>
                  </div>
                  <p className="mt-1.5">{m.explanation}</p>
                  {m.findings?.length > 0 && <ul className="mt-2.5 space-y-1.5">{m.findings.slice(0, 12).map((f, i) => <Finding key={i} f={f} />)}</ul>}
                </div>
              ))}
              {r.traceId && <p className="text-sm"><a className={linkCls} href={`#/debug/${r.traceId}`}>Why did it go wrong? Debug this trace</a><span className="mx-2 text-faint">|</span><a className={linkCls} href={`#/traces/${r.traceId}`}>Full execution trace</a></p>}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export default function RunDetail({ id }) {
  const confirm = useConfirm();
  const [run, setRun] = useState(null);
  const [results, setResults] = useState([]);
  const [next, setNext] = useState(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);

  const loadRun = useCallback(async () => { try { setRun(await api(`/evaluations/${id}`)); } catch (e) { setError(e); } }, [id]);
  const loadResults = useCallback(async (cursor) => {
    try {
      const q = new URLSearchParams({ limit: '25', ...(filter && { status: filter }), ...(cursor && { cursor }) });
      const r = await api(`/evaluations/${id}/results?${q}`);
      setResults((p) => (cursor ? [...p, ...r.items] : r.items)); setNext(r.nextCursor);
    } catch (e) { setError(e); }
  }, [id, filter]);

  useEffect(() => { loadRun(); }, [loadRun]);
  useEffect(() => { loadResults(); }, [loadResults]);
  const active = run && ACTIVE.includes(run.status);
  useEffect(() => {   // progress updates: poll every 2 s while the run is active, plus one last refresh when it ends
    if (!active) return undefined;
    const t = setInterval(() => { loadRun(); loadResults(); }, 2000);
    return () => clearInterval(t);
  }, [active, loadRun, loadResults]);
  useEffect(() => { if (run && !active) loadResults(); }, [run?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function cancel() {
    if (!(await confirm({ title: 'Cancel this run?', description: 'Cases already evaluated are kept.', confirmLabel: 'Cancel run', danger: true }))) return;
    try { setRun(await api(`/evaluations/${id}/cancel`, { method: 'POST' })); } catch (e) { setError(e); }
  }

  if (!run) return error ? <div className="space-y-4"><ErrorBox error={error} /><Button variant="secondary" href="#/runs" icon="arrow-left">Back to evaluations</Button></div> : <div role="status" aria-label="Loading run" className="space-y-4"><Skeleton className="h-16" /><Skeleton className="h-32" /></div>;
  const p = run.progress;
  const snippet = `export AGENTEVAL_API_KEY=<a key with "evaluation runs" allowed>\nexport AGENTEVAL_RUN_ID=${run.id}\npython sdk/python/examples/evaluation_demo.py`;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[['Evaluations', '#/runs'], [run.name]]} title={run.name} badge={<Pill>{run.status}</Pill>}
        actions={active && <Button variant="danger" onClick={cancel}>Cancel run</Button>}
      >
        <Meta><span>{run.mode === 'sdk' ? 'Run by your own code (SDK)' : 'Agent called by AgentEval'}</span><span>Started {fmtTime(run.createdAt)}</span>{run.useJudge && <span>AI judge on</span>}</Meta>
      </PageHeader>
      <ErrorBox error={error} />

      <Card title="Progress">
        <SegmentedBar
          className="h-3" total={p.total} label={`${p.completed} of ${p.total} cases evaluated`}
          segments={[{ value: p.passed, tone: 'success' }, { value: p.failed, tone: 'danger' }, { value: p.inconclusive, tone: 'warning' }, { value: p.error, tone: 'neutral' }]}
        />
        <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <span className="font-medium">{p.completed} of {p.total} cases evaluated</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-success-dot" />{p.passed} passed</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-danger-dot" />{p.failed} failed</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-warning-dot" />{p.inconclusive} inconclusive</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-line-strong" />{p.error} error</span>
        </p>
        {run.status === 'awaiting_traces' && p.completed === 0 && (
          <Notice tone="info" title="Waiting for your agent. Run it on your machine:" className="mt-4">
            <div className="mt-2"><Code wrap={false}>{snippet}</Code></div>
            <div className="mt-2 flex flex-wrap items-center gap-3"><CopyButton text={snippet} label="Copy commands" /><span className="text-xs text-muted">Deadline: {fmtTime(run.awaitDeadline)}. Cases without a trace by then are marked as errors.</span></div>
          </Notice>
        )}
      </Card>

      {run.summary && (
        <>
          <StatStrip className="grid-cols-2 lg:grid-cols-4">
            <Stat label="Pass rate" value={pct(run.summary.passRate)} />
            <Stat label="Avg latency" value={fmtDuration(run.summary.latencyMs.avg)} />
            <Stat label="Tokens" value={run.summary.tokens ? run.summary.tokens.toLocaleString() : "—"} />
            <Stat label="Judge calls" value={run.summary.judgeCalls} />
          </StatStrip>
          <Card flush title="Results by metric">
            <Table>
              <thead><tr><th>Metric</th><th className="w-48">Outcome</th><th className="text-right">Pass</th><th className="text-right">Fail</th><th className="text-right">Inconclusive</th><th className="text-right">Avg score</th><th className="text-right">Avg confidence</th></tr></thead>
              <tbody>
                {Object.entries(run.summary.metrics).map(([m, s]) => (
                  <tr key={m}>
                    <td className="font-medium">{humanize(m)}</td>
                    <td><SegmentedBar label={`${s.pass} pass, ${s.fail} fail, ${s.inconclusive} inconclusive`} segments={[{ value: s.pass, tone: 'success' }, { value: s.fail, tone: 'danger' }, { value: s.inconclusive, tone: 'warning' }]} /></td>
                    <td className="text-right">{s.pass}</td><td className="text-right">{s.fail}</td><td className="text-right">{s.inconclusive}</td><td className="text-right">{s.avgScore ?? '—'}</td><td className="text-right">{s.avgConfidence ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="border-t border-line px-5 py-3 text-xs text-muted">“Inconclusive” means the evaluator was not confident enough, or lacked the data, to pass or fail. It is never counted as a pass.</p>
          </Card>
        </>
      )}

      <Card
        flush title="Results by test case"
        action={<Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter results" className="!w-40"><option value="">All results</option><option value="passed">passed</option><option value="failed">failed</option><option value="inconclusive">inconclusive</option><option value="error">error</option></Select>}
      >
        {!results.length ? <Empty icon="runs" title="No results yet">{active ? 'Results appear here as each case is evaluated.' : 'Nothing matches this filter.'}</Empty> : (
          <Table>
            <thead><tr><th>Status</th><th>Input</th><th>Agent answer</th><th className="text-right">Latency</th><th><span className="sr-only">Details</span></th></tr></thead>
            <tbody>{results.map((r) => <ResultRow key={r.id} r={r} />)}</tbody>
          </Table>
        )}
        {next && <div className="border-t border-line p-3 text-center"><Button variant="ghost" size="sm" onClick={() => loadResults(next)}>Load more</Button></div>}
      </Card>
    </div>
  );
}
