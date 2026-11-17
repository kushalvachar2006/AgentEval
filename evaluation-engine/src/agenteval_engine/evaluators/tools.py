from __future__ import annotations

import json
from typing import Any

from ..claims import Claim, classify_claim, extract_claims, _windows, Evidence
from ..text import close, flatten_sentences, normalize, number_infos
from .base import EvalContext, Evaluator

WEIGHTS = {"selection": 0.25, "parameters": 0.2, "execution": 0.15, "interpretation": 0.2, "sequence": 0.1, "completion": 0.1}


def _args(tool: dict) -> dict:
    v = tool.get("input")
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return {"input": v}
    return v if isinstance(v, dict) else {"input": v} if v is not None else {}


def _eq(want: Any, got: Any) -> bool:
    if isinstance(want, bool) or isinstance(got, bool):
        return want is got
    if isinstance(want, (int, float)) and isinstance(got, (int, float)):
        return close(float(want), float(got), rel=1e-6)
    if isinstance(want, str) and isinstance(got, str):
        return normalize(want) == normalize(got)
    if isinstance(want, dict) and isinstance(got, dict):
        return all(k in got and _eq(v, got[k]) for k, v in want.items())
    if isinstance(want, list) and isinstance(got, list):
        return len(want) == len(got) and all(_eq(a, b) for a, b in zip(want, got))
    return want == got


class ToolUsage(Evaluator):
    metric, version = "tool_usage", "1.0.0"
    description = "Tool selection, parameters, execution results, interpretation of tool output, sequencing and task completion (deterministic)."
    requires = ("expectedToolCalls",)
    default_threshold = 0.8

    def evaluate(self, ctx: EvalContext):
        calls = [s for s in ctx.spans if s.get("type") == "tool"]
        expected = ctx.test_case.get("expectedToolCalls") or []
        if expected and not ctx.spans:
            return self.inconclusive("The execution trace has no steps, so tool use cannot be verified.")
        if not expected and not calls:
            return self.inconclusive("No expected tool calls defined and the agent called no tools.")
        names = [(c.get("tool") or {}).get("name") or c.get("name") for c in calls]
        lname = [str(n).lower() for n in names]
        scores: dict[str, float | None] = {}
        findings: list[dict] = []
        confidence = 0.95

        required = [e for e in expected if e.get("required", True)]
        if expected:
            hit = [e for e in required if str(e["name"]).lower() in lname]
            sel = len(hit) / len(required) if required else 1.0
            exp_names = {str(e["name"]).lower() for e in expected}
            unexpected = sorted({n for n in lname if n not in exp_names})
            if ctx.config.get("forbidUnexpected") and unexpected and lname:
                sel *= max(0.0, 1 - len(unexpected) / len(set(lname)))
            scores["selection"] = sel
            for e in required:
                if str(e["name"]).lower() not in lname:
                    findings.append({"check": "selection", "ok": False, "message": f"expected tool '{e['name']}' was never called"})
            if unexpected:
                findings.append({"check": "selection", "ok": not ctx.config.get("forbidUnexpected"), "message": f"unexpected tool(s) called: {', '.join(unexpected)}"})

            with_args = [e for e in expected if e.get("args")]
            if with_args:
                part = []
                for e in with_args:
                    best, best_span = 0.0, None
                    for c, n in zip(calls, lname):
                        if n != str(e["name"]).lower():
                            continue
                        got = _args(c.get("tool") or {})
                        ok = sum(1 for k, v in e["args"].items() if k in got and _eq(v, got[k]))
                        if ok / len(e["args"]) >= best:
                            best, best_span = ok / len(e["args"]), c
                    part.append(best)
                    if best < 1.0:
                        findings.append({"check": "parameters", "ok": False, "tool": e["name"], "message": f"arguments matched {best:.0%}", "expected": e["args"],
                                         **({"spanId": best_span["spanId"], "actual": _args(best_span.get("tool") or {})} if best_span else {"actual": None})})
                scores["parameters"] = sum(part) / len(part)

            if ctx.config.get("ordered") or any("order" in e for e in expected):
                seq = [str(e["name"]).lower() for e in sorted(expected, key=lambda e: e.get("order", 0))]
                it = iter(lname)
                in_order = sum(1 for n in seq if any(n == m for m in it))   # subsequence length (greedy)
                scores["sequence"] = in_order / len(seq)
                if in_order < len(seq):
                    findings.append({"check": "sequence", "ok": False, "message": f"expected order {seq}, observed {lname}"})

        if calls:
            ok = [c for c in calls if c.get("status") == "success"]
            scores["execution"] = len(ok) / len(calls)
            for c in calls:
                if c.get("status") != "success":
                    findings.append({"check": "execution", "ok": False, "spanId": c["spanId"], "message": f"tool '{c.get('name')}' failed: {(c.get('error') or {}).get('message', 'error')}"})

            evidence = [Evidence(s, f"tool:{(c.get('tool') or {}).get('name', c.get('name'))}", c["spanId"]) for c in ok for s in flatten_sentences((c.get("tool") or {}).get("output"))]
            claims = [c for c in extract_claims(ctx.output_text) if c.checkable]
            if evidence and claims:
                windows = _windows(evidence)
                inp = [n.value for n in number_infos(ctx.input_text)]
                res = [classify_claim(c, windows, inp, {}) for c in claims]
                bad = [r for r in res if r["classification"] == "contradicted"]
                scores["interpretation"] = 1 - len(bad) / len(res)
                confidence = min(confidence, 0.85)
                for r in bad:
                    findings.append({"check": "interpretation", "ok": False, "message": f"answer contradicts tool output: {r['reason']}", "claim": r["claim"], "evidence": r["evidence"],
                                     **({"spanId": r["evidence"][0]["spanId"]} if r["evidence"] and r["evidence"][0].get("spanId") else {})})

        done = ctx.trace.get("status") == "success" and bool(ctx.output_text.strip())
        scores["completion"] = 1.0 if done else 0.0
        if not done:
            findings.append({"check": "completion", "ok": False, "message": f"trace status '{ctx.trace.get('status')}' / empty answer"})

        applicable = {k: v for k, v in scores.items() if v is not None}
        total_w = sum(WEIGHTS[k] for k in applicable)
        score = sum(WEIGHTS[k] * v for k, v in applicable.items()) / total_w
        passed = [k for k, v in applicable.items() if v >= 1.0]
        return self.finish(ctx, score=score, confidence=confidence, explanation=f"Checks: " + ", ".join(f"{k} {v:.0%}" for k, v in applicable.items()) + ".",
                           findings=findings, meta={"subscores": {k: round(v, 3) for k, v in applicable.items()}, "toolCalls": len(calls), "fullyPassed": passed})
