from __future__ import annotations

import json

from ..text import normalize
from .base import EvalContext, Evaluator

# NOTE: user-supplied regular expressions are deliberately NOT supported: Python's `re` cannot be interrupted, so a hostile
# pattern could freeze the engine (ReDoS). Length, containment and format checks cover the common cases safely.


class InstructionAdherence(Evaluator):
    metric, version = "instruction_adherence", "1.0.0"
    description = "Checks output constraints from the test case: length limits, required / forbidden text, output format."
    requires = ("constraints",)
    default_threshold = 1.0

    def evaluate(self, ctx: EvalContext):
        c = ctx.test_case.get("constraints") or {}
        if not c:
            return self.inconclusive("No constraints defined on the test case.")
        out, low, checks = ctx.output_text, normalize(ctx.output_text), []

        def add(name, ok, msg):
            checks.append({"check": name, "ok": bool(ok), "message": msg})

        if "maxChars" in c: add("maxChars", len(out) <= c["maxChars"], f"{len(out)} characters (max {c['maxChars']})")
        if "minChars" in c: add("minChars", len(out) >= c["minChars"], f"{len(out)} characters (min {c['minChars']})")
        if "maxWords" in c: add("maxWords", len(out.split()) <= c["maxWords"], f"{len(out.split())} words (max {c['maxWords']})")
        for t in c.get("mustInclude", []): add("mustInclude", normalize(t) in low, f"required text '{t}'")
        for t in c.get("mustNotInclude", []): add("mustNotInclude", normalize(t) not in low, f"forbidden text '{t}'")
        fmt = c.get("format")
        if fmt == "json":
            try:
                json.loads(out); ok = True
            except ValueError:
                ok = False
            add("format", ok, "output must be valid JSON")
        elif fmt == "single_line": add("format", "\n" not in out.strip(), "output must be a single line")
        elif fmt == "bullet_list":
            lines = [l for l in out.splitlines() if l.strip()]
            add("format", bool(lines) and all(l.lstrip().startswith(("-", "*", "•")) for l in lines), "every line must be a bullet")
        if not checks:
            return self.inconclusive("Constraints present but none are recognised.")
        n_ok = sum(1 for x in checks if x["ok"])
        return self.finish(ctx, score=n_ok / len(checks), confidence=0.97, explanation=f"{n_ok} of {len(checks)} constraint(s) satisfied.", findings=[x for x in checks if not x["ok"]] or checks[:1],
                           meta={"checks": len(checks)})
