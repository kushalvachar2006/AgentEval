from __future__ import annotations

from ..judge import quote_in_text, wrap
from ..text import close, containment, content_tokens, normalize, number_infos
from .base import EvalContext, Evaluator, judge_json, to_float01


def _element(e):
    if isinstance(e, str):
        return {"text": e, "alternatives": []}
    if isinstance(e, dict) and isinstance(e.get("text"), str):
        return {"text": e["text"], "alternatives": [a for a in e.get("alternatives", []) if isinstance(a, str)]}
    raise ValueError("requiredElements entries must be strings or {text, alternatives}")


def covers(text: str, answer: str) -> bool:
    if normalize(text) in normalize(answer):
        return True
    want = number_infos(text)
    got = number_infos(answer)
    if want and not all(any(close(w.value, g.value) for g in got) for w in want):
        return False
    tokens = content_tokens(text)
    return containment(tokens, content_tokens(answer)) >= (0.8 if tokens else 0.0) if tokens else bool(want)


class Completeness(Evaluator):
    metric, version = "completeness", "1.0.0"
    description = "Are all required elements (key facts, steps, fields) present in the answer?"
    requires = ("requiredElements",)
    uses_judge = True
    default_threshold = 0.8

    def evaluate(self, ctx: EvalContext):
        raw = list(ctx.test_case.get("requiredElements") or []) + list(ctx.config.get("elements") or [])
        elements = [_element(e) for e in raw]
        ans = ctx.output_text
        if not elements:
            return self.inconclusive("No required elements defined on the test case.")
        found = [any(covers(t, ans) for t in [e["text"], *e["alternatives"]]) for e in elements]
        by_judge = [False] * len(elements)
        missing = [i for i, ok in enumerate(found) if not ok]
        if missing and ans.strip():
            listing = "\n".join(f"{n}. {elements[i]['text']}" for n, i in enumerate(missing))
            v = judge_json(ctx, (
                "For each numbered ELEMENT decide whether the ANSWER covers it (paraphrase is fine). If covered, include `quote`: an exact quote (8+ chars) from the ANSWER. "
                'Reply as {"elements":[{"index":0,"covered":true,"quote":"..."}]}\n\n' f"{wrap('ANSWER', ans[:8000])}\n{wrap('ELEMENTS', listing)}"))
            for item in (v or {}).get("elements", []) if isinstance((v or {}).get("elements"), list) else []:
                try:
                    i = missing[int(item["index"])]
                except (KeyError, ValueError, IndexError, TypeError):
                    continue
                if item.get("covered") is True and quote_in_text(item.get("quote"), ans):
                    found[i] = by_judge[i] = True
        n_ok = sum(found)
        findings = [{"element": e["text"], "covered": ok, "method": "judge" if by_judge[i] else "rule"} for i, (e, ok) in enumerate(zip(elements, found))]
        judge_tried = bool(missing) and ctx.use_judge
        conf = 0.85 if (n_ok == len(elements) or judge_tried) else 0.7 if n_ok else 0.75
        return self.finish(ctx, score=n_ok / len(elements), confidence=conf, explanation=f"{n_ok} of {len(elements)} required element(s) covered.", findings=findings,
                           meta={"judgeUsed": judge_tried})
