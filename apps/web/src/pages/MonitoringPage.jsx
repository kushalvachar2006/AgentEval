import { useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, fmtDuration, fmtTime } from '../api.js';
import { ChartTooltip, gridProps, legendProps, useChartTheme, xAxisProps, yAxisProps } from '../components/charts.jsx';
import { Button, Card, Checkbox, Empty, ErrorBox, Field, Input, PageHeader, Pill, Select, Skeleton, Stat, StatStrip, Switch, Table, TableSkeleton, linkCls } from '../components/ui.jsx';
import { useToast } from '../components/feedback.jsx';
import { ago, humanize, money, pct, usePolling } from '../hooks.js';

const WINDOWS = [[5, '5 min'], [15, '15 min'], [60, '1 hour'], [360, '6 hours'], [1440, '24 hours']];

function Controls({ windowMinutes, setWindowMinutes, live, setLive, updatedAt, reload }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={windowMinutes} onChange={(e) => setWindowMinutes(Number(e.target.value))} className="!w-32" aria-label="Time window">{WINDOWS.map(([v, l]) => <option key={v} value={v}>Last {l}</option>)}</Select>
      <Checkbox checked={live} onChange={(e) => setLive(e.target.checked)}>Auto-refresh (10 s)</Checkbox>
      <Button variant="secondary" size="sm" icon="refresh" onClick={reload}>Refresh now</Button>
      {updatedAt && <span className="text-xs text-muted">Updated {updatedAt.toLocaleTimeString()}</span>}
    </div>
  );
}

