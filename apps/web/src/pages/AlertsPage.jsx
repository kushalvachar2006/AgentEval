import { useCallback, useEffect, useState } from 'react';
import { api, fmtTime } from '../api.js';
import { useConfirm, useToast } from '../components/feedback.jsx';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, PasswordInput, Pill, Select, Switch, Table, Tabs, cx, linkCls, tabPanel } from '../components/ui.jsx';
import { ago } from '../hooks.js';

const TYPES = { error_rate: 'Error rate', latency: 'Latency', quality_drop: 'Quality drop', cost_per_day: 'Cost per day', silence: 'No traces (silence)' };
const METRICS = ['hallucination', 'groundedness', 'relevance', 'tool_usage', 'instruction_adherence', 'operational'];
const DEFAULT_PARAMS = { error_rate: { windowMinutes: 15, thresholdPct: 10, minSamples: 20 }, latency: { stat: 'p95', windowMinutes: 15, thresholdMs: 3000, minSamples: 20 }, quality_drop: { metric: 'relevance', dropThreshold: 0.1, windowMinutes: 60, baseline: 'previous_window', minSamples: 10 }, cost_per_day: { thresholdUsd: 50, minSamples: 5 }, silence: { silenceMinutes: 30 } };
const FIELDS = {
  error_rate: [['windowMinutes', 'Window (minutes)'], ['thresholdPct', 'Fire when error rate is above (%)'], ['minSamples', 'Minimum traces in window']],
  latency: [['windowMinutes', 'Window (minutes)'], ['thresholdMs', 'Fire when latency is above (ms)'], ['minSamples', 'Minimum traces in window']],
  quality_drop: [['windowMinutes', 'Window (minutes)'], ['dropThreshold', 'Fire when score drops by more than (0 to 1)'], ['minSamples', 'Minimum scored results (each window)']],
  cost_per_day: [['thresholdUsd', 'Fire when 24 h cost is above ($)'], ['minSamples', 'Minimum traces reporting a cost']],
  silence: [['silenceMinutes', 'Fire when no trace for (minutes)']],
};

