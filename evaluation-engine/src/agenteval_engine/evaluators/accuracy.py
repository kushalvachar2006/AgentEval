from __future__ import annotations

import re

from ..judge import wrap
from ..text import close, content_tokens, containment, f1, normalize, number_infos, numbers
from .base import EvalContext, Evaluator, cfg_num, judge_json, to_float01

_ONLY_NUMBER = re.compile(r"^[\s₹$€£¥]*[-+]?\d[\d,]*(?:\.\d+)?\s*(?:%|k|lakhs?|crores?|million|billion)?\s*[.]?\s*$", re.I)


class Accuracy(Evaluator):
    metric, version = "accuracy", "1.0.0"
    description = "Compares the answer with the reference answer: exact match, numeric validation, or semantic similarity (+ optional judge)."
    requires = ("referenceAnswer",)
    uses_judge = True
    default_threshold = 0.8

    def evaluate(self, ctx: EvalContext):
        ref = ctx.test_case.get("referenceAnswer")
        if ref in (None, ""):
            return self.inconclusive("No reference answer on the test case.")
        ans, mode = ctx.output_text, ctx.config.get("mode", "auto")
        if mode not in ("auto", "exact", "numeric", "semantic"):
            raise ValueError("config.mode must be auto, exact, numeric or semantic")
        if not ans.strip():
            return self.finish(ctx, score=0.0, confidence=0.95, explanation="The agent produced no answer.", findings=[{"check": "empty_answer"}])
        if mode == "auto":
            mode = "numeric" if _ONLY_NUMBER.match(str(ref)) else "exact" if len(str(ref).split()) <= 3 else "semantic"
        return {"exact": self._exact, "numeric": self._numeric, "semantic": self._semantic}[mode](ctx, str(ref), ans)

    def _exact(self, ctx, ref, ans):
        ok = normalize(ref).strip(" .") == normalize(ans).strip(" .")
        return self.finish(ctx, score=1.0 if ok else 0.0, confidence=0.99, explanation="Exact match." if ok else "Answer differs from the reference.",
                           findings=[{"check": "exact", "expected": ref, "actual": ans[:300]}], meta={"mode": "exact"})

    def _numeric(self, ctx, ref, ans):
        tol = cfg_num(ctx.config, "tolerance", 0.01, 0.0, 1.0)
        want, got = numbers(ref), numbers(ans)
        if not want:
            return self.inconclusive("Reference answer contains no number to validate.")
        hits = [any(close(w, g, rel=max(tol, 1e-9)) for g in got) for w in want]
        score = sum(hits) / len(want)
        findings = [{"check": "numeric", "expected": w, "found": ok, "answerNumbers": got[:10]} for w, ok in zip(want, hits)]
        return self.finish(ctx, score=score, confidence=0.95, explanation=f"{sum(hits)} of {len(want)} expected number(s) found within {tol:.1%}.", findings=findings, meta={"mode": "numeric"})

    def _semantic(self, ctx, ref, ans):
        rt, at = content_tokens(ref), content_tokens(ans)
        recall, f = containment(rt, at), f1(at, rt)
        lexical = 0.6 * recall + 0.4 * f
        findings = [{"check": "lexical", "recall": round(recall, 2), "f1": round(f, 2)}]
        want = number_infos(ref)
        if want and not all(any(close(w.value, g.value) for g in number_infos(ans)) for w in want):
            lexical = min(lexical, 0.4)  # a reference number that is missing/different caps the score
            findings.append({"check": "numbers_missing", "expected": [w.value for w in want], "found": [g.value for g in number_infos(ans)][:10]})
        score, conf, method = lexical, 0.55, "lexical"
        verdict = judge_json(ctx, (
            "Decide whether the CANDIDATE answers the question correctly, using the REFERENCE as the truth. Paraphrases are fine; wrong facts, numbers or "
            "missing key facts are not. Reply as {\"verdict\":\"correct|partially_correct|incorrect\",\"score\":0.0-1.0,\"reason\":\"...\"}\n\n"
            f"{wrap('QUESTION', ctx.input_text)}\n{wrap('REFERENCE', ref)}\n{wrap('CANDIDATE', ans)}"))
        js = to_float01((verdict or {}).get("score"))
        if js is not None:
            score = 0.7 * js + 0.3 * lexical
            conf, method = (0.85 if abs(js - lexical) < 0.3 else 0.65), "judge+lexical"
            findings.append({"check": "judge", "verdict": str(verdict.get("verdict", ""))[:30], "score": js, "reason": str(verdict.get("reason", ""))[:300]})
        return self.finish(ctx, score=score, confidence=conf, explanation=f"Semantic comparison ({method}).", findings=findings, meta={"mode": "semantic", "method": method})
