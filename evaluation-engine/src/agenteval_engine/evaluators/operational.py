from __future__ import annotations

from .base import EvalContext, Evaluator


def _cost(trace: dict, pricing: dict):
    u = trace.get("usage") or {}
    if isinstance(u.get("estimatedCostUsd"), (int, float)):
        return float(u["estimatedCostUsd"]), "reported"
    total, known = 0.0, False
    for s in (x for x in trace.get("spans") or [] if isinstance(x, dict)):
        llm = s.get("llm") if s.get("type") == "llm" else None
        p = pricing.get((llm or {}).get("model")) if llm else None
        use = (llm or {}).get("usage")
        if p and use:
            total += use.get("inputTokens", 0) / 1e6 * p.get("inputPer1M", 0) + use.get("outputTokens", 0) / 1e6 * p.get("outputPer1M", 0)
            known = True
    return (total, "estimated from configured pricing") if known else (None, None)


class OperationalPerformance(Evaluator):
    metric, version = "operational", "1.0.0"
    description = "Latency, token consumption, estimated cost and errors, checked against budgets you configure. Prices are never built in - supply config.pricing."
    requires = ()
    default_threshold = 1.0

    def evaluate(self, ctx: EvalContext):
        t = ctx.trace
        tokens = (t.get("usage") or {}).get("totalTokens")
        cost, cost_src = _cost(t, ctx.config.get("pricing") or {})
        errors = (1 if t.get("status") == "error" else 0) + sum(1 for s in ctx.spans if s.get("status") == "error")
        m = {"latencyMs": t.get("durationMs"), "totalTokens": tokens, "costUsd": cost, "costSource": cost_src, "errors": errors}
        budgets = [("maxLatencyMs", "latencyMs", m["latencyMs"]), ("maxTotalTokens", "totalTokens", tokens), ("maxCostUsd", "costUsd", cost), ("maxErrors", "errors", errors)]
        checks = []
        for key, label, val in budgets:
            if key in ctx.config:
                if val is None:
                    checks.append({"check": label, "ok": None, "message": f"{label} not measurable for this trace"})
                else:
                    checks.append({"check": label, "ok": val <= ctx.config[key], "message": f"{label} {val} (budget {ctx.config[key]})"})
        measurable = [c for c in checks if c["ok"] is not None]
        if not measurable:
            return self.inconclusive("No budgets configured (or none measurable); measurements are recorded in meta.", {"measurements": m})
        n_ok = sum(1 for c in measurable if c["ok"])
        return self.finish(ctx, score=n_ok / len(measurable), confidence=0.98, explanation=f"{n_ok} of {len(measurable)} budget(s) met.", findings=checks, meta={"measurements": m})