function AlertRow({ a, agents, onChanged, detail }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const act = async (what) => { setBusy(true); setError(null); try { await api(`/alerts/${a.id}/${what}`, { method: 'POST' }); toast(what === 'resolve' ? 'Alert resolved' : 'Alert acknowledged'); onChanged(); } catch (e) { setError(e); } finally { setBusy(false); } };
  const agent = agents.find((x) => x.id === a.agentId)?.name ?? (a.agentId ? a.agentId.slice(-6) : 'all agents');
  const critical = a.severity === 'critical' && a.status !== 'resolved';
  return (
    <div className={cx('space-y-2.5 px-5 py-4', critical && 'border-l-2 border-l-danger-dot')}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill>{a.severity}</Pill><Pill>{a.status}</Pill>
        <a href={`#/alerts/${a.id}`} className={cx(linkCls, 'text-base')}>{a.ruleName}</a>
      </div>
      <p className="text-xs text-muted">{TYPES[a.ruleType]} on {agent}. Opened {ago(a.openedAt)}{a.resolvedAt ? `, resolved ${ago(a.resolvedAt)}${a.resolvedBy === 'auto' ? ' automatically' : ''}` : ''}. Checked {a.evaluations} times, last {ago(a.lastEvaluatedAt)}.</p>
      <p className="text-sm">{a.explanation}</p>
      <div className="flex flex-wrap items-center gap-2">
        {a.status === 'open' && <Button variant="secondary" size="xs" disabled={busy} onClick={() => act('acknowledge')}>Acknowledge</Button>}
        {a.status !== 'resolved' && <Button variant="secondary" size="xs" disabled={busy} onClick={() => act('resolve')}>Resolve</Button>}
        <a className={cx(linkCls, 'ml-1 text-sm')} href={a.links.monitoring}>Monitoring view</a>
        {a.links.traces && <a className={cx(linkCls, 'text-sm')} href={a.links.traces}>Matching traces</a>}
      </div>
      {detail && (
        <div className="grid gap-4 rounded-lg bg-sunken p-4 text-sm sm:grid-cols-2">
          <div><p className="font-medium">Observed numbers</p><pre className="mt-1 whitespace-pre-wrap font-mono text-xs">{JSON.stringify(a.observed, null, 2)}</pre><p className="mt-1 text-muted">Threshold: {a.threshold}</p></div>
          <div>
            <p className="font-medium">Window</p><p className="mt-1 text-muted">{fmtTime(a.window?.from)} to {fmtTime(a.window?.to)}</p>
            <p className="mt-3 font-medium">Notifications</p>
            {a.notifications?.length ? a.notifications.map((n, i) => <p key={i} className="mt-1 text-xs text-muted">{n.event} to {n.channel} ({n.host}): {n.ok ? `ok (HTTP ${n.status})` : `failed ${n.error ?? `(HTTP ${n.status})`}`}</p>) : <p className="mt-1 text-muted">In-app only.</p>}
          </div>
        </div>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

function AlertList({ agents }) {
  const [tab, setTab] = useState('active');
  const [items, setItems] = useState([]); const [next, setNext] = useState(null); const [error, setError] = useState(null); const [loading, setLoading] = useState(true);
  const load = useCallback(async (cursor) => {
    setLoading(true);
    try { const r = await api(`/alerts?limit=20${tab === 'active' ? '&status=active' : ''}${cursor ? `&cursor=${cursor}` : ''}`); setItems((p) => (cursor ? [...p, ...r.items] : r.items)); setNext(r.nextCursor); setError(null); } catch (e) { setError(e); } finally { setLoading(false); }
  }, [tab]);
  useEffect(() => { setItems([]); load(); const t = setInterval(() => { if (!document.hidden && tab === 'active') load(); }, 15_000); return () => clearInterval(t); }, [load, tab]);
  return (
    <section>
      <Tabs idPrefix="alerts" label="Alert list" value={tab} onChange={setTab} tabs={[['active', 'Active'], ['all', 'History']]} />
      <div {...tabPanel('alerts', tab)} className="mt-4 rounded-panel border border-line bg-surface">
        <ErrorBox error={error} />
        {!loading && items.length === 0 && <Empty icon="check-circle" title={tab === 'active' ? 'No active alerts' : 'No alerts have fired yet'}>{tab === 'active' ? 'Everything is within your rules.' : 'Fired alerts will be listed here.'}</Empty>}
        <div className="divide-y divide-line">{items.map((a) => <AlertRow key={a.id} a={a} agents={agents} onChanged={() => load()} />)}</div>
        {next && <div className="border-t border-line p-3 text-center"><Button variant="ghost" size="sm" onClick={() => load(next)}>Load more</Button></div>}
      </div>
    </section>
  );
}

function AlertDetail({ id, agents }) {
  const [a, setA] = useState(null); const [error, setError] = useState(null);
  const load = useCallback(() => api(`/alerts/${id}`).then(setA).catch(setError), [id]);
  useEffect(() => { load(); }, [load]);
  return (
    <div>
      <PageHeader breadcrumbs={[['Alerts', '#/alerts'], [a?.ruleName ?? 'Alert']]} title={a?.ruleName ?? 'Alert'} />
      <ErrorBox error={error} />
      {a && <Card flush><AlertRow a={a} agents={agents} onChanged={load} detail /></Card>}
    </div>
  );
}

function RuleEditor({ agents, rule, onDone }) {
  const toast = useToast();
  const [type, setType] = useState(rule?.type ?? 'error_rate');
  const [f, setF] = useState(() => ({ name: rule?.name ?? '', agentId: rule?.agentId ?? '', severity: rule?.severity ?? 'warning', cooldownMinutes: rule?.cooldownMinutes ?? 30, resolveAfterOk: rule?.resolveAfterOk ?? 2, evalEveryMinutes: rule?.evalEveryMinutes ?? 1, enabled: rule?.enabled ?? true, params: { ...DEFAULT_PARAMS[rule?.type ?? 'error_rate'], ...(rule?.params ?? {}) }, webhookUrl: '', webhookSecret: '', webhookFormat: rule?.notify?.webhook?.format ?? 'json' }));
  const [error, setError] = useState(null); const [test, setTest] = useState(null); const [busy, setBusy] = useState(false);
  const setP = (k) => (e) => setF({ ...f, params: { ...f.params, [k]: e.target.value } });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const changeType = (t) => { setType(t); setF({ ...f, params: { ...DEFAULT_PARAMS[t] } }); };
  async function save() {
    setError(null);
    const params = Object.fromEntries(Object.entries(f.params).map(([k, v]) => [k, ['metric', 'stat', 'baseline'].includes(k) ? v : v === '' ? undefined : Number(v)]));
    const body = { name: f.name, ...(rule ? {} : { type }), agentId: f.agentId || null, severity: f.severity, cooldownMinutes: Number(f.cooldownMinutes), resolveAfterOk: Number(f.resolveAfterOk), evalEveryMinutes: Number(f.evalEveryMinutes), enabled: f.enabled, params };
    if (f.webhookUrl || f.webhookSecret) body.notify = { webhook: { ...(f.webhookUrl && { url: f.webhookUrl }), ...(f.webhookSecret && { secret: f.webhookSecret }), format: f.webhookFormat } };
    setBusy(true);
    try { await api(rule ? `/alert-rules/${rule.id}` : '/alert-rules', { method: rule ? 'PATCH' : 'POST', body }); toast(rule ? 'Rule saved' : 'Rule created'); onDone(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function dryRun() { try { setTest(await api(`/alert-rules/${rule.id}/test`, { method: 'POST' })); } catch (e) { setError(e); } }
  const silence = type === 'silence';
  return (
    <Card title={rule ? `Edit rule: ${rule.name}` : 'New alert rule'} description="In-app alerts are always on. Add a webhook to notify another tool.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name"><Input value={f.name} onChange={set('name')} maxLength={100} /></Field>
        <Field label="Type"><Select value={type} disabled={Boolean(rule)} onChange={(e) => changeType(e.target.value)}>{Object.entries(TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="Agent"><Select value={f.agentId} onChange={set('agentId')}>{!silence && <option value="">All agents (combined)</option>}{silence && !f.agentId && <option value="">Choose an agent…</option>}{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label="Severity"><Select value={f.severity} onChange={set('severity')}><option value="warning">warning</option><option value="critical">critical</option></Select></Field>
        {type === 'latency' && <Field label="Statistic"><Select value={f.params.stat} onChange={setP('stat')}><option value="p95">p95</option><option value="avg">average</option></Select></Field>}
        {type === 'quality_drop' && <><Field label="Metric"><Select value={f.params.metric} onChange={setP('metric')}>{METRICS.map((m) => <option key={m}>{m}</option>)}</Select></Field><Field label="Compare against"><Select value={f.params.baseline} onChange={setP('baseline')}><option value="previous_window">previous window</option><option value="last_run" disabled={!f.agentId}>last evaluation run (needs one agent)</option></Select></Field></>}
        {FIELDS[type].map(([k, label]) => <Field key={k} label={label}><Input type="number" step="any" value={f.params[k] ?? ''} onChange={setP(k)} /></Field>)}
        <Field label="Cooldown after resolving (minutes)"><Input type="number" value={f.cooldownMinutes} onChange={set('cooldownMinutes')} /></Field>
        <Field label="OK checks before auto-resolve"><Input type="number" value={f.resolveAfterOk} onChange={set('resolveAfterOk')} /></Field>
        <Field label="Check every (minutes)"><Input type="number" value={f.evalEveryMinutes} onChange={set('evalEveryMinutes')} /></Field>
        <div className="self-end pb-2"><Switch checked={f.enabled} onChange={set('enabled')} label="Enabled" /></div>
      </div>
      <details className="mt-5 rounded-lg border border-line p-4 text-sm">
        <summary className="cursor-pointer font-medium">Webhook notification (optional){rule?.notify?.webhook ? `, currently ${rule.notify.webhook.host}` : ''}</summary>
        <p className="my-3 text-xs text-muted">A webhook receives numbers and names only, never trace content. The URL is stored encrypted and never shown again; leave empty to keep the current one. Use the Slack format for Slack incoming webhooks.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="URL (https)"><Input value={f.webhookUrl} onChange={set('webhookUrl')} placeholder={rule?.notify?.webhook ? '(unchanged)' : 'https://…'} autoComplete="off" /></Field>
          <Field label="Signing secret (optional)"><PasswordInput value={f.webhookSecret} onChange={set('webhookSecret')} autoComplete="new-password" /></Field>
          <Field label="Format"><Select value={f.webhookFormat} onChange={set('webhookFormat')}><option value="json">JSON</option><option value="slack">Slack</option></Select></Field>
        </div>
      </details>
      {test && <p className="mt-4 flex items-start gap-2 rounded-lg bg-sunken p-3 text-sm"><Pill>{test.state}</Pill> <span>{test.explanation}</span></p>}
      <div className="mt-4"><ErrorBox error={error} /></div>
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button onClick={save} loading={busy}>{rule ? 'Save changes' : 'Create rule'}</Button>
        <Button variant="secondary" onClick={onDone}>Cancel</Button>
        {rule && <Button variant="secondary" className="ml-auto" onClick={dryRun}>Test against live data</Button>}
      </div>
    </Card>
  );
}

function Rules({ agents }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [rules, setRules] = useState(null); const [error, setError] = useState(null); const [editing, setEditing] = useState(null);
  const load = useCallback(() => api('/alert-rules?limit=100').then((r) => setRules(r.items)).catch((e) => { setError(e); setRules((p) => p ?? []); }), []);
  useEffect(() => { load(); }, [load]);
  if (editing) return <RuleEditor agents={agents} rule={editing === 'new' ? null : editing} onDone={() => { setEditing(null); load(); }} />;
  const del = async (r) => {
    if (!(await confirm({ title: `Delete rule “${r.name}”?`, description: 'Its open alert is resolved. History is kept.', confirmLabel: 'Delete rule', danger: true }))) return;
    try { await api(`/alert-rules/${r.id}`, { method: 'DELETE' }); toast('Rule deleted'); load(); } catch (e) { setError(e); }
  };
  return (
    <Card flush title="Alert rules" description="Rules are evaluated by the worker about every minute." action={<Button icon="plus" onClick={() => setEditing('new')}>New rule</Button>}>
      <div className="px-5"><ErrorBox error={error} /></div>
      {rules === null ? null : rules.length === 0 ? (
        <Empty icon="alerts" title="No rules yet" action={<Button icon="plus" onClick={() => setEditing('new')}>Create a rule</Button>}>For example: error rate above 10% over 15 minutes.</Empty>
      ) : (
        <Table>
          <thead><tr><th>Rule</th><th>Last check</th><th>Webhook</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="align-top">
                <td><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{r.name}</span><Pill>{r.severity}</Pill>{!r.enabled && <Pill>disabled</Pill>}</div><div className="mt-1 text-xs text-muted">{TYPES[r.type]} on {agents.find((a) => a.id === r.agentId)?.name ?? 'all agents'}</div></td>
                <td className="text-xs">{r.lastEvaluation ? <><Pill>{r.lastEvaluation.state}</Pill> <span className="ml-1 text-muted">{ago(r.lastEvaluation.at)}</span><div className="mt-1 max-w-md text-muted">{r.lastEvaluation.explanation}</div></> : <span className="text-muted">Not checked yet</span>}</td>
                <td className="text-xs text-muted">{r.notify.webhook ? r.notify.webhook.host : '—'}</td>
                <td className="whitespace-nowrap text-right"><Button variant="secondary" size="xs" onClick={() => setEditing(r)}>Edit</Button> <Button variant="danger" size="xs" className="ml-1" onClick={() => del(r)}>Delete</Button></td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

export default function AlertsPage({ id }) {
  const [agents, setAgents] = useState([]);
  useEffect(() => { api('/agents?limit=100').then((r) => setAgents(r.items)).catch(() => {}); }, []);
  if (id) return <AlertDetail id={id} agents={agents} />;
  return (
    <div className="space-y-8">
      <PageHeader title="Alerts" description="Get told when error rate, latency, quality or cost leave the limits you set." />
      <AlertList agents={agents} />
      <Rules agents={agents} />
    </div>
  );
}
