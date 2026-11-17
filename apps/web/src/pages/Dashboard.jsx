import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, fmtDuration, fmtTime } from '../api.js';
import { ChartTooltip, gridProps, legendProps, useChartTheme, xAxisProps, yAxisProps } from '../components/charts.jsx';
import { Button, Card, Checkbox, Empty, ErrorBox, Field, Notice, PageHeader, Pill, Select, Skeleton, Stat, StatStrip, Table, Tag, linkCls } from '../components/ui.jsx';
import { humanize } from '../hooks.js';

const METRICS = ['accuracy', 'hallucination', 'groundedness', 'relevance', 'completeness', 'tool_usage', 'instruction_adherence', 'operational'];
const DEFAULTS = { agentId: '', version: '', environment: '', status: '', metric: '', range: '30', hideDemo: false };
const pct = (n) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(n >= 0.995 || n === 0 ? 0 : 1)}%`);
const score = (n) => (n === null || n === undefined ? '—' : n.toFixed(2));
const usd = (n) => (n === null || n === undefined ? '—' : `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`);

function ChartCard({ title, children, className }) {
  return <Card title={title} className={className}><div style={{ width: '100%', height: 260 }}>{children}</div></Card>;
}

export default function Dashboard() {
  const t = useChartTheme();
  const [agents, setAgents] = useState([]);
  const [versions, setVersions] = useState([]);
  const [f, setF] = useState(DEFAULTS);
  const [more, setMore] = useState(false);
  const [tick, setTick] = useState(0);
  const [data, setData] = useState(null);
  const [demoCount, setDemoCount] = useState(0);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { api('/agents?limit=100').then((r) => setAgents(r.items)).catch(() => {}); }, []);
  useEffect(() => {
    setVersions([]);
    if (f.agentId) api(`/agents/${f.agentId}/versions`).then((r) => setVersions(r.items.map((v) => v.version))).catch(() => {});
  }, [f.agentId]);

  const query = useMemo(() => {
    const to = new Date(); const from = new Date(to.getTime() - Number(f.range) * 86_400_000);
    const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    for (const k of ['version', 'environment', 'status', 'metric']) if (f[k]) q.set(k, f[k]);
    if (f.hideDemo) q.set('demo', 'false');
    return q;
  }, [f, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    const path = f.agentId ? `/agents/${f.agentId}/metrics` : '/analytics/overview';
    api(`${path}?${query}`).then((d) => { if (alive) setData(d); }).catch((e) => alive && setError(e)).finally(() => alive && setLoading(false));
    const demoQ = new URLSearchParams(query); demoQ.set('demo', 'true'); if (f.agentId) demoQ.set('agentId', f.agentId);
    api(`/analytics/overview?${demoQ}`).then((d) => alive && setDemoCount(d.totals.executions)).catch(() => {});
    return () => { alive = false; };
  }, [query, f.agentId]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value, ...(k === 'agentId' ? { version: '' } : {}) });
  const daily = (data?.trends.daily ?? []).map((d) => ({ date: d.date.slice(5), succeeded: d.count - d.errors, errors: d.errors, latency: d.avgLatencyMs === null ? null : Math.round(d.avgLatencyMs) }));
  const runs = (data?.trends.runs ?? []).map((r) => ({ label: new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), ...r.scores }));
  const runMetrics = METRICS.filter((m) => runs.some((r) => r[m] !== undefined));
  const q = data?.quality; const ex = data?.execution;
  const activeMore = ['environment', 'status', 'metric'].filter((k) => f[k]).length + (f.hideDemo ? 1 : 0);
  const changed = JSON.stringify(f) !== JSON.stringify(DEFAULTS);
  const versionCols = data?.versions ? METRICS.filter((m) => data.versions.some((v) => v.quality[m] !== undefined)) : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard" description="How your agents are performing: reliability, speed, cost and answer quality."
        actions={<Button variant="secondary" icon="refresh" loading={loading && !!data} onClick={() => setTick((n) => n + 1)}>Refresh</Button>}
      />

      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Agent"><Select value={f.agentId} onChange={set('agentId')}><option value="">All agents</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          <Field label="Version"><Select value={f.version} onChange={set('version')} disabled={!f.agentId}><option value="">{f.agentId ? 'All versions' : 'Pick an agent first'}</option>{versions.map((v) => <option key={v} value={v}>{v}</option>)}</Select></Field>
          <Field label="Period"><Select value={f.range} onChange={set('range')}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option></Select></Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" icon="filter" aria-expanded={more} onClick={() => setMore(!more)}>
            More filters{activeMore > 0 && <span className="ml-1 rounded-full bg-brand-soft px-1.5 text-xs font-semibold text-link">{activeMore}</span>}
          </Button>
          {changed && <Button variant="ghost" size="sm" onClick={() => setF(DEFAULTS)}>Reset filters</Button>}
        </div>
        {more && (
          <div className="mt-3 grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
            <Field label="Environment"><Select value={f.environment} onChange={set('environment')}><option value="">Any</option><option value="production">production</option><option value="test">test</option><option value="evaluation">evaluation</option></Select></Field>
            <Field label="Execution status"><Select value={f.status} onChange={set('status')}><option value="">Any</option><option value="success">success</option><option value="error">error</option><option value="cancelled">cancelled</option><option value="timeout">timeout</option></Select></Field>
            <Field label="Evaluation metric"><Select value={f.metric} onChange={set('metric')}><option value="">All metrics</option>{METRICS.map((m) => <option key={m} value={m}>{humanize(m)}</option>)}</Select></Field>
            <div className="sm:col-span-3"><Checkbox checked={f.hideDemo} onChange={(e) => setF({ ...f, hideDemo: e.target.checked })}>Hide demo data</Checkbox></div>
          </div>
        )}
      </Card>

      {demoCount > 0 && !f.hideDemo && (
        <Notice tone="warning" title="Demo data is included" action={<Button size="sm" variant="secondary" onClick={() => setF({ ...f, hideDemo: true })}>Hide demo data</Button>}>
          {demoCount} of the executions below are sample traces generated for demonstration (marked “demo”).
        </Notice>
      )}
      <ErrorBox error={error} />

      {loading && !data && (
        <div className="space-y-6" role="status" aria-label="Loading dashboard">
          <Skeleton className="h-24" /><Skeleton className="h-24" />
          <div className="grid gap-6 lg:grid-cols-2"><Skeleton className="h-80" /><Skeleton className="h-80" /></div>
        </div>
      )}

      {data && (
        <>
          <section aria-labelledby="exec-h" className="space-y-2.5">
            <h2 id="exec-h" className="text-base font-semibold">Execution health</h2>
            <StatStrip>
              <Stat label="Agents" value={data.totals.agents} />
              <Stat label="Executions" value={data.totals.executions.toLocaleString()} hint={`${data.totals.failedExecutions} did not succeed`} />
              <Stat label="Executions completed" value={pct(ex.taskCompletionRate)} hint={`Error rate ${pct(ex.errorRate)}`} tone={ex.errorRate > 0.1 ? 'bad' : undefined} />
              <Stat label="Avg latency" value={ex.avgLatencyMs === null ? '—' : fmtDuration(ex.avgLatencyMs)} />
              <Stat label="Est. execution cost" value={usd(ex.estimatedCostUsd)} hint={ex.costCoverage === null ? 'No cost data' : `Reported by ${pct(ex.costCoverage)} of executions`} />
            </StatStrip>
          </section>

          <section aria-labelledby="qual-h" className="space-y-2.5">
            <h2 id="qual-h" className="text-base font-semibold">Answer quality</h2>
            <StatStrip>
              <Stat label="Evaluation runs" value={data.totals.evaluationRuns} />
              <Stat label="Accuracy (avg score)" value={score(q.accuracy)} hint={q.metrics.accuracy ? `${q.metrics.accuracy.n} evaluated` : 'No evaluations yet'} />
              <Stat label="Groundedness (avg score)" value={score(q.groundedness)} />
              <Stat label="Unsupported-claim rate" value={pct(q.unsupportedClaimRate)} tone={q.unsupportedClaimRate > 0.2 ? 'bad' : undefined} hint={q.contradictedClaimRate !== null ? `${pct(q.contradictedClaimRate)} contradicted` : 'Needs hallucination checks'} />
              <Stat label="Failed test cases" value={q.failedTestCases} tone={q.failedTestCases > 0 ? 'bad' : undefined} hint={`Of ${q.evaluatedCases} evaluated, pass rate ${pct(q.passRate)}`} />
            </StatStrip>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <ChartCard title="Quality across evaluation runs (average score per metric)">
              {!runs.length ? <Empty icon="runs" title="No evaluation runs in this period">Start one under Evaluations.</Empty> : (
                <ResponsiveContainer>
                  <LineChart data={runs} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                    <CartesianGrid {...gridProps(t)} /><XAxis dataKey="label" {...xAxisProps(t)} /><YAxis domain={[0, 1]} {...yAxisProps(t)} />
                    <Tooltip content={<ChartTooltip />} cursor={{ stroke: t.grid }} /><Legend {...legendProps(t)} />
                    {runMetrics.map((m, i) => <Line key={m} type="monotone" dataKey={m} stroke={t.series[i % 8]} strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />)}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </ChartCard>
            <ChartCard title="Executions per day">
              {!daily.length ? <Empty icon="traces" title="No executions in this period">Send traces with the Python SDK, or generate demo data.</Empty> : (
                <ResponsiveContainer>
                  <BarChart data={daily} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                    <CartesianGrid {...gridProps(t)} /><XAxis dataKey="date" {...xAxisProps(t)} /><YAxis allowDecimals={false} {...yAxisProps(t)} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: t.cursor }} /><Legend {...legendProps(t)} />
                    <Bar dataKey="succeeded" stackId="a" fill={t.success} isAnimationActive={false} /><Bar dataKey="errors" stackId="a" fill={t.danger} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartCard>
            <ChartCard title="Average latency per day (ms)" className="lg:col-span-2">
              {!daily.length ? <Empty icon="clock" title="No data" /> : (
                <ResponsiveContainer>
                  <LineChart data={daily} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                    <CartesianGrid {...gridProps(t)} /><XAxis dataKey="date" {...xAxisProps(t)} /><YAxis {...yAxisProps(t)} />
                    <Tooltip content={<ChartTooltip unit=" ms" />} cursor={{ stroke: t.grid }} />
                    <Line type="monotone" dataKey="latency" name="Avg latency" stroke={t.series[0]} strokeWidth={2} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </ChartCard>
          </div>

          {data.versions && (
            <Card title="Version comparison" flush>
              {!data.versions.length ? <Empty icon="layers" title="No versioned executions yet">Pass agent_version when you create the SDK handler.</Empty> : (
                <>
                  <Table>
                    <thead><tr><th>Version</th><th className="text-right">Executions</th><th className="text-right">Error rate</th><th className="text-right">Avg latency</th><th className="text-right">Avg tokens</th>{versionCols.map((m) => <th key={m} className="text-right">{humanize(m)}</th>)}</tr></thead>
                    <tbody>
                      {data.versions.map((v) => (
                        <tr key={v.version}>
                          <td className="font-medium">{v.version}</td><td className="text-right">{v.executions}</td><td className="text-right">{pct(v.errorRate)}</td>
                          <td className="text-right">{v.avgLatencyMs === null ? '—' : fmtDuration(v.avgLatencyMs)}</td><td className="text-right">{v.avgTokens ?? '—'}</td>
                          {versionCols.map((m) => <td key={m} className="text-right">{score(v.quality[m])}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <p className="border-t border-line px-5 py-3 text-xs text-muted">Quality scores appear for versions that took part in evaluation runs started after Milestone 4 (older results do not record the version).</p>
                </>
              )}
            </Card>
          )}

          <Card title="Recent failed test cases" flush>
            {!data.recentFailures.length ? <Empty icon="check-circle" title="No failed test cases in this period" /> : (
              <ul className="divide-y divide-line">
                {data.recentFailures.map((r) => (
                  <li key={`${r.runId}${r.testCaseId}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{r.inputPreview || '(no input)'}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                        <span>{fmtTime(r.evaluatedAt)}</span><Pill>{r.status}</Pill>
                        {r.failedMetrics.map((m) => <Tag key={m} tone="danger">{humanize(m)}</Tag>)}
                        {r.error && <span>{r.error}</span>}
                      </div>
                    </div>
                    <div className="flex gap-4 text-sm">
                      <a className={linkCls} href={`#/runs/${r.runId}`}>Run results</a>
                      {r.traceId && <a className={linkCls} href={`#/debug/${r.traceId}`}>Debug</a>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
