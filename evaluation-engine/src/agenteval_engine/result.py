"""Normalized evaluator output.

score, confidence and the pass/fail threshold are deliberately separate:
  - score:      how good the output is (0..1)
  - confidence: how sure the evaluator is about that score (0..1)
  - status:     derived from score vs threshold, but 'inconclusive' when confidence is too low
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

STATUSES = {"pass", "fail", "inconclusive"}
CLAIM_CLASSES = {"supported", "contradicted", "unsupported", "unverifiable"}
_SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def decide_status(score: Optional[float], confidence: Optional[float], threshold: float, min_confidence: float = 0.5) -> str:
    if score is None or confidence is None or confidence < min_confidence:
        return "inconclusive"
    return "pass" if score >= threshold else "fail"


@dataclass
class EvaluatorResult:
    metric: str
    status: str
    evaluator_version: str
    score: Optional[float] = None
    confidence: Optional[float] = None
    threshold: Optional[float] = None
    explanation: str = ""
    findings: list[dict[str, Any]] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def validate(self) -> list[str]:
        problems: list[str] = []
        if not self.metric:
            problems.append("metric is required")
        if self.status not in STATUSES:
            problems.append(f"status must be one of {sorted(STATUSES)}")
        if not _SEMVER.match(self.evaluator_version or ""):
            problems.append("evaluator_version must look like 1.0.0")
        for name, v in (("score", self.score), ("confidence", self.confidence), ("threshold", self.threshold)):
            if v is not None and not (isinstance(v, (int, float)) and 0.0 <= v <= 1.0):
                problems.append(f"{name} must be between 0 and 1")
        if self.status in ("pass", "fail") and self.score is None:
            problems.append("score is required when status is pass or fail")
        for i, f in enumerate(self.findings):
            c = f.get("classification")
            if c is not None and c not in CLAIM_CLASSES:
                problems.append(f"findings[{i}].classification must be one of {sorted(CLAIM_CLASSES)}")
        return problems

    def to_dict(self) -> dict[str, Any]:
        problems = self.validate()
        if problems:
            raise ValueError("; ".join(problems))
        return {
            "metric": self.metric,
            "score": self.score,
            "status": self.status,
            "confidence": self.confidence,
            "threshold": self.threshold,
            "explanation": self.explanation,
            "findings": self.findings,
            "evaluatorVersion": self.evaluator_version,
            "meta": self.meta,
        }
