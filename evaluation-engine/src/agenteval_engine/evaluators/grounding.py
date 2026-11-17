from __future__ import annotations

from ..claims import analyze
from .base import EvalContext, Evaluator, cfg_num


def _summary(findings):
    c = {k: 0 for k in ("supported", "contradicted", "unsupported", "unverifiable")}
    for f in findings:
        c[f["classification"]] += 1
    return c


class _ClaimEvaluator(Evaluator):
    uses_judge = True

    def _prepare(self, ctx: EvalContext):
        a = analyze(ctx, ctx.config)
        if not a["evidence"]:
            return a, self.inconclusive("No evidence available (no reference evidence, retrieved documents or tool outputs) to check the claims against.")
        if not a["claims"]:
            return a, self.inconclusive("The answer contains no statements to check.")
        return a, None

    @staticmethod
    def _confidence(findings):
        checked = [f for f in findings if f["classification"] != "unverifiable"]
        return sum(f["confidence"] for f in checked) / len(checked) if checked else None


class Hallucination(_ClaimEvaluator):
    metric, version = "hallucination", "1.0.0"
    description = "Claim-level check: supported / contradicted / unsupported / unverifiable. Score = 1 - (contradicted + w*unsupported)/checked claims."
    requires = ("referenceEvidence", "referenceAnswer")
    default_threshold = 0.8

    def evaluate(self, ctx: EvalContext):
        a, early = self._prepare(ctx)
        if early:
            return early
        f = a["findings"]
        counts = _summary(f)
        checked = len(f) - counts["unverifiable"]
        meta = {"counts": counts, "judgeUsed": a["judgeUsed"], "evidenceItems": len(a["evidence"])}
        if checked == 0:
            return self.inconclusive("The answer makes no checkable factual claims (only opinions, questions or filler), so hallucination cannot be assessed.", meta)
        w = cfg_num(ctx.config, "unsupportedWeight", 0.5)  # an unsupported claim is NOT automatically false
        score = 1 - (counts["contradicted"] + w * counts["unsupported"]) / checked
        bits = [f"{counts[k]} {k}" for k in ("contradicted", "unsupported", "supported") if counts[k]]
        return self.finish(ctx, score=score, confidence=self._confidence(f), explanation=f"{checked} checkable claim(s): {', '.join(bits)}.", findings=f, meta=meta)


class Groundedness(_ClaimEvaluator):
    metric, version = "groundedness", "1.0.0"
    description = "Share of checkable claims that the supplied context / retrieved documents / tool outputs support."
    requires = ("referenceEvidence",)
    default_threshold = 0.7

    def evaluate(self, ctx: EvalContext):
        a, early = self._prepare(ctx)
        if early:
            return early
        f = a["findings"]
        counts = _summary(f)
        checked = len(f) - counts["unverifiable"]
        meta = {"counts": counts, "judgeUsed": a["judgeUsed"], "evidenceItems": len(a["evidence"])}
        if checked == 0:
            return self.inconclusive("The answer makes no checkable factual claims.", meta)
        return self.finish(ctx, score=counts["supported"] / checked, confidence=self._confidence(f),
                           explanation=f"{counts['supported']} of {checked} checkable claim(s) are supported by the evidence.", findings=f, meta=meta)
