from __future__ import annotations

from .accuracy import Accuracy
from .completeness import Completeness
from .grounding import Groundedness, Hallucination
from .instructions import InstructionAdherence
from .operational import OperationalPerformance
from .relevance import Relevance
from .tools import ToolUsage

_ALL = [Accuracy, Hallucination, Groundedness, Relevance, Completeness, ToolUsage, InstructionAdherence, OperationalPerformance]

# metric -> {version -> class}. Old versions stay registered so past runs can be reproduced.
REGISTRY: dict[str, dict[str, type]] = {}
for _cls in _ALL:
    REGISTRY.setdefault(_cls.metric, {})[_cls.version] = _cls


def latest(metric: str) -> str:
    return max(REGISTRY[metric], key=lambda v: tuple(int(x) for x in v.split(".")))


def catalog() -> list[dict]:
    return [{"metric": m, "version": latest(m), "description": REGISTRY[m][latest(m)].description, "requires": list(REGISTRY[m][latest(m)].requires),
             "usesJudge": REGISTRY[m][latest(m)].uses_judge} for m in sorted(REGISTRY)]
