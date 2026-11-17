"""Claim extraction, evidence collection and claim-level classification (supported / contradicted / unsupported / unverifiable).

Rules first, judge second: the rule engine decides what it can with high confidence (lexical support, numeric conflicts,
negation), and only uncertain claims go to the LLM judge - whose verdicts must quote real evidence to be accepted."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional

from .judge import Judge, JudgeError, SYSTEM_PROMPT, quote_in_text, wrap
from .text import (close, comparable, containment, content_tokens, flatten_sentences, has_negation, normalize, number_infos, sentences, unit_anchored)

CLASSES = ("supported", "contradicted", "unsupported", "unverifiable")
_META = re.compile(r"^(sure|certainly|of course|okay|ok|hello|hi|hey|thanks|thank you|here(?:'s| is| are)|let me|i hope|feel free|happy to|great question|please)\b", re.I)
_OPINION = re.compile(r"\b(i think|i believe|in my opinion|probably|perhaps|maybe|might|could be|i recommend|i suggest|great choice|good choice|amazing|worth it)\b", re.I)


@dataclass
class Claim:
    text: str
    kind: str  # fact | opinion | meta | question

    @property
    def checkable(self) -> bool:
        return self.kind == "fact"


def extract_claims(text: str, max_claims: int = 30) -> list[Claim]:
    claims: list[Claim] = []
    for s in sentences(text):
        s = re.sub(r"^(?:[#>*\-•]+|\d{1,2}[.)])\s+", "", s).strip()
        if len(content_tokens(s)) < 2:
            continue
        if s.endswith("?"):
            kind = "question"
        elif _META.match(s):
            kind = "meta"
        elif _OPINION.search(s):
            kind = "opinion"
        else:
            kind = "fact"
        claims.append(Claim(s, kind))
    return claims[:max_claims]


@dataclass
class Evidence:
    text: str
    source: str            # reference | reference_answer | retrieval | tool:<name>
    span_id: Optional[str] = None


def collect_evidence(trace: dict, test_case: dict, cfg: dict) -> list[Evidence]:
    sources = set(cfg.get("evidenceSources") or ["reference", "retrieval", "tool"])
    ev: list[Evidence] = []
    if "reference" in sources:
        for item in test_case.get("referenceEvidence") or []:
            text = item.get("text") if isinstance(item, dict) else item
            src = (item.get("source") if isinstance(item, dict) else None) or "reference"
            for s in flatten_sentences(text):
                ev.append(Evidence(s, f"reference:{src}" if src != "reference" else "reference"))
        if cfg.get("useReferenceAnswerAsEvidence", True) and test_case.get("referenceAnswer"):
            for s in flatten_sentences(test_case["referenceAnswer"]):
                ev.append(Evidence(s, "reference_answer"))
    for span in (s for s in trace.get("spans") or [] if isinstance(s, dict)):
        if span.get("type") == "retriever" and "retrieval" in sources:
            for d in ((span.get("retriever") or {}).get("documents")) or []:
                content = d.get("pageContent") if isinstance(d, dict) else d
                for s in flatten_sentences(content):
                    ev.append(Evidence(s, "retrieval", span.get("spanId")))
        elif span.get("type") == "tool" and "tool" in sources and span.get("status") != "error":
            tool = span.get("tool") or {}
            for s in flatten_sentences(tool.get("output")):
                ev.append(Evidence(s, f"tool:{tool.get('name', span.get('name'))}", span.get("spanId")))
    return ev


def _windows(ev: list[Evidence]) -> list[tuple[str, Evidence]]:
    """Each sentence, plus adjacent pairs from the same source (claims often span two sentences)."""
    out = [(e.text, e) for e in ev]
    out += [(f"{a.text} {b.text}", a) for a, b in zip(ev, ev[1:]) if a.source == b.source]
    return out


def _entry(e: Evidence, text: str, overlap: float) -> dict:
    return {"source": e.source, "text": text[:300], "overlap": round(overlap, 2), **({"spanId": e.span_id} if e.span_id else {})}


def classify_claim(claim: Claim, windows: list[tuple[str, Evidence]], input_numbers: list[float], cfg: dict) -> dict:
    res = _classify(claim, windows, input_numbers, cfg)
    if res["classification"] == "unsupported" and claim.checkable:
        # Key/value tool output ("days: 3") shares few WORDS with an answer ("Delivery takes 5 days"), so word overlap can miss it.
        # A count of the same named unit with a different value is still a conflict - but only a moderately confident one.
        mine = [n for n in number_infos(claim.text) if n.unit and not any(close(n.value, x) for x in input_numbers)]
        for c in mine:
            cands = [(e, ev, text) for text, ev in windows for e in number_infos(text) if unit_anchored(c, e)]
            if not cands:
                continue
            agree = next(((e, ev, text) for e, ev, text in cands if close(e.value, c.value)), None)
            if agree:   # same count of the same named unit: supported, but only moderately confident (word overlap is low)
                e, ev, text = agree
                return {"claim": claim.text, "method": "rule", "classification": "supported", "confidence": 0.6, "evidence": [_entry(ev, text, 0.0)], "reason": f"evidence states the same value for '{c.unit}'"}
            e, ev, text = cands[0]
            return {"claim": claim.text, "method": "rule", "classification": "contradicted", "confidence": 0.8, "evidence": [_entry(ev, text, 0.0)],
                    "reason": f"claim says {c.value:g} {c.unit}(s) but the evidence says {e.value:g}", "conflict": {"claim": c.value, "evidence": e.value, "kind": c.kind, "unit": c.unit}}
    return res


def _classify(claim: Claim, windows: list[tuple[str, Evidence]], input_numbers: list[float], cfg: dict) -> dict:
    support_t, related_t = float(cfg.get("supportThreshold", 0.6)), float(cfg.get("relatedThreshold", 0.4))
    base = {"claim": claim.text, "method": "rule"}
    if not claim.checkable:
        return {**base, "classification": "unverifiable", "confidence": 0.9, "evidence": [], "reason": f"{claim.kind} statement - not a checkable fact"}
    ct = content_tokens(claim.text)
    best_ov, best_text, best_ev, best_key = 0.0, "", None, (0.0, 0)
    for text, e in windows:
        ov = containment(ct, content_tokens(text))
        key = (ov, 1 if e.span_id else 0)   # equal overlap: prefer evidence that points at a real execution step (needed for debugging)
        if ov > 0 and key > best_key:
            best_ov, best_text, best_ev, best_key = ov, text, e, key
    if best_ev is None or best_ov < related_t:
        return {**base, "classification": "unsupported", "confidence": 0.75 if best_ov < 0.2 else 0.55, "evidence": [],
                "reason": "no evidence sentence covers this claim"}

    claim_nums = [n for n in number_infos(claim.text) if not any(close(n.value, x) for x in input_numbers)]  # numbers the user supplied are not claims
    ev_nums = number_infos(best_text)
    unmatched = [n for n in claim_nums if not any(close(n.value, e.value) for e in ev_nums)]
    conflicts = [(c, e) for c in unmatched for e in ev_nums
                 if comparable(c, e) and not any(close(e.value, c2.value) for c2 in number_infos(claim.text))]
    entry = _entry(best_ev, best_text, best_ov)
    if conflicts:
        c, e = conflicts[0]
        return {**base, "classification": "contradicted", "confidence": 0.9, "evidence": [entry],
                "reason": f"claim says {c.value:g} but the evidence says {e.value:g}", "conflict": {"claim": c.value, "evidence": e.value, "kind": c.kind}}
    if best_ov >= support_t and has_negation(claim.text) != has_negation(best_text):
        return {**base, "classification": "contradicted", "confidence": 0.6, "evidence": [entry], "reason": "claim and evidence disagree on negation"}
    if unmatched:
        return {**base, "classification": "unsupported", "confidence": 0.7, "evidence": [entry],
                "reason": "claim states " + ", ".join(f"{n.value:g}" for n in unmatched) + " which the evidence does not contain"}
    if best_ov >= support_t:
        return {**base, "classification": "supported", "confidence": round(min(0.95, 0.6 + 0.35 * best_ov), 2), "evidence": [entry], "reason": "evidence covers the claim"}
    return {**base, "classification": "unsupported", "confidence": 0.55, "evidence": [entry], "reason": "evidence only partially covers the claim"}


def refine_with_judge(findings: list[dict], evidence: list[Evidence], judge: Judge, max_claims: int) -> int:
    """Ask the judge about uncertain claims in ONE call. Returns number of findings changed."""
    idx = [i for i, f in enumerate(findings) if f["classification"] != "unverifiable"
           and (f["classification"] == "unsupported" or f["confidence"] < 0.65)][:max_claims]
    if not idx or not evidence:
        return 0
    pool = "\n".join(f"[{e.source}] {e.text}" for e in evidence)[:8000]
    listing = "\n".join(f"{n}. {findings[i]['claim']}" for n, i in enumerate(idx))
    prompt = (
        "Classify each numbered CLAIM against the EVIDENCE. Classes: supported (evidence states it), contradicted (evidence states the opposite or a different "
        "value), unsupported (evidence is silent), unverifiable (opinion/not factual).\n"
        "For supported and contradicted you MUST include `evidence_quote`: an exact quote (8+ characters) copied from the evidence.\n"
        'Reply as {"claims":[{"index":0,"classification":"...","evidence_quote":"...","reason":"..."}]}\n\n'
        f"{wrap('EVIDENCE', pool)}\n\n{wrap('CLAIMS', listing)}"
    )
    try:
        verdicts = judge.ask(prompt).get("claims")
    except JudgeError:
        return 0
    changed = 0
    for v in verdicts if isinstance(verdicts, list) else []:
        try:
            i = idx[int(v["index"])]
            cls = v["classification"]
        except (KeyError, ValueError, IndexError, TypeError):
            continue
        if cls not in CLASSES:
            continue
        if cls in ("supported", "contradicted") and not quote_in_text(v.get("evidence_quote"), pool):
            continue  # unverifiable judge verdict: keep the rule-based one
        f = findings[i]
        if cls != f["classification"]:
            changed += 1
        f.update(classification=cls, method="judge", confidence=0.9, reason=str(v.get("reason", ""))[:300])
        if cls in ("supported", "contradicted"):
            f["evidence"] = [{"source": "judge-quote", "text": str(v["evidence_quote"])[:300]}]
    return changed


def analyze(ctx: Any, cfg: dict) -> dict:
    """Shared by hallucination and groundedness. Cached on the context so a judge call is paid once."""
    key = ("claims", repr(sorted((k, repr(v)) for k, v in cfg.items() if k in ("evidenceSources", "useReferenceAnswerAsEvidence", "supportThreshold", "relatedThreshold", "maxJudgeClaims"))))
    if key in ctx.cache:
        return ctx.cache[key]
    evidence = collect_evidence(ctx.trace, ctx.test_case, cfg)
    claims = extract_claims(ctx.output_text)
    out: dict = {"evidence": evidence, "claims": claims, "findings": [], "judgeChanged": 0, "judgeUsed": False}
    if evidence and claims:
        windows = _windows(evidence)
        input_nums = [n.value for n in number_infos(ctx.input_text)]
        out["findings"] = [classify_claim(c, windows, input_nums, cfg) for c in claims]
        if ctx.judge is not None and cfg.get("useJudge", True):
            out["judgeChanged"] = refine_with_judge(out["findings"], evidence, ctx.judge, int(cfg.get("maxJudgeClaims", 8)))
            out["judgeUsed"] = True
    ctx.cache[key] = out
    return out
