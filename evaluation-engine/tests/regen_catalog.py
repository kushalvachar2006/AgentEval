"""Regenerates apps/api/src/config/evaluatorCatalog.json from the engine registry (run after adding/bumping an evaluator)."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "evaluation-engine" / "src"))
from agenteval_engine.evaluators import catalog  # noqa: E402

p = root / "apps" / "api" / "src" / "config" / "evaluatorCatalog.json"
p.write_text(json.dumps({"_comment": "Generated from the Python engine registry. A test in evaluation-engine keeps the two in sync: regenerate with `python evaluation-engine/tests/regen_catalog.py`.", "evaluators": catalog()}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("wrote", p)
