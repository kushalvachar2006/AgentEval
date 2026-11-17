"""Debugging engine: explains WHERE and (tentatively) WHY an agent run went wrong, from the recorded trace alone.

Honesty rules:
  * every finding says how sure we are: `observed` (a fact in the trace, e.g. a step raised an error),
    `likely` (a rule-based cross-check with strong evidence), `possible` (a heuristic lead);
  * a suspicious step is a lead, never a proven root cause - the response always carries caveats saying so;
  * nothing is inferred about hidden reasoning; only recorded steps, inputs and outputs are used.
"""
from __future__ import annotations

import json
from typing import Any, Optional

from .claims import _windows, classify_claim, collect_evidence, extract_claims
from .text import as_text, normalize, number_infos

_SEV = {"error": 0, "warning": 1, "info": 2}
_CERT = {"observed": 0, "likely": 1, "possible": 2}
_POTENTIAL = {"contradiction": ["hallucination", "groundedness", "tool_usage", "accuracy"], "unsupported_claim": ["hallucination", "groundedness"],
              "span_error": ["tool_usage", "task completion"], "trace_error": ["task completion"], "swallowed_error": ["tool_usage"],
              "empty_tool_output": ["hallucination", "groundedness"], "repeated_call": ["tool_usage", "latency", "cost"], "slow_step": ["latency"]}


def _fmt(v: float) -> str:
    return f"{v:,.0f}" if float(v).is_integer() else f"{v:,.2f}".rstrip("0").rstrip(".")


def _empty(v: Any) -> bool:
    if v is None or v == "" or v == [] or v == {}:
        return True
    if isinstance(v, dict):
        return all(_empty(x) for x in v.values())
    if isinstance(v, list):
        return all(_empty(x) for x in v)
    return False


def _path(by_id: dict, span_id: Optional[str]) -> list[dict]:
    chain, seen, cur = [], set(), by_id.get(span_id) if span_id else None
    while cur and cur.get("spanId") not in seen:
        seen.add(cur["spanId"])
        chain.append({"spanId": cur["spanId"], "name": cur.get("name"), "type": cur.get("type")})
        cur = by_id.get(cur.get("parentSpanId"))
    return list(reversed(chain))


class _Findings:
    def __init__(self, by_id: dict) -> None:
        self.items: list[dict] = []
        self.by_id, self._keys = by_id, set()

    def add(self, type_: str, severity: str, certainty: str, title: str, explanation: str, *, span_id: Optional[str] = None, claim: Optional[str] = None,
            evidence: Optional[list] = None, affected: Optional[list] = None, extra: Optional[dict] = None) -> Optional[dict]:
        key = (type_, span_id, normalize(claim) if claim else title)
        if key in self._keys:
            return None
        self._keys.add(key)
        f = {"id": f"f{len(self.items) + 1}", "type": type_, "severity": severity, "certainty": certainty, "title": title, "explanation": explanation,
             "spanId": span_id, "path": _path(self.by_id, span_id), "claim": claim, "evidence": evidence or [], "affectedMetrics": list(affected or []), **(extra or {})}
        self.items.append(f)
        return f


def _span_name(by_id: dict, span_id: Optional[str], fallback: str = "a recorded step") -> str:
    s = by_id.get(span_id) if span_id else None
    return f"'{s.get('name')}'" if s and s.get("name") else fallback


