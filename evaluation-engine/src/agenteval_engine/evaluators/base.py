from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Optional

from ..judge import Judge
from ..result import EvaluatorResult, decide_status
from ..text import as_text


@dataclass
class EvalContext:
    trace: dict
    test_case: dict
    config: dict
    judge: Optional[Judge] = None
    cache: dict = field(default_factory=dict)

    @property
    def output_text(self) -> str:
        out = self.trace.get("output")
        if isinstance(out, dict) and isinstance(out.get("output"), str) and len(out) == 1:
            return out["output"]
        return as_text(out)

    @property
    def input_text(self) -> str:
        return as_text(self.test_case.get("input") if self.test_case.get("input") is not None else self.trace.get("input"))

    @property
    def spans(self) -> list[dict]:
        return [s for s in (self.trace.get("spans") or []) if isinstance(s, dict)]   # ignore malformed entries instead of crashing

    @property
    def use_judge(self) -> bool:
        return self.judge is not None and self.config.get("useJudge", True)


def cfg_num(cfg: dict, key: str, default: float, lo: float = 0.0, hi: float = 1.0) -> float:
    v = cfg.get(key, default)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo <= v <= hi:
        raise ValueError(f"config.{key} must be a number between {lo:g} and {hi:g}")
    return float(v)


class Evaluator:
    metric = ""
    version = ""
    description = ""
    requires: tuple[str, ...] = ()       # test-case fields that make this evaluator meaningful
    uses_judge = False
    default_threshold = 0.7

    def evaluate(self, ctx: EvalContext) -> EvaluatorResult:  # pragma: no cover - interface
        raise NotImplementedError

    def finish(self, ctx: EvalContext, *, score: Optional[float], confidence: Optional[float], explanation: str,
               findings: Optional[list] = None, meta: Optional[dict] = None) -> EvaluatorResult:
        thr = cfg_num(ctx.config, "threshold", self.default_threshold)
        minc = cfg_num(ctx.config, "minConfidence", 0.5)
        status = decide_status(score, confidence, thr, minc)
        return EvaluatorResult(
            metric=self.metric, status=status, evaluator_version=self.version,
            score=None if score is None else round(max(0.0, min(1.0, score)), 4),
            confidence=None if confidence is None else round(max(0.0, min(1.0, confidence)), 4),
            threshold=thr, explanation=explanation, findings=findings or [], meta=meta or {},
        )

    def inconclusive(self, explanation: str, meta: Optional[dict] = None) -> EvaluatorResult:
        return EvaluatorResult(metric=self.metric, status="inconclusive", evaluator_version=self.version, explanation=explanation, meta=meta or {})


def judge_json(ctx: EvalContext, prompt: str) -> Optional[dict]:
    """Single guarded judge call; None if no judge, budget exhausted, or provider error."""
    from ..judge import JudgeError
    if not ctx.use_judge:
        return None
    try:
        return ctx.judge.ask(prompt)  # type: ignore[union-attr]
    except JudgeError:
        return None


def to_float01(v: Any) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1 else None
