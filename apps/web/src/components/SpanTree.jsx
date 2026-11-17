import { useEffect, useMemo, useState } from 'react';
import { fmtDuration } from '../api.js';
import { humanize } from '../hooks.js';
import Icon from './Icon.jsx';
import { Code, Pill, Tag, cx } from './ui.jsx';

const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const TYPE_TONE = { agent: 'brand', llm: 'info' };

export function buildTree(spans = []) {
  const children = new Map();
  const roots = [];
  for (const s of spans) { if (!s.parentSpanId) roots.push(s); else children.set(s.parentSpanId, [...(children.get(s.parentSpanId) ?? []), s]); }
  return { roots, children };
}
const contains = (span, children, id) => span.spanId === id || (children.get(span.spanId) ?? []).some((k) => contains(k, children, id));

// How long a step took relative to the slowest step in the trace: a quick way to spot where the time went.
function DurationBar({ ms, max, failed }) {
  const width = ms && max ? Math.max(3, Math.min(100, (ms / max) * 100)) : 0;
  return (
    <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-sunken sm:block" aria-hidden="true">
      <span className={cx('block h-full rounded-full', failed ? 'bg-danger-dot' : 'bg-brand/70')} style={{ width: `${width}%` }} />
    </span>
  );
}

function Node({ span, children, depth, highlightId, onSelect, maxMs }) {
  const kids = children.get(span.spanId) ?? [];
  const holdsHighlight = Boolean(highlightId) && contains(span, children, highlightId);
  const [open, setOpen] = useState(depth < 1 || holdsHighlight);
  useEffect(() => { if (holdsHighlight) setOpen(true); }, [holdsHighlight]);
  const detail = Object.entries({ input: span.input, output: span.output, llm: span.llm, tool: span.tool, retriever: span.retriever, error: span.error, metadata: span.metadata }).filter(([, v]) => v !== undefined);
  const isTarget = span.spanId === highlightId;
  const failed = span.status === 'error';
  return (
    <li id={`span-${span.spanId}`}>
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className={cx('rounded-lg border bg-surface', isTarget ? 'border-danger-dot ring-2 ring-danger-dot/20' : 'border-line')}>
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg px-3 py-2.5 text-sm hover:bg-sunken/50">
          <Icon name="chevron-right" size={14} className={cx('text-muted transition-transform', open && 'rotate-90')} />
          <Tag tone={TYPE_TONE[span.type] ?? 'neutral'}>{span.type}</Tag>
          <span className="min-w-0 break-all font-medium">{span.name}</span>
          <Pill>{span.status}</Pill>
          {isTarget && <Tag tone="danger">Suspicious step</Tag>}
          {span.llm?.model && <span className="text-xs text-muted">{span.llm.model}{span.llm.usage ? `, ${span.llm.usage.totalTokens} tokens` : ''}</span>}
          <span className="ml-auto flex items-center gap-3">
            <DurationBar ms={span.durationMs} max={maxMs} failed={failed} />
            <span className="w-16 text-right text-xs tabular-nums text-muted">{fmtDuration(span.durationMs)}</span>
          </span>
        </summary>
        <div className="space-y-3 border-t border-line p-3">
          {detail.length ? detail.map(([k, v]) => (
            <div key={k}><p className="mb-1 text-xs font-medium text-muted">{humanize(k)}</p><Code>{show(v)}</Code></div>
          )) : <p className="text-xs text-muted">No captured details.</p>}
          {kids.length > 0 && (
            <ul className="space-y-2 border-l-2 border-line pl-3">
              {kids.map((k) => <Node key={k.spanId} span={k} children={children} depth={depth + 1} highlightId={highlightId} onSelect={onSelect} maxMs={maxMs} />)}
            </ul>
          )}
        </div>
      </details>
    </li>
  );
}

export default function SpanTree({ spans, highlightId, onSelect }) {
  const { roots, children } = useMemo(() => buildTree(spans), [spans]);
  const maxMs = useMemo(() => Math.max(0, ...(spans ?? []).map((s) => s.durationMs ?? 0)), [spans]);
  if (!roots.length) return <p className="text-sm text-muted">This trace has no recorded steps.</p>;
  return <ul className="space-y-2">{roots.map((r) => <Node key={r.spanId} span={r} children={children} depth={0} highlightId={highlightId} onSelect={onSelect} maxMs={maxMs} />)}</ul>;
}