function Overview({ windowMinutes, setWindowMinutes }) {
  const [live, setLive] = useState(true);
  const { data, error, loading, updatedAt, reload } = usePolling(() => api(`/monitoring/overview?windowMinutes=${windowMinutes}`), 10_000, { enabled: live, deps: [windowMinutes] });
  return (
    <div className="space-y-6">
      <PageHeader title="Live monitoring" description="Production traffic only (demo traces excluded). Health is a simple, explained rule of thumb. Use alert rules for precise thresholds.">
        <Controls {...{ windowMinutes, setWindowMinutes, live, setLive, updatedAt, reload }} />
      </PageHeader>
      <ErrorBox error={error} />
      <Card flush>
        {loading && !data ? <TableSkeleton cols={6} /> : data && (data.agents.length === 0 ? (
          <Empty icon="monitoring" title="No agents yet" action={<Button href="#/agents">Register an agent</Button>}>Register an agent and send production traces to see them here.</Empty>
        ) : (
          <>
            <Table>
              <thead><tr><th>Agent</th><th>Health</th><th className="text-right">Traces</th><th className="text-right">Error rate</th><th className="text-right">Avg latency</th><th>Last trace</th><th>Sampling</th></tr></thead>
              <tbody>
                {data.agents.map((a) => (
                  <tr key={a.id} className="align-top">
                    <td><a className={linkCls} href={`#/monitoring/${a.id}?windowMinutes=${windowMinutes}`}>{a.name}</a><div className="text-xs text-muted">v{a.currentVersion}</div></td>
                    <td><Pill>{a.health.status}</Pill><div className="mt-1 max-w-sm text-xs text-muted">{a.health.reasons[0]}</div></td>
                    <td className="text-right">{a.current.count}</td><td className="text-right">{pct(a.current.errorRate)}</td><td className="text-right">{fmtDuration(a.current.avgLatencyMs)}</td>
                    <td className="whitespace-nowrap text-muted">{ago(a.lastTraceAt)}</td>
                    <td className="whitespace-nowrap text-muted">{a.monitoring.enabled ? `${Math.round(a.monitoring.sampleRate * 100)}% + errors` : 'Off'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {data.truncated && <p className="border-t border-line px-5 py-3 text-xs text-muted">Showing the 50 newest agents.</p>}
          </>
        ))}
      </Card>
    </div>
  );
}

function PolicyEditor({ agentId, policy, usage, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState({ enabled: policy.enabled, rate: Math.round(policy.sampleRate * 100), errors: policy.alwaysEvaluateErrors, traceBudget: policy.dailyTraceBudget ?? '', judge: policy.useJudge, judgeBudget: policy.dailyJudgeBudget ?? '', constraints: policy.constraints ? JSON.stringify(policy.constraints) : '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setError(null);
    let constraints = null;
    try { constraints = f.constraints.trim() ? JSON.parse(f.constraints) : null; } catch { setError({ message: 'Constraints must be valid JSON, e.g. {"maxChars": 500}' }); return; }
    const evaluators = policy.evaluators.filter((m) => m !== 'instruction_adherence');
    if (constraints) evaluators.push('instruction_adherence');
    setBusy(true);
    try {
      await api(`/agents/${agentId}/monitoring`, { method: 'PUT', body: { enabled: f.enabled, sampleRate: Number(f.rate) / 100, alwaysEvaluateErrors: f.errors, dailyTraceBudget: f.traceBudget === '' ? null : Number(f.traceBudget), useJudge: f.judge, dailyJudgeBudget: f.judgeBudget === '' ? null : Number(f.judgeBudget), constraints, evaluators } });
      toast('Monitoring policy saved'); onSaved();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Card title="Sampling and cost controls" description="Sampled production traces are evaluated in the background with reference-free checks (hallucination and groundedness against recorded tool output, relevance, tool use, operational). Your agent is never called. Only admins can change this.">
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        <Switch checked={f.enabled} onChange={set('enabled')} label="Evaluate production traces" />
        <Switch checked={f.errors} onChange={set('errors')} label="Always evaluate failed executions" />
        <Field label="Share of traces to evaluate (%)"><Input type="number" min="0" max="100" value={f.rate} onChange={set('rate')} /></Field>
        <Field label="Daily evaluation budget (traces)" hint="Leave empty for unlimited."><Input type="number" min="0" value={f.traceBudget} onChange={set('traceBudget')} /></Field>
        <Switch checked={f.judge} onChange={set('judge')} label="Also use the AI judge" description="Needs a daily cap." />
        <Field label="Daily AI-judge calls (cap)"><Input type="number" min="0" value={f.judgeBudget} onChange={set('judgeBudget')} /></Field>
        <div className="sm:col-span-2"><Field label="Output constraints (optional JSON)" hint={'Enables instruction_adherence, e.g. {"maxChars": 500, "mustNotInclude": ["password"]}'}><Input value={f.constraints} onChange={set('constraints')} className="font-mono text-xs" /></Field></div>
      </div>
      <div className="mt-5"><ErrorBox error={error} /></div>
      <div className="mt-5 flex items-center gap-3"><Button onClick={save} loading={busy}>Save policy</Button></div>
      <dl className="mt-5 grid gap-4 border-t border-line pt-4 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-muted">Today (UTC)</dt><dd className="mt-0.5 font-medium">{usage.day}</dd></div>
        <div><dt className="text-xs text-muted">Evaluations queued</dt><dd className="mt-0.5 font-medium tabular-nums">{usage.evaluationsQueued}{usage.dailyTraceBudget !== null ? ` / ${usage.dailyTraceBudget}` : ''}</dd></div>
        <div><dt className="text-xs text-muted">Skipped (budget reached)</dt><dd className="mt-0.5 font-medium tabular-nums">{usage.skippedBudget}</dd></div>
        <div><dt className="text-xs text-muted">AI-judge calls</dt><dd className="mt-0.5 font-medium tabular-nums">{usage.judgeCalls}{usage.dailyJudgeBudget !== null ? ` / ${usage.dailyJudgeBudget}` : ''}</dd></div>
      </dl>
    </Card>
  );
}

function AgentLive({ id, windowMinutes, setWindowMinutes }) {
  const t = useChartTheme();
  const [live, setLive] = useState(true);
  const { data: d, error, loading, updatedAt, reload } = usePolling(() => api(`/monitoring/agents/${id}/live?windowMinutes=${windowMinutes}`), 10_000, { enabled: live, deps: [id, windowMinutes] });
  if (loading && !d) return <div role="status" aria-label="Loading" className="space-y-4"><Skeleton className="h-16" /><Skeleton className="h-24" /><Skeleton className="h-72" /></div>;
  if (!d) return <div className="space-y-4"><ErrorBox error={error} /><Button variant="secondary" href="#/monitoring" icon="arrow-left">All agents</Button></div>;
  const series = d.series.map((b) => ({ ...b, t: new Date(b.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), ok: b.count - b.errors }));
  const c = d.current; const q = d.quality;
  return (
    <div className="space-y-6">
      <PageHeader breadcrumbs={[['Monitoring', '#/monitoring'], [d.agent.name]]} title={<>{d.agent.name} <span className="text-lg font-normal text-muted">v{d.agent.currentVersion}</span></>}>
        <Controls {...{ windowMinutes, setWindowMinutes, live, setLive, updatedAt, reload }} />
      </PageHeader>
      <ErrorBox error={error} />
      <Card>
        <div className="flex flex-wrap items-start gap-4"><Pill>{d.health.status}</Pill><ul className="space-y-1 text-sm">{d.health.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
      </Card>
      {d.openAlerts.length > 0 && (
        <Card flush title="Open alerts">
          <ul className="divide-y divide-line">{d.openAlerts.map((a) => <li key={a.id}><a href={`#/alerts/${a.id}`} className="flex items-start gap-3 px-5 py-3 text-sm hover:bg-sunken/50"><Pill>{a.severity}</Pill><span><span className="font-medium">{a.ruleName}</span> <span className="text-muted">{a.explanation}</span></span></a></li>)}</ul>
        </Card>
      )}
      <StatStrip>
        <Stat label="Traces" value={c.count} hint={`Previous window: ${d.previous.count}`} />
        <Stat label="Error rate" value={pct(c.errorRate)} hint={`${c.errors} errors`} />
        <Stat compact label="Latency avg / p95" value={`${fmtDuration(c.avgLatencyMs)} / ${fmtDuration(c.p95LatencyMs)}`} hint={c.p95Exact ? undefined : 'p95 estimated from newest traces'} />
        <Stat label="Tokens" value={c.totalTokens.toLocaleString()} />
        <Stat label="Cost" value={money(c.costUsd)} hint={c.costCoverage === null ? undefined : `Reported by ${pct(c.costCoverage)} of traces`} />
      </StatStrip>
      <Card title={`Traffic per ${d.window.binMinutes} min`}>
        {series.length === 0 ? <Empty icon="monitoring" title="No production traces in this window" /> : (
          <div className="h-64">
            <ResponsiveContainer>
              <ComposedChart data={series} margin={{ top: 5, right: 0, bottom: 0, left: 0 }}>
                <CartesianGrid {...gridProps(t)} /><XAxis dataKey="t" {...xAxisProps(t)} /><YAxis yAxisId="n" allowDecimals={false} {...yAxisProps(t)} /><YAxis yAxisId="ms" orientation="right" unit=" ms" {...yAxisProps(t)} width={64} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: t.cursor }} /><Legend {...legendProps(t)} />
                <Bar yAxisId="n" dataKey="ok" stackId="a" name="OK" fill={t.success} isAnimationActive={false} /><Bar yAxisId="n" dataKey="errors" stackId="a" name="Errors" fill={t.danger} isAnimationActive={false} />
                <Line yAxisId="ms" type="monotone" dataKey="avgLatencyMs" name="Avg latency" stroke={t.series[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card flush title="Failed executions (last 24 h)" action={<a className={`${linkCls} text-sm`} href={`#/traces?agentId=${id}&status=error`}>All errors</a>}>
          {d.failedExecutions.length === 0 ? <Empty icon="check-circle" title="No failed executions" /> : (
            <ul className="divide-y divide-line text-sm">{d.failedExecutions.map((x) => (
              <li key={x.traceId} className="flex items-center justify-between gap-3 px-5 py-3">
                <span className="min-w-0"><Pill>{x.status}</Pill><span className="ml-2 truncate text-muted">{x.inputPreview}</span><span className="mt-1 block text-xs text-muted">{fmtTime(x.startedAt)}</span></span>
                <span className="flex shrink-0 gap-3 text-xs"><a className={linkCls} href={`#/traces/${x.traceId}`}>Trace</a><a className={linkCls} href={`#/debug/${x.traceId}`}>Debug</a></span>
              </li>))}
            </ul>
          )}
        </Card>
        <Card flush title="Incoming traces">
          {d.recentTraces.length === 0 ? <Empty icon="inbox" title="Nothing in this window" /> : (
            <ul className="divide-y divide-line text-sm">{d.recentTraces.map((x) => (
              <li key={x.traceId} className="flex items-center justify-between gap-3 px-5 py-3">
                <span className="min-w-0 truncate"><Pill>{x.status}</Pill><span className="ml-2 text-muted">{x.inputPreview}</span></span>
                <span className="shrink-0 text-xs text-muted">{fmtDuration(x.durationMs)}<a className={`${linkCls} ml-3`} href={`#/traces/${x.traceId}`}>Open</a></span>
              </li>))}
            </ul>
          )}
        </Card>
      </div>
      <Card title={`Quality of evaluated production traces (last ${q.windowHours} h)`}>
        {q.evaluated === 0 ? <Empty icon="shield" title="No production traces evaluated yet">Turn on sampling below, and make sure the worker is running.</Empty> : (
          <>
            <p className="mb-4 text-sm text-muted">{q.evaluated} evaluated, {q.passed} passed, {q.failed} failed, {q.inconclusive} inconclusive{q.passRate !== null ? `. Pass rate ${pct(q.passRate)} (inconclusive excluded)` : ''}. This is a sample, not every trace.</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {Object.entries(q.metrics).map(([m, v]) => (
                <div key={m} className="rounded-lg border border-line p-3.5 text-sm">
                  <p className="font-medium">{humanize(m)}</p>
                  <p className="mt-1 tabular-nums">Avg score {v.avgScore ?? '—'} <span className="text-xs text-muted">({v.n} scored)</span></p>
                  <p className="mt-0.5 text-xs text-muted">{v.pass} pass, {v.fail} fail, {v.inconclusive} inconclusive</p>
                </div>
              ))}
            </div>
            <ul className="mt-4 divide-y divide-line text-sm">{q.recent.map((r) => <li key={r.traceId} className="flex items-center justify-between gap-3 py-2"><span className="min-w-0 truncate"><Pill>{r.status}</Pill><span className="ml-2 text-muted">{r.inputPreview}</span></span><a className={`${linkCls} shrink-0 text-xs`} href={`#/debug/${r.traceId}`}>Debug</a></li>)}</ul>
          </>
        )}
      </Card>
      <PolicyEditor key={JSON.stringify(d.policy)} agentId={id} policy={d.policy} usage={d.usage} onSaved={reload} />
    </div>
  );
}

export default function MonitoringPage({ id, query }) {
  const initial = Number(new URLSearchParams(query || '').get('windowMinutes'));
  const [windowMinutes, setWindowMinutes] = useState(WINDOWS.some(([v]) => v === initial) ? initial : 15);
  return id ? <AgentLive id={id} windowMinutes={windowMinutes} setWindowMinutes={setWindowMinutes} /> : <Overview windowMinutes={windowMinutes} setWindowMinutes={setWindowMinutes} />;
}
