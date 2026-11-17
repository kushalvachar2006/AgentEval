"""Evaluation entry point: payload in, normalized results out. One evaluator failing never breaks the others."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from . import __version__
from .evaluators import REGISTRY, catalog, latest
from .evaluators.base import EvalContext
from .judge import BudgetedJudge, JudgeError, build_judge
from .result import EvaluatorResult


def config_hash(cfg: dict) -> str:
    return hashlib.sha256(json.dumps(cfg, sort_keys=True, default=str).encode()).hexdigest()[:12]


def evaluate(payload: dict) -> dict:
    trace, case = payload.get("trace"), payload.get("testCase") or {}
    if not isinstance(trace, dict):
        raise ValueError("payload.trace must be an object")
    specs = payload.get("evaluators")
    if not isinstance(specs, list) or not specs:
        raise ValueError("payload.evaluators must be a non-empty list")
    if len(specs) > 20:
        raise ValueError("at most 20 evaluators per request")

    judge, judge_error = None, None
    if payload.get("judge"):
        try:
            judge = BudgetedJudge(build_judge(payload["judge"]), int((payload.get("limits") or {}).get("maxJudgeCalls", 10)))  # type: ignore[arg-type]
        except JudgeError as e:
            judge_error = str(e)

    ctx_cache: dict = {}
    results: list[dict[str, Any]] = []
    for spec in specs:
        metric, cfg = spec.get("metric"), spec.get("config") or {}
        version = spec.get("version")
        meta_base = {"configHash": config_hash(cfg)}
        try:
            if metric not in REGISTRY:
                raise ValueError(f"unknown metric '{metric}'")
            version = version or latest(metric)
            if version not in REGISTRY[metric]:
                raise ValueError(f"metric '{metric}' has no version '{version}' (available: {', '.join(sorted(REGISTRY[metric]))})")
            ev = REGISTRY[metric][version]()
            r = ev.evaluate(EvalContext(trace=trace, test_case=case, config=cfg, judge=judge, cache=ctx_cache))
            r.meta = {**r.meta, **meta_base, **({"judgeError": judge_error} if judge_error and ev.uses_judge else {})}
            results.append(r.to_dict())
        except Exception as e:  # noqa: BLE001 - isolate evaluator failures
            results.append(EvaluatorResult(metric=str(metric), status="inconclusive", evaluator_version=str(version or "0.0.0") if str(version or "").count(".") == 2 else "0.0.0",
                                           explanation=f"Evaluator could not run: {e}", meta={**meta_base, "error": type(e).__name__}).to_dict())
    return {"results": results, "judgeCalls": judge.calls if judge else 0, "engineVersion": __version__}


__all__ = ["evaluate", "catalog"]
