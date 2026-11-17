import { AppError } from '../middleware/errors.js';
import { requirePermission } from '../lib/rbac.js';
import { UpstreamError } from '../lib/upstream.js';

// Debugging engine front door: loads the trace + any evaluation results about it (tenant-scoped), asks the Python engine to analyse.
export function createDebugService({ repos, engine }) {
  return {
    async debug(principal, traceId) {
      requirePermission(principal, 'traces:read');
      const org = principal.organizationId;
      const trace = /^[0-9a-f]{32}$/.test(traceId) ? await repos.traces.get(org, traceId) : null;
      if (!trace) throw new AppError(404, 'TRACE_NOT_FOUND', 'Trace not found');
      const results = await repos.results.byTraceId(org, traceId);
      const evaluation = results.map((r) => ({ runId: r.runId, testCaseId: r.testCaseId, status: r.status, evaluatedAt: r.evaluatedAt }));
      try {
        const analysis = await engine.debug({
          trace: { traceId: trace.traceId, status: trace.status, input: trace.input, output: trace.output, error: trace.error, durationMs: trace.durationMs, usage: trace.usage, spans: trace.spans },
          results: results.map((r) => ({ runId: r.runId, testCaseId: r.testCaseId, status: r.status, metrics: r.metrics })),
        });
        return { engineAvailable: true, ...analysis, evaluation };
      } catch (e) {
        if (!(e instanceof UpstreamError)) throw e;
        return { engineAvailable: false, traceId, verdict: 'unknown', headline: 'The analysis engine is not reachable right now.', findings: [], failedMetrics: [], suspectedPath: [], evaluation,
          caveats: ['Start the evaluation engine (npm run dev:engine, or docker compose up -d) and refresh. The trace itself is still available.'] };
      }
    },
  };
}