def analyze_trace(trace: Any, results: Optional[list] = None) -> dict:
    if not isinstance(trace, dict):
        raise ValueError("trace must be an object")
    spans = [s for s in (trace.get("spans") or []) if isinstance(s, dict) and s.get("spanId")]
    by_id = {s["spanId"]: s for s in spans}
    children = {s.get("parentSpanId") for s in spans}
    F = _Findings(by_id)
    out_text = as_text(trace.get("output"))
    results = [r for r in (results or []) if isinstance(r, dict)]

    # 1. steps that raised errors (facts)
    errored = {s["spanId"] for s in spans if s.get("status") == "error"}
    parent_of = {s["spanId"]: s.get("parentSpanId") for s in spans}

    def ancestors(sid: str) -> list[str]:
        chain, cur, seen = [], parent_of.get(sid), set()
        while cur and cur not in seen:
            seen.add(cur); chain.append(cur); cur = parent_of.get(cur)
        return chain

    covered = {a for sid in errored for a in ancestors(sid)}              # errors that merely bubbled up from a deeper failing step
    for s in spans:
        if s["spanId"] in errored and s["spanId"] not in covered:
            msg = (s.get("error") or {}).get("message", "no message recorded")
            up = [by_id[a].get("name") for a in ancestors(s["spanId"]) if a in errored and a in by_id]
            more = f" The failure then propagated up through {', '.join(repr(n) for n in up)}." if up else ""
            F.add("span_error", "error", "observed", f"Step {_span_name(by_id, s['spanId'])} failed", f"The {s.get('type', 'step')} step raised: {msg}.{more}", span_id=s["spanId"])
    if trace.get("status") == "error" and not any(f["type"] == "span_error" for f in F.items):
        F.add("trace_error", "error", "observed", "The run ended with an error", (trace.get("error") or {}).get("message", "no message recorded"))
    failed_spans = [s for s in spans if s.get("status") == "error" and s.get("parentSpanId")]
    if trace.get("status") == "success" and failed_spans:
        s = failed_spans[0]
        F.add("swallowed_error", "warning", "observed", "The run succeeded even though a step failed",
              f"Step {_span_name(by_id, s['spanId'])} failed but the run still finished normally. Check whether the final answer depended on that step.", span_id=s["spanId"])

    # 2. final answer vs what the tools / retrieval actually returned
    evidence = collect_evidence(trace, {}, {"evidenceSources": ["retrieval", "tool"]})
    claims = [c for c in extract_claims(out_text) if c.checkable]
    if evidence and claims:
        windows = _windows(evidence)
        input_nums = [n.value for n in number_infos(as_text(trace.get("input")))]
        for c in claims:
            r = classify_claim(c, windows, input_nums, {})
            ev = (r.get("evidence") or [None])[0]
            sid = ev.get("spanId") if ev else None
            where = _span_name(by_id, sid, "the retrieved material")
            if r["classification"] == "contradicted":
                conf = r.get("conflict")
                unit = f" {conf['unit']}s" if conf and conf.get("unit") else ""
                expl = (f"The final answer says {_fmt(conf['claim'])}{unit} but step {where} returned {_fmt(conf['evidence'])}{unit}." if conf
                        else f"The final answer disagrees with what step {where} returned ({r['reason']}).")
                F.add("contradiction", "error", "likely" if r["confidence"] >= 0.85 else "possible", "Final answer disagrees with a tool/retrieval result", expl,
                      span_id=sid, claim=c.text, evidence=[{"source": ev["source"], "text": ev["text"], **({"spanId": sid} if sid else {})}] if ev else [],
                      extra={"conflict": conf} if conf else None)
            elif r["classification"] == "unsupported" and ev and "which the evidence does not contain" in r["reason"]:
                F.add("unsupported_claim", "warning", "possible", "Answer states details the tools did not return", f"{r['reason'].capitalize()} (closest evidence: step {where}).",
                      span_id=sid, claim=c.text, evidence=[{"source": ev["source"], "text": ev["text"], **({"spanId": sid} if sid else {})}])

    # 3. empty tool output but the answer cites specifics
    if trace.get("status") == "success" and number_infos(out_text):
        for s in spans:
            if s.get("type") == "tool" and s.get("status") != "error" and _empty((s.get("tool") or {}).get("output")):
                F.add("empty_tool_output", "warning", "possible", "A tool returned nothing, yet the answer cites specific values",
                      f"Step {_span_name(by_id, s['spanId'])} returned an empty result while the final answer contains numbers. They may not come from any recorded step.", span_id=s["spanId"])

    # 4. possible loops
    seen: dict = {}
    for s in spans:
        if s.get("type") == "tool":
            t = s.get("tool") or {}
            k = (t.get("name") or s.get("name"), json.dumps(t.get("input"), sort_keys=True, default=str))
            seen.setdefault(k, []).append(s["spanId"])
    for (name, _), ids in seen.items():
        if len(ids) >= 3:
            F.add("repeated_call", "warning", "possible", f"Tool '{name}' was called {len(ids)} times with identical input",
                  "Identical repeated calls often mean the agent is stuck in a loop or ignoring the tool's answer.", span_id=ids[-1])

    # 5. latency hot spot
    total = trace.get("durationMs")
    leaves = [s for s in spans if s["spanId"] not in children and s.get("parentSpanId") and isinstance(s.get("durationMs"), (int, float))]   # the root span is the whole run, never a "slow step"
    if leaves and isinstance(total, (int, float)) and total > 0:
        slow = max(leaves, key=lambda s: s["durationMs"])
        if slow["durationMs"] >= 2000 and slow["durationMs"] / total >= 0.6:
            F.add("slow_step", "info", "observed", f"Step {_span_name(by_id, slow['spanId'])} took most of the time",
                  f"It took {slow['durationMs'] / 1000:.1f}s of the {total / 1000:.1f}s total ({slow['durationMs'] / total:.0%}).", span_id=slow["spanId"])

    # 6. what evaluations said about this trace
    failed_metrics: list[dict] = []
    for res in results:
        for m in res.get("metrics") or []:
            if m.get("status") != "fail":
                continue
            failed_metrics.append({"metric": m.get("metric"), "score": m.get("score"), "runId": res.get("runId"), "testCaseId": res.get("testCaseId")})
            matched_any = False
            for f in m.get("findings") or []:
                claim = f.get("claim")
                if claim and f.get("classification") in ("contradicted", "unsupported"):
                    hit = next((x for x in F.items if x["claim"] and normalize(x["claim"]) == normalize(claim)), None)
                    if hit:
                        if m["metric"] not in hit["affectedMetrics"]:
                            hit["affectedMetrics"].append(m["metric"])
                    else:
                        ev = (f.get("evidence") or [{}])[0]
                        F.add("evaluation_finding", "error" if f["classification"] == "contradicted" else "warning", "observed", "An evaluation flagged this claim",
                              f.get("reason") or "The evaluation could not support this claim.", span_id=ev.get("spanId"), claim=claim, evidence=[ev] if ev else [], affected=[m["metric"]])
                    matched_any = True
                elif f.get("ok") is False and f.get("message"):
                    key = f.get("claim")
                    hit = next((x for x in F.items if key and x["claim"] and normalize(x["claim"]) == normalize(key)), None)
                    if hit:
                        if m["metric"] not in hit["affectedMetrics"]:
                            hit["affectedMetrics"].append(m["metric"])
                    else:
                        F.add("evaluation_check", "error", "observed", f"{m['metric']} check failed", f["message"], span_id=f.get("spanId"), affected=[m["metric"]])
                    matched_any = True
            if not matched_any:
                F.add("metric_failed", "error", "observed", f"{m.get('metric')} failed (score {m.get('score')})", m.get("explanation") or "The evaluator reported a failure.", affected=[m["metric"]])
    if not results:
        for f in F.items:
            f["potentialMetrics"] = _POTENTIAL.get(f["type"], [])

    items = sorted(F.items, key=lambda f: (_SEV[f["severity"]], _CERT[f["certainty"]]))
    for i, f in enumerate(items):
        f["id"] = f"f{i + 1}"
    verdict = "failed" if any(f["severity"] == "error" for f in items) else "suspicious" if any(f["severity"] == "warning" for f in items) else "clean"
    top = items[0] if items else None
    named = bool(top and top["spanId"] and _span_name(by_id, top["spanId"]) in top["title"])     # avoid "step 'x' failed at step 'x'"
    headline = (f"{top['certainty'].capitalize()}: {top['title'][0].lower() + top['title'][1:]}" + (f" at step {_span_name(by_id, top['spanId'])}" if top["spanId"] and not named else "") + "."
                if top and verdict != "clean" else "No problems were detected in the recorded steps.")

    caveats = ["These findings are rule-based observations of the recorded trace. A suspicious step is a lead, not a proven root cause."]
    if not evidence:
        caveats.append("No tool or retrieval output was recorded, so the final answer could not be cross-checked against earlier steps.")
    if not results:
        caveats.append("This trace is not part of an evaluation run, so findings are not tied to scored metrics (see potentialMetrics).")
    if not spans:
        caveats.append("The trace contains no steps; only the input, output and status were available.")
    return {"traceId": trace.get("traceId"), "verdict": verdict, "headline": headline, "findings": items, "failedMetrics": failed_metrics, "caveats": caveats,
            "suspectedPath": top["path"] if top else []}
