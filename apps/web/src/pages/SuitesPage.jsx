import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../components/Dialog.jsx';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Table, TableSkeleton, linkCls } from '../components/ui.jsx';

export default function SuitesPage() {
  const [items, setItems] = useState([]);
  const [next, setNext] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (cursor) => {
    setLoading(true); setError(null);
    try {
      const r = await api(`/test-suites?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      setItems((p) => (cursor ? [...p, ...r.items] : r.items)); setNext(r.nextCursor);
    } catch (e) { setError(e); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault(); setError(null); setBusy(true);
    try { const s = await api('/test-suites', { method: 'POST', body: { name, description } }); window.location.hash = `#/suites/${s.id}`; }
    catch (err) { setError(err); } finally { setBusy(false); }
  }
  const openDialog = () => { setName(''); setDescription(''); setError(null); setOpen(true); };

  return (
    <div className="space-y-6">
      <PageHeader title="Test suites" description="A suite is a set of questions with the answers you expect. Run it against an agent to score its quality." actions={<Button icon="plus" onClick={openDialog}>New test suite</Button>} />
      {!open && <ErrorBox error={error} />}
      <Card flush title="All suites" action={<Button variant="secondary" size="sm" icon="refresh" onClick={() => load()}>Refresh</Button>}>
        {loading && !items.length ? <TableSkeleton cols={2} /> : !items.length ? (
          <Empty icon="suites" title="No test suites yet" action={<Button icon="plus" onClick={openDialog}>Create your first suite</Button>}>Add questions and the answers you expect, or import them from a CSV or JSON file.</Empty>
        ) : (
          <Table>
            <thead><tr><th>Name</th><th className="text-right">Test cases</th></tr></thead>
            <tbody>{items.map((s) => <tr key={s.id}><td><a className={linkCls} href={`#/suites/${s.id}`}>{s.name}</a></td><td className="text-right text-muted">{s.caseCount} case{s.caseCount === 1 ? '' : 's'}</td></tr>)}</tbody>
          </Table>
        )}
        {next && <div className="border-t border-line p-3 text-center"><Button variant="ghost" size="sm" loading={loading} onClick={() => load(next)}>Load more</Button></div>}
      </Card>
      <Dialog open={open} onClose={() => setOpen(false)} onSubmit={create} title="New test suite" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={busy}>Create suite</Button></>}>
        <div className="space-y-4">
          <ErrorBox error={error} />
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="refund-policy-checks" /></Field>
          <Field label="Description (optional)"><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} /></Field>
        </div>
      </Dialog>
    </div>
  );
}
