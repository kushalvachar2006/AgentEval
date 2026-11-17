import { useEffect, useState } from 'react';
import { api, fmtTime } from '../api.js';
import Icon from '../components/Icon.jsx';
import SpanTree from '../components/SpanTree.jsx';
import { Button, Card, Code, ErrorBox, PageHeader, Pill, Skeleton, Tag, cx, linkCls } from '../components/ui.jsx';

const SEVERITY = { error: ['danger', 'Error'], warning: ['warning', 'Warning'], info: ['neutral', 'Info'] };
const CERTAINTY = {
  observed: ['neutral', 'Observed: a fact recorded in the trace'],
  likely: ['warning', 'Likely: a rule-based cross-check with strong evidence'],
  possible: ['neutral', 'Possible: a lead worth checking, not proof'],
};
const VERDICT = {
  failed: ['border-danger-fg/25 bg-danger-bg', 'text-danger-fg', 'x-circle', 'Problems found'],
  suspicious: ['border-warning-fg/25 bg-warning-bg', 'text-warning-fg', 'warning', 'Suspicious'],
  clean: ['border-success-fg/25 bg-success-bg', 'text-success-fg', 'check-circle', 'Nothing found'],
  unknown: ['border-line bg-sunken', 'text-muted', 'info', 'Not analysed'],
};
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function Finding({ f, selected, onSelect }) {
  const [sevTone, sevLabel] = SEVERITY[f.severity] ?? SEVERITY.info;
  const [certTone, tip] = CERTAINTY[f.certainty] ?? CERTAINTY.possible;
  const metrics = f.affectedMetrics?.length ? f.affectedMetrics : [];
  return (
    <li className={cx('rounded-panel border bg-surface p-4', selected ? 'border-danger-dot ring-2 ring-danger-dot/20' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={sevTone}>{sevLabel}</Pill>
        <Tag tone={certTone} title={tip}>{f.certainty}</Tag>
        <h3 className="font-semibold">{f.title}</h3>
      </div>
      <p className="mt-2 text-sm">{f.explanation}</p>
      {f.claim && <p className="mt-3 rounded-md bg-sunken p-2.5 text-sm"><span className="text-muted">Answer says: </span>“{f.claim}”</p>}
      {f.evidence?.slice(0, 2).map((e, i) => (
        <p key={i} className="mt-2 rounded-md bg-info-bg p-2.5 text-xs"><strong className="text-info-fg">Evidence{e.source ? ` (${e.source})` : ''}:</strong> {e.text}</p>
      ))}
      {f.path?.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1 text-xs">
          <span className="mr-1 text-muted">Where</span>
          {f.path.map((p, i) => (
            <span key={p.spanId} className="flex items-center gap-1">
              {i > 0 && <Icon name="chevron-right" size={12} className="text-faint" />}
              <button type="button" onClick={() => onSelect(p.spanId)} className="rounded bg-sunken px-1.5 py-0.5 font-medium hover:bg-line">{p.name}</button>
            </span>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
        {metrics.length > 0 ? <><span>Affected metrics</span>{metrics.map((m) => <Tag key={m} tone="danger">{m}</Tag>)}</>
          : f.potentialMetrics?.length > 0 ? <><span>Could affect (once evaluated)</span>{f.potentialMetrics.map((m) => <Tag key={m}>{m}</Tag>)}</> : null}
        {f.spanId && <button type="button" onClick={() => onSelect(f.spanId)} className={cx(linkCls, 'ml-auto text-sm')}>Show this step</button>}
      </div>
    </li>
  );
}

export default function DebugView({ id }) {
  const [trace, setTrace] = useState(null);
  const [dbg, setDbg] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    setTrace(null); setDbg(null); setError(null);
    api(`/traces/${id}`).then(setTrace).catch(setError);
    api(`/traces/${id}/debug`).then(setDbg).catch(setError);
  }, [id]);
  useEffect(() => { if (selected) document.getElementById(`span-${selected}`)?.scrollIntoView({ block: 'center' }); }, [selected]);

  if (error) return <div className="space-y-4"><ErrorBox error={error} /><Button variant="secondary" href="#/traces" icon="arrow-left">Back to traces</Button></div>;
  const [vBox, vText, vIcon, vLabel] = VERDICT[dbg?.verdict] ?? VERDICT.unknown;

  return (
    <div className="space-y-6">
      <PageHeader breadcrumbs={[['Traces', '#/traces'], ['Trace', `#/traces/${id}`], ['Debug']]} title="Why did this run go wrong?" description="Findings are listed most serious first. Each one points to the step it came from." />
      {!dbg ? <div role="status" aria-label="Analysing trace"><Skeleton className="h-28" /></div> : (
        <>
          <div className={cx('flex gap-4 rounded-panel border p-5', vBox)}>
            <Icon name={vIcon} size={22} className={cx('mt-0.5', vText)} />
            <div className="min-w-0">
              <p className={cx('text-sm font-semibold', vText)}>{vLabel}</p>
              <p className="mt-0.5 text-lg font-semibold">{dbg.headline}</p>
              {dbg.failedMetrics?.length > 0 && <p className="mt-2 text-sm">Failed evaluation metrics for this trace: {[...new Set(dbg.failedMetrics.map((m) => m.metric))].join(', ')}</p>}
              {dbg.evaluation?.length > 0 && <p className="mt-1 text-sm">Part of evaluation run(s): {dbg.evaluation.map((e) => <a key={e.runId + e.testCaseId} className={cx(linkCls, 'mr-3')} href={`#/runs/${e.runId}`}>{e.runId.slice(-6)} ({e.status})</a>)}</p>}
            </div>
          </div>
          {dbg.findings.length > 0 && (
            <section aria-labelledby="findings-h">
              <h2 id="findings-h" className="mb-3 text-base font-semibold">Findings</h2>
              <ul className="space-y-3">{dbg.findings.map((f) => <Finding key={f.id} f={f} selected={selected === f.spanId} onSelect={setSelected} />)}</ul>
            </section>
          )}
          <div className="rounded-lg border border-warning-fg/25 bg-warning-bg p-4 text-sm">
            <p className="font-semibold text-warning-fg">Read this before acting on the findings</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">{dbg.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </div>
        </>
      )}
      {trace && (
        <Card title="Execution steps" description={`Started ${fmtTime(trace.startedAt)}`}>
          <div className="mb-5 grid gap-4 md:grid-cols-2">
            <div><p className="mb-1.5 text-xs font-medium text-muted">User input</p><Code>{show(trace.input)}</Code></div>
            <div><p className="mb-1.5 text-xs font-medium text-muted">Final output</p><Code>{show(trace.output)}</Code></div>
          </div>
          <SpanTree spans={trace.spans} highlightId={selected} onSelect={setSelected} />
        </Card>
      )}
    </div>
  );
}
