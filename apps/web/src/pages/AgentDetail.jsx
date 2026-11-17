import { useCallback, useEffect, useState } from 'react';
import { api, fmtDuration, fmtTime } from '../api.js';
import { useConfirm, useToast } from '../components/feedback.jsx';
import { Button, Card, Checkbox, Code, CopyButton, Empty, ErrorBox, Field, Input, Meta, Notice, PageHeader, Pill, RelTime, Select, Skeleton, Table, Tag, cx, linkCls } from '../components/ui.jsx';

function Step({ n, title, children }) {
  return (
    <div className="flex gap-4">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white">{n}</span>
      <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{title}</h3><div className="mt-3">{children}</div></div>
    </div>
  );
}

export default function AgentDetail({ id }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [agent, setAgent] = useState(null);
  const [keys, setKeys] = useState([]);
  const [traces, setTraces] = useState(null);
  const [next, setNext] = useState(null);
  const [status, setStatus] = useState('');
  const [live, setLive] = useState(false);
  const [newKey, setNewKey] = useState(null);
  const [keyName, setKeyName] = useState('my-laptop');
  const [error, setError] = useState(null);
  const [versions, setVersions] = useState([]);
  const [cmp, setCmp] = useState([]);
  const [newVer, setNewVer] = useState({ version: '', notes: '' });

  const loadAgent = useCallback(async () => {
    try { setAgent(await api(`/agents/${id}`)); } catch (e) { setError(e); }
    try { setKeys((await api('/api-keys')).items.filter((k) => !k.revokedAt && (!k.agentId || k.agentId === id))); } catch { /* viewers cannot list keys */ }
  }, [id]);

  const loadTraces = useCallback(async (cursor) => {
    try {
      const q = new URLSearchParams({ limit: '15', ...(status && { status }), ...(cursor && { cursor }) });
      const r = await api(`/agents/${id}/traces?${q}`);
      setTraces((prev) => (cursor ? [...(prev ?? []), ...r.items] : r.items));
      setNext(r.nextCursor);
    } catch (e) { setError(e); setTraces((p) => p ?? []); }
  }, [id, status]);

  const loadVersions = useCallback(async () => {
    try { setVersions((await api(`/agents/${id}/versions`)).items); } catch { /* ignore */ }
    try { setCmp((await api(`/agents/${id}/metrics?from=${encodeURIComponent(new Date(Date.now() - 90 * 86_400_000).toISOString())}`)).versions); } catch { /* ignore */ }
  }, [id]);
  async function addVersion(e) {
    e.preventDefault(); setError(null);
    try { await api(`/agents/${id}/versions`, { method: 'POST', body: { version: newVer.version, ...(newVer.notes && { notes: newVer.notes }) } }); toast(`Version ${newVer.version} added`); setNewVer({ version: '', notes: '' }); loadAgent(); loadVersions(); }
    catch (err) { setError(err); }
  }
  useEffect(() => { loadAgent(); loadVersions(); }, [loadAgent, loadVersions]);
  useEffect(() => { loadTraces(); }, [loadTraces]);
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => { loadTraces(); loadAgent(); }, 4000);
    return () => clearInterval(t);
  }, [live, loadTraces, loadAgent]);

  async function createKey(e) {
    e.preventDefault(); setError(null);
    try { setNewKey(await api('/api-keys', { method: 'POST', body: { name: keyName, scopes: ['traces:write', 'evaluations:run'], agentId: id } })); loadAgent(); }
    catch (err) { setError(err); }
  }
  async function revoke(k) {
    if (!(await confirm({ title: `Revoke key “${k.name}”?`, description: 'Anything using it will stop working immediately.', confirmLabel: 'Revoke key', danger: true }))) return;
    try { await api(`/api-keys/${k.id}`, { method: 'DELETE' }); toast('Key revoked'); loadAgent(); } catch (err) { setError(err); }
  }
  async function archive() {
    if (!(await confirm({ title: `Archive “${agent.name}”?`, description: 'Its API keys are revoked. Stored traces stay until retention expires.', confirmLabel: 'Archive agent', danger: true }))) return;
    try { await api(`/agents/${id}`, { method: 'DELETE' }); window.location.hash = '#/agents'; } catch (err) { setError(err); }
  }

  if (!agent) {
    return error ? <div className="space-y-4"><ErrorBox error={error} /><Button variant="secondary" href="#/agents" icon="arrow-left">Back to agents</Button></div>
      : <div className="space-y-4" role="status" aria-label="Loading agent"><Skeleton className="h-16" /><Skeleton className="h-64" /></div>;
  }

  /* OLD (kept for reference)
  const snippet = `from agenteval import AgentEval

client = AgentEval(api_key="<PASTE YOUR KEY>", endpoint="${window.location.origin}")
handler = client.${agent.framework === 'langgraph' ? 'langgraph_handler' : 'langchain_handler'}("${agent.id}")

# LangChain / LangGraph: pass the handler in the run config
result = chain.invoke(inputs, config={"callbacks": [handler]})
client.flush()`;
  */
  // Python SDK talks straight to the API server (no CORS involved). Optional Netlify env VITE_API_URL = your Render API URL;
  // otherwise the site's own origin is used (works through the /api proxy).
  const apiUrl = (import.meta.env.VITE_API_URL || window.location.origin).replace(/\/$/, '');
  // Optional Netlify env VITE_SDK_REPO, e.g. https://github.com/you/agenteval.git
  const repoUrl = import.meta.env.VITE_SDK_REPO || 'https://github.com/<your-username>/<your-repo>.git';
  const extra = agent.framework === 'langgraph' ? '[langgraph]' : agent.framework === 'langchain' ? '[langchain]' : '';
  const installCmd = `pip install "agenteval${extra} @ git+${repoUrl}#subdirectory=sdk/python"`;
  const keyCmd = `# macOS / Linux
export AGENTEVAL_API_KEY="<PASTE YOUR KEY>"
# Windows PowerShell
$env:AGENTEVAL_API_KEY="<PASTE YOUR KEY>"`;
  const head = `import os
from agenteval import AgentEval

client = AgentEval(
    api_key=os.environ["AGENTEVAL_API_KEY"],   # key from step 1
    endpoint="${apiUrl}",
    timeout=60,                                # free hosting may need ~50s to wake up
)
`;
  const snippet = agent.framework === 'langgraph'
    ? `${head}config = client.langgraph_config("${agent.id}", thread_id="session-1", agent_version="${agent.currentVersion}", environment="production")

result = app.invoke(inputs, config=config)     # app = your compiled graph
client.flush()                                 # sends queued traces (needed in scripts / notebooks)
print(client.stats)`
    : agent.framework === 'langchain'
      ? `${head}handler = client.langchain_handler("${agent.id}", agent_version="${agent.currentVersion}", environment="production")

result = chain.invoke(inputs, config={"callbacks": [handler]})
client.flush()
print(client.stats)`
      : `from agenteval.builder import TraceBuilder
${head}
b = TraceBuilder("${agent.id}", "custom", agent_version="${agent.currentVersion}", environment="production", input=question)
b.begin_span("root", None, "agent", "my_agent", input=question)
b.begin_span("t1", "root", "tool", "search", input={"q": question})
b.end_span("t1", output=tool_result)           # record what tools really returned
b.end_span("root", output=answer)
client.capture(b.finish(output=answer))
client.flush()`;
  const hasTraces = traces !== null && (traces.length > 0 || Boolean(status));

  return (
    <div>
      <PageHeader
        breadcrumbs={[['Agents', '#/agents'], [agent.name]]} title={agent.name} badge={<Pill>{agent.status}</Pill>}
        actions={<Button variant="danger" icon="trash" onClick={archive}>Archive agent</Button>}
      >
        <Meta>
          <span>{agent.framework}</span><span>Version {agent.currentVersion}</span><span>Last trace <RelTime iso={agent.lastTraceAt} className="ml-1" /></span>
          <span className="gap-2">ID <code className="rounded bg-sunken px-1.5 py-0.5 text-xs">{agent.id}</code><CopyButton text={agent.id} label="Copy ID" size="xs" /></span>
        </Meta>
      </PageHeader>
      <div className="mb-6"><ErrorBox error={error} /></div>

      <div className="flex flex-col gap-6">
        <Card title="Connect your agent" description="Create an API key, install the SDK, then add the tracing code to your agent." className={cx(hasTraces && 'order-last')}>
          <div className="space-y-7">
            <Step n={1} title="Create an API key">
              <form onSubmit={createKey} className="flex flex-wrap items-end gap-3">
                <Field label="Key name"><Input value={keyName} onChange={(e) => setKeyName(e.target.value)} required maxLength={64} className="!w-64" /></Field>
                <Button type="submit" icon="key">Create API key</Button>
              </form>
              {newKey && (
                <Notice tone="warning" title="Copy this key now. It is shown only once." className="mt-4">
                  <div className="mt-2 flex flex-wrap items-center gap-2"><code className="break-all rounded bg-surface px-2 py-1 text-xs">{newKey.key}</code><CopyButton text={newKey.key} /></div>
                  <Button variant="secondary" size="sm" className="mt-3" onClick={() => setNewKey(null)}>I’ve saved it</Button>
                </Notice>
              )}
              {keys.length > 0 && (
                <ul className="mt-4 divide-y divide-line rounded-lg border border-line text-sm">
                  {keys.map((k) => (
                    <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                      <span><strong className="font-medium">{k.name}</strong> <code className="ml-1 text-xs text-muted">{k.keyPrefix}…</code><span className="ml-3 text-xs text-muted">Last used <RelTime iso={k.lastUsedAt} /></span></span>
                      <Button variant="danger" size="xs" onClick={() => revoke(k)}>Revoke</Button>
                    </li>
                  ))}
                </ul>
              )}
            </Step>
            {/* OLD Step 2 (kept for reference)
            <Step n={2} title="Add this to your Python code">
              <div className="mb-2 flex justify-end"><CopyButton text={snippet} label="Copy code" /></div>
              <Code wrap={false}>{snippet}</Code>
              <p className="mt-2 text-xs text-muted">Install the SDK from this repository first: <code>pip install -e sdk/python</code></p>
            </Step>
            */}
            <Step n={2} title="Install the SDK (once, in the environment where your agent runs)">
              <div className="mb-2 flex justify-end"><CopyButton text={installCmd} label="Copy command" /></div>
              <Code wrap>{installCmd}</Code>
              <p className="mt-2 text-xs text-muted">Python 3.10+. Replace the repository URL with your own GitHub repo that contains the <code>sdk/python</code> folder. Inside a local clone you can instead run <code>pip install -e "sdk/python{extra}"</code>.</p>
            </Step>
            <Step n={3} title="Save the API key as an environment variable">
              <Code wrap={false}>{keyCmd}</Code>
            </Step>
            <Step n={4} title="Add tracing to your agent code">
              <div className="mb-2 flex justify-end"><CopyButton text={snippet} label="Copy code" /></div>
              <Code wrap={false}>{snippet}</Code>
              <p className="mt-2 text-xs text-muted">Run your agent once, then press Refresh in the Traces card below. Check <code>client.stats</code> if nothing arrives: it shows how many traces were sent or failed.</p>
            </Step>
          </div>
        </Card>

        <Card
          flush title="Traces"
          action={<>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status" className="!w-40">
              <option value="">All statuses</option><option value="success">success</option><option value="error">error</option><option value="cancelled">cancelled</option><option value="timeout">timeout</option>
            </Select>
            <Checkbox checked={live} onChange={(e) => setLive(e.target.checked)}>Live</Checkbox>
            <Button variant="secondary" size="sm" icon="refresh" onClick={() => loadTraces()}>Refresh</Button>
          </>}
        >
          {traces === null ? <div className="p-5"><Skeleton className="h-40" /></div> : !traces.length ? (
            <Empty icon="traces" title={status ? 'No traces with this status' : 'No traces yet'}>{status ? 'Try another status.' : 'Run your agent with the handler above, then refresh.'}</Empty>
          ) : (
            <Table>
              <thead><tr><th>Started</th><th>Status</th><th className="text-right">Duration</th><th className="text-right">LLM / tool calls</th><th className="text-right">Tokens</th><th>Input</th></tr></thead>
              <tbody>
                {traces.map((t) => (
                  <tr key={t.traceId}>
                    <td className="whitespace-nowrap">
                      <a className={linkCls} href={`#/traces/${t.traceId}`}>{fmtTime(t.startedAt)}</a>
                      {t.isDemo && <Tag tone="warning" className="ml-2">demo</Tag>}
                      <a className="ml-3 text-xs text-muted hover:text-link hover:underline" href={`#/debug/${t.traceId}`}>Debug</a>
                    </td>
                    <td><Pill>{t.status}</Pill></td><td className="text-right">{fmtDuration(t.durationMs)}</td>
                    <td className="text-right">{t.llmCallCount} / {t.toolCallCount}</td><td className="text-right">{t.usage?.totalTokens ?? '—'}</td>
                    <td className="max-w-xs truncate text-muted">{t.inputPreview}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
            <a className={cx(linkCls, 'text-sm')} href={`#/traces?agentId=${id}`}>Open all of this agent’s traces in the explorer</a>
            {next && <Button variant="ghost" size="sm" onClick={() => loadTraces(next)}>Load more</Button>}
          </div>
        </Card>

        <Card flush title="Versions" description={`Current version ${agent.currentVersion}. Versions also appear automatically when traces carry agent_version.`}>
          <form onSubmit={addVersion} className="flex flex-wrap items-end gap-3 p-5">
            <Field label="New version"><Input value={newVer.version} onChange={(e) => setNewVer({ ...newVer, version: e.target.value })} required maxLength={32} placeholder="1.1.0" className="!w-40" /></Field>
            <Field label="Notes (optional)"><Input value={newVer.notes} onChange={(e) => setNewVer({ ...newVer, notes: e.target.value })} maxLength={1000} className="!w-72" /></Field>
            <Button type="submit" icon="plus">Add version</Button>
          </form>
          {cmp.length > 0 && (
            <div className="border-t border-line">
              <Table>
                <thead><tr><th>Version</th><th className="text-right">Executions (90 d)</th><th className="text-right">Error rate</th><th className="text-right">Avg latency</th><th className="text-right">Avg tokens</th></tr></thead>
                <tbody>{cmp.map((v) => <tr key={v.version}><td className="font-medium">{v.version}</td><td className="text-right">{v.executions}</td><td className="text-right">{v.errorRate === null ? '—' : `${(v.errorRate * 100).toFixed(1)}%`}</td><td className="text-right">{v.avgLatencyMs === null ? '—' : fmtDuration(v.avgLatencyMs)}</td><td className="text-right">{v.avgTokens ?? '—'}</td></tr>)}</tbody>
              </Table>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3.5">
            {versions.map((v) => <Tag key={v.id} title={v.notes || ''}>{v.version}{v.source === 'trace' ? ' (seen in traces)' : ''}</Tag>)}
            <a className={cx(linkCls, 'ml-auto text-sm')} href="#/dashboard">Compare versions on the dashboard</a>
          </div>
        </Card>
      </div>
    </div>
  );
}