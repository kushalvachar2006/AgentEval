import { AppError } from '../../middleware/errors.js';
import { sanitize } from '../../lib/redact.js';

const preview = (v) => (typeof v === 'string' ? v : JSON.stringify(v) ?? '').slice(0, 200);
const sumUsage = (spans) => {
  let i = 0, o = 0, t = 0, any = false;
  for (const s of spans) {
    const u = s.type === 'llm' ? s.llm?.usage : null;
    if (!u) continue;
    any = true;
    i += u.inputTokens ?? 0; o += u.outputTokens ?? 0; t += u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  }
  return any ? { inputTokens: i, outputTokens: o, totalTokens: t } : undefined;
};

// Turns an already-validated trace into the document stored in MongoDB.
export function buildTraceDoc(trace, { organizationId, retentionDays, maxBytes, now = new Date() }) {
  const { value: t, redactions, truncated, keysRewritten } = sanitize(trace);
  const size = Buffer.byteLength(JSON.stringify(t));
  if (size > maxBytes) throw new AppError(413, 'TRACE_TOO_LARGE', `Trace is ${size} bytes after sanitising; the limit is ${maxBytes}`);

  const spans = t.spans;
  const startedAt = new Date(t.startedAt);
  const endedAt = new Date(t.endedAt);
  return {
    organizationId,
    agentId: t.agentId,
    traceId: t.traceId,
    schemaVersion: t.schemaVersion,
    sessionId: t.sessionId,
    agentVersion: t.agentVersion,
    environment: t.environment ?? 'production',
    framework: t.framework,
    status: t.status,
    startedAt,
    endedAt,
    durationMs: t.durationMs ?? endedAt - startedAt,
    input: t.input,
    output: t.output,
    error: t.error,
    usage: t.usage ?? sumUsage(spans),
    spans,
    metadata: t.metadata,
    spanCount: spans.length,
    llmCallCount: spans.filter((s) => s.type === 'llm').length,
    toolCallCount: spans.filter((s) => s.type === 'tool').length,
    hasError: t.status === 'error' || spans.some((s) => s.status === 'error'),
    isDemo: t.metadata?.demo === true, // demo/sample data is always marked so it can be told apart and filtered out
    inputPreview: preview(t.input),
    outputPreview: preview(t.output),
    sanitization: { redactions, truncated, keysRewritten },
    ingestedAt: now,
    expiresAt: new Date(now.getTime() + retentionDays * 86_400_000),
  };
}
