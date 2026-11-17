import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../components/Dialog.jsx';
import { useConfirm, useToast } from '../components/feedback.jsx';
import { Button, Card, Checkbox, Empty, ErrorBox, Field, Notice, PageHeader, Select, Skeleton, Tag, Textarea } from '../components/ui.jsx';

const SAMPLE = JSON.stringify([
  { input: 'Find the cheapest laptop below ₹50,000.', referenceAnswer: 'Acme Book 14 at ₹47,999', requiredElements: ['Acme Book 14', '₹47,999'], expectedToolCalls: [{ name: 'search_products', args: { maxPrice: 50000 } }] },
  { input: 'What is the refund window?', referenceAnswer: 'Refunds are available within 30 days of purchase.', referenceEvidence: ['The refund window is 30 days from the date of purchase.'] },
  { input: 'Say hello in one line.', constraints: { maxChars: 40, format: 'single_line' } },
], null, 2);

const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const BLANK = { input: '', referenceAnswer: '', referenceEvidence: '', requiredElements: '', toolCalls: '', constraints: '' };

export default function SuiteDetail({ id }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [suite, setSuite] = useState(null);
  const [cases, setCases] = useState([]);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [imp, setImp] = useState({ format: 'json', content: '', allowPartial: false });
  const [impResult, setImpResult] = useState(null);
  const [dialog, setDialog] = useState(null);   // 'add' | 'import' | null

  const load = useCallback(async (cursor) => {
    try {
      const r = await api(`/test-suites/${id}?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      setSuite(r); setCases((p) => (cursor ? [...p, ...r.cases.items] : r.cases.items)); setNext(r.cases.nextCursor);
    } catch (e) { setError(e); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const close = () => { setDialog(null); setError(null); setImpResult(null); };

  async function addCase(e) {
    e.preventDefault(); setError(null);
    try {
      const body = { input: form.input };
      if (form.referenceAnswer.trim()) body.referenceAnswer = form.referenceAnswer;
      if (form.referenceEvidence.trim()) body.referenceEvidence = form.referenceEvidence.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
      if (form.requiredElements.trim()) body.requiredElements = lines(form.requiredElements);
      try {
        if (form.toolCalls.trim()) body.expectedToolCalls = JSON.parse(form.toolCalls);
        if (form.constraints.trim()) body.constraints = JSON.parse(form.constraints);
      } catch { setError(new Error('Expected tool calls / constraints must be valid JSON.')); return; }
      await api(`/test-suites/${id}/cases`, { method: 'POST', body });
      setForm(BLANK); toast('Test case added'); setDialog(null);
      load();
    } catch (err) { setError(err); }
  }

  async function doImport(e) {
    e.preventDefault(); setError(null); setImpResult(null);
    try { const r = await api(`/test-suites/${id}/import`, { method: 'POST', body: imp }); setImpResult(r); setImp({ ...imp, content: '' }); load(); }
    catch (err) { setError(err); }
  }
  function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setImp({ ...imp, content: String(reader.result), format: f.name.toLowerCase().endsWith('.csv') ? 'csv' : 'json' });
    reader.readAsText(f);
  }
  async function remove(c) {
    if (!(await confirm({ title: 'Delete this test case?', description: 'Past evaluation runs keep their copy.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api(`/test-suites/${id}/cases/${c.id}`, { method: 'DELETE' }); toast('Test case deleted'); load(); } catch (err) { setError(err); }
  }

  if (!suite) return error ? <div className="space-y-4"><ErrorBox error={error} /><Button variant="secondary" href="#/suites" icon="arrow-left">Back to suites</Button></div> : <div role="status" aria-label="Loading suite" className="space-y-4"><Skeleton className="h-16" /><Skeleton className="h-64" /></div>;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[['Test suites', '#/suites'], [suite.name]]} title={suite.name} description={`${suite.caseCount} test case${suite.caseCount === 1 ? '' : 's'}`}
        actions={<>
          <Button variant="secondary" icon="upload" onClick={() => setDialog('import')}>Import cases</Button>
          <Button variant="secondary" icon="plus" onClick={() => { setForm(BLANK); setDialog('add'); }}>Add test case</Button>
          <Button href="#/runs" icon="play">Evaluate an agent</Button>
        </>}
      />
      {!dialog && <ErrorBox error={error} />}

      <Card flush title="Test cases">
        {!cases.length ? (
          <Empty icon="suites" title="No test cases yet" action={<div className="flex gap-2"><Button icon="plus" onClick={() => setDialog('add')}>Add a test case</Button><Button variant="secondary" onClick={() => { setImp({ format: 'json', content: SAMPLE, allowPartial: false }); setDialog('import'); }}>Try a sample</Button></div>}>Each case is a question and, optionally, the answer or evidence you expect.</Empty>
        ) : (
          <ol className="divide-y divide-line">
            {cases.map((c, i) => {
              const bits = [c.referenceEvidence?.length && `${c.referenceEvidence.length} evidence`, c.requiredElements?.length && `${c.requiredElements.length} required element(s)`, c.expectedToolCalls?.length && `${c.expectedToolCalls.length} expected tool call(s)`, c.constraints && 'constraints'].filter(Boolean);
              return (
                <li key={c.id} className="flex items-start gap-4 px-5 py-4">
                  <span className="mt-0.5 w-6 shrink-0 text-right text-sm tabular-nums text-faint">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{typeof c.input === 'string' ? c.input : JSON.stringify(c.input)}</p>
                    {c.referenceAnswer && <p className="mt-1 truncate text-sm text-muted">Expected: {c.referenceAnswer}</p>}
                    {bits.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{bits.map((b) => <Tag key={b}>{b}</Tag>)}</div>}
                  </div>
                  <Button variant="danger" size="xs" icon="trash" onClick={() => remove(c)} aria-label={`Delete test case ${i + 1}`}>Delete</Button>
                </li>
              );
            })}
          </ol>
        )}
        {next && <div className="border-t border-line p-3 text-center"><Button variant="ghost" size="sm" onClick={() => load(next)}>Load more</Button></div>}
      </Card>

      <Dialog
        open={dialog === 'import'} onClose={close} size="lg" title="Import test cases" description="Paste JSON or CSV, or choose a file."
        onSubmit={impResult ? (e) => { e.preventDefault(); close(); } : doImport}
        footer={impResult ? <Button type="submit">Done</Button> : <><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" disabled={!imp.content.trim()}>Import</Button></>}
      >
        {impResult ? (
          <Notice tone="success" title={`Imported ${impResult.imported} case(s)${impResult.rejected ? `, skipped ${impResult.rejected}` : ''}`}>
            {impResult.secretsRedacted ? <p>{impResult.secretsRedacted} secret-looking value(s) were redacted.</p> : null}
            {impResult.ignoredColumns?.length > 0 && <p>Ignored columns: {impResult.ignoredColumns.join(', ')}.</p>}
          </Notice>
        ) : (
          <div className="space-y-4">
            <ErrorBox error={error} />
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Format" className="w-32"><Select value={imp.format} onChange={(e) => setImp({ ...imp, format: e.target.value })}><option value="json">JSON</option><option value="csv">CSV</option></Select></Field>
              <Field label="Or choose a file"><input type="file" accept=".json,.csv,text/csv,application/json" onChange={onFile} className="block text-sm text-muted file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink hover:file:bg-sunken" /></Field>
              <Button variant="ghost" size="sm" onClick={() => setImp({ ...imp, format: 'json', content: SAMPLE })}>Insert a sample</Button>
            </div>
            <Textarea rows={9} value={imp.content} onChange={(e) => setImp({ ...imp, content: e.target.value })} aria-label="Cases to import" placeholder='[{"input": "question", "referenceAnswer": "expected answer"}]' />
            <Checkbox checked={imp.allowPartial} onChange={(e) => setImp({ ...imp, allowPartial: e.target.checked })}>Import the valid rows even if some rows have problems</Checkbox>
            <p className="text-xs text-muted">CSV columns: input (required), referenceAnswer, referenceEvidence (separate items with ||), requiredElements (||), expectedToolCalls (JSON), constraints (JSON), tags.</p>
          </div>
        )}
      </Dialog>

      <Dialog
        open={dialog === 'add'} onClose={close} size="lg" title="Add a test case" onSubmit={addCase}
        footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit">Add test case</Button></>}
      >
        <div className="space-y-4">
          <ErrorBox error={error} />
          <Field label="Input (what the user asks)"><Textarea rows={2} value={form.input} onChange={(e) => setForm({ ...form, input: e.target.value })} required /></Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Reference answer (optional)"><Textarea rows={3} value={form.referenceAnswer} onChange={(e) => setForm({ ...form, referenceAnswer: e.target.value })} /></Field>
            <Field label="Required elements (optional)" hint="One per line."><Textarea rows={3} value={form.requiredElements} onChange={(e) => setForm({ ...form, requiredElements: e.target.value })} /></Field>
            <Field label="Reference evidence (optional)" hint="Leave a blank line between documents." className="md:col-span-2"><Textarea rows={3} value={form.referenceEvidence} onChange={(e) => setForm({ ...form, referenceEvidence: e.target.value })} /></Field>
          </div>
          <details className="rounded-lg border border-line p-3 text-sm">
            <summary className="cursor-pointer font-medium">Advanced: expected tool calls and output constraints (JSON)</summary>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <Field label="Expected tool calls" hint='e.g. [{"name":"search","args":{"maxPrice":50000}}]'><Textarea rows={3} value={form.toolCalls} onChange={(e) => setForm({ ...form, toolCalls: e.target.value })} /></Field>
              <Field label="Constraints" hint='e.g. {"maxChars":200,"mustInclude":["refund"]}'><Textarea rows={3} value={form.constraints} onChange={(e) => setForm({ ...form, constraints: e.target.value })} /></Field>
            </div>
          </details>
        </div>
      </Dialog>
    </div>
  );
}
