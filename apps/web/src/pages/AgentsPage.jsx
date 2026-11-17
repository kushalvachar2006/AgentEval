import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../components/Dialog.jsx';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, PasswordInput, Pill, RelTime, Select, Table, TableSkeleton, linkCls } from '../components/ui.jsx';

const BLANK = { name: '', framework: 'langchain', description: '', integrationType: 'sdk', endpointUrl: '', endpointToken: '' };

export default function AgentsPage() {
  const [items, setItems] = useState([]);
  const [next, setNext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(async (cursor) => {
    setLoading(true); setError(null);
    try {
      const r = await api(`/agents?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      setItems((prev) => (cursor ? [...prev, ...r.items] : r.items));
      setNext(r.nextCursor);
    } catch (e) { setError(e); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    setCreating(true); setError(null);
    try {
      const body = { name: form.name, framework: form.framework, description: form.description, integrationType: form.integrationType, ...(form.integrationType === 'api' && { endpointUrl: form.endpointUrl, ...(form.endpointToken && { endpointToken: form.endpointToken }) }) };
      const a = await api('/agents', { method: 'POST', body });
      window.location.hash = `#/agents/${a.id}`;
    } catch (err) { setError(err); } finally { setCreating(false); }
  }

  const shown = filter ? items.filter((a) => a.name.toLowerCase().includes(filter.toLowerCase())) : items;
  const openDialog = () => { setForm(BLANK); setError(null); setOpen(true); };

  return (
    <div className="space-y-6">
      <PageHeader title="Agents" description="The AI agents you trace, evaluate and monitor." actions={<Button icon="plus" onClick={openDialog}>Register agent</Button>} />
      {!open && <ErrorBox error={error} />}
      <Card
        flush
        title={items.length ? `${items.length}${next ? '+' : ''} agent${items.length === 1 ? '' : 's'}` : 'Your agents'}
        action={<>
          {items.length > 5 && <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name" aria-label="Filter agents by name" className="!w-48" />}
          <Button variant="secondary" size="sm" icon="refresh" onClick={() => load()}>Refresh</Button>
        </>}
      >
        {loading && !items.length ? <TableSkeleton cols={5} /> : !items.length ? (
          <Empty icon="agents" title="No agents yet" action={<Button icon="plus" onClick={openDialog}>Register your first agent</Button>}>An agent is the AI app you want to measure. Register one to get an API key and start sending traces.</Empty>
        ) : (
          <Table>
            <thead><tr><th>Name</th><th>Framework</th><th>Status</th><th>Version</th><th>Last trace</th></tr></thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id}>
                  <td><a className={linkCls} href={`#/agents/${a.id}`}>{a.name}</a></td>
                  <td className="text-muted">{a.framework}</td><td><Pill>{a.status}</Pill></td><td>{a.currentVersion}</td><td className="text-muted"><RelTime iso={a.lastTraceAt} /></td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={5} className="py-8 text-center text-muted">No agent matches “{filter}”.</td></tr>}
            </tbody>
          </Table>
        )}
        {next && <div className="border-t border-line p-3 text-center"><Button variant="ghost" size="sm" loading={loading} onClick={() => load(next)}>Load more</Button></div>}
      </Card>

      <Dialog
        open={open} onClose={() => setOpen(false)} onSubmit={create} title="Register an agent" description="You’ll get an API key and a code sample on the next page."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={creating}>{creating ? 'Creating…' : 'Create agent'}</Button></>}
      >
        <div className="space-y-4">
          <ErrorBox error={error} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} placeholder="support-bot" /></Field>
            <Field label="Framework">
              <Select value={form.framework} onChange={(e) => setForm({ ...form, framework: e.target.value })}>
                <option value="langchain">LangChain</option><option value="langgraph">LangGraph</option><option value="custom">Custom</option>
              </Select>
            </Field>
          </div>
          <Field label="Description (optional)"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={1000} /></Field>
          <Field label="How does it connect?">
            <Select value={form.integrationType} onChange={(e) => setForm({ ...form, integrationType: e.target.value })}>
              <option value="sdk">Python SDK (runs on my machine)</option><option value="api">HTTP endpoint (server calls it)</option>
            </Select>
          </Field>
          {form.integrationType === 'api' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Endpoint URL"><Input value={form.endpointUrl} onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })} required placeholder="https://my-agent.example.com/run" /></Field>
              <Field label="Bearer token (optional)" hint="Stored encrypted."><PasswordInput value={form.endpointToken} onChange={(e) => setForm({ ...form, endpointToken: e.target.value })} minLength={8} autoComplete="off" /></Field>
            </div>
          )}
        </div>
      </Dialog>
    </div>
  );
}
