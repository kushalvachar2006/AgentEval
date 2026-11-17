import { useEffect, useState } from 'react';
import { api, fmtDuration, fmtTime } from '../api.js';
import SpanTree from '../components/SpanTree.jsx';
import { Button, Card, Code, ErrorBox, Meta, Notice, PageHeader, Pill, Skeleton, Stat, StatStrip, Tag, linkCls } from '../components/ui.jsx';

const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

export default function TraceDetail({ id }) {
  const [trace, setTrace] = useState(null);
  const [error, setError] = useState(null);
  const [raw, setRaw] = useState(false);
  useEffect(() => { api(`/traces/${id}`).then(setTrace).catch(setError); }, [id]);

  if (error) return <div className="space-y-4"><ErrorBox error={error} /><Button variant="secondary" href="#/traces" icon="arrow-left">Back to traces</Button></div>;
  if (!trace) return <div className="space-y-4" role="status" aria-label="Loading trace"><Skeleton className="h-16" /><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;
  const s = trace.sanitization;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[['Traces', '#/traces'], [`Trace ${trace.traceId.slice(-8)}`]]} title="Trace"
        badge={<span className="flex items-center gap-2"><Pill>{trace.status}</Pill>{trace.isDemo && <Tag tone="warning">demo data</Tag>}</span>}
        actions={<Button href={`#/debug/${trace.traceId}`} icon="bug">Debug this trace</Button>}
      >
        <Meta><code className="break-all text-xs">{trace.traceId}</code><a className={linkCls} href={`#/agents/${trace.agentId}`}>View agent</a></Meta>
      </PageHeader>

      <StatStrip className="grid-cols-2 lg:grid-cols-4">
        <Stat compact label="Started" value={fmtTime(trace.startedAt)} />
        <Stat compact label="Duration" value={fmtDuration(trace.durationMs)} />
        <Stat compact label="Tokens" value={trace.usage?.totalTokens?.toLocaleString() ?? '—'} />
        <Stat compact label="Steps" value={trace.spanCount} hint={`${trace.llmCallCount} LLM, ${trace.toolCallCount} tool`} />
      </StatStrip>

      {s && (s.redactions > 0 || s.truncated > 0) && <Notice tone="info">Privacy protections applied: {s.redactions} secret value(s) redacted, {s.truncated} oversized value(s) truncated.</Notice>}
      {trace.error && <ErrorBox error={{ message: `${trace.error.type ?? 'Error'}: ${trace.error.message}` }} />}

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="User input"><Code>{show(trace.input ?? '—')}</Code></Card>
        <Card title="Final output"><Code>{show(trace.output ?? '—')}</Code></Card>
      </div>
      <Card title="Execution steps" description="Click a step to see what went in and out. The bar shows its time relative to the slowest step." action={<Button variant="secondary" size="sm" onClick={() => setRaw(!raw)}>{raw ? 'Show steps' : 'Show raw JSON'}</Button>}>
        {raw ? <Code wrap={false} className="max-h-[40rem]">{JSON.stringify(trace, null, 2)}</Code> : <SpanTree spans={trace.spans} />}
      </Card>
    </div>
  );
}
