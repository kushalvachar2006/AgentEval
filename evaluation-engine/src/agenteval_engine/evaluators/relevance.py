from __future__ import annotations

import re

from ..judge import wrap
from ..text import containment, content_tokens
from .base import EvalContext, Evaluator, judge_json, to_float01

_REFUSAL = re.compile(r"^\s*(i (?:don't|do not|can't|cannot|am unable to|'m unable to|have no)\b|sorry,? (?:i|but)|as an ai\b|i'm sorry)", re.I)


class Relevance(Evaluator):
    metric, version = "relevance", "1.0.0"
    description = "Does the answer address the request? Lexical signals are only reliable at the extremes; enable the judge for a dependable score."
    requires = ()
    uses_judge = True
    default_threshold = 0.6

    def evaluate(self, ctx: EvalContext):
        ans, req = ctx.output_text.strip(), ctx.input_text
        if not req.strip():
            return self.inconclusive("No user request available.")
        if not ans:
            return self.finish(ctx, score=0.0, confidence=0.95, explanation="Empty answer.", findings=[{"check": "empty_answer"}])
        verdict = judge_json(ctx, (
            "Rate how well the RESPONSE addresses the REQUEST (0 = unrelated/refuses, 1 = directly addresses it). Judge relevance only, not correctness. "
            f"{('Expected behavior: ' + str(ctx.test_case['expectedBehavior'])) if ctx.test_case.get('expectedBehavior') else ''}\n"
            'Reply as {"score":0.0-1.0,"off_topic":true|false,"reason":"..."}\n\n'
            f"{wrap('REQUEST', req)}\n{wrap('RESPONSE', ans[:6000])}"))
        js = to_float01((verdict or {}).get("score"))
        if js is not None:
            return self.finish(ctx, score=js, confidence=0.85, explanation=str(verdict.get("reason", "Judged by LLM."))[:300],
                               findings=[{"check": "judge", "offTopic": bool(verdict.get("off_topic")), "score": js}], meta={"method": "judge"})
        if _REFUSAL.match(ans):
            return self.finish(ctx, score=0.1, confidence=0.7, explanation="The answer is a refusal / non-answer.", findings=[{"check": "refusal"}], meta={"method": "lexical"})
        cov = containment(content_tokens(req), content_tokens(ans))
        ref = ctx.test_case.get("referenceAnswer")
        ref_cov = containment(content_tokens(ref), content_tokens(ans)) if ref else 0.0
        signal = max(cov, ref_cov)
        score = min(1.0, 0.35 + 0.65 * signal) if signal > 0 else 0.3
        conf = 0.7 if signal >= 0.5 else 0.4  # weak lexical evidence -> low confidence -> usually "inconclusive"
        return self.finish(ctx, score=score, confidence=conf, explanation=f"Lexical overlap with the request/reference is {signal:.0%}; no judge available.",
                           findings=[{"check": "lexical_overlap", "requestCoverage": round(cov, 2), "referenceCoverage": round(ref_cov, 2)}], meta={"method": "lexical"})
