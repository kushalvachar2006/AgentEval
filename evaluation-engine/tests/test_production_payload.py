"""Production traces are evaluated WITHOUT a test case: evidence must come from tool output recorded in the trace itself."""
import unittest

from agenteval_engine.engine import evaluate


def trace(answer):
    return {
        "status": "success", "input": "What is the refund window?", "output": answer, "durationMs": 900,
        "usage": {"totalTokens": 300, "estimatedCostUsd": 0.002},
        "spans": [
            {"spanId": "a" * 16, "parentSpanId": None, "type": "agent", "name": "support", "status": "success", "startedAt": "2026-11-12T10:00:00Z", "endedAt": "2026-11-12T10:00:01Z"},
            {"spanId": "b" * 16, "parentSpanId": "a" * 16, "type": "tool", "name": "policy_lookup", "status": "success", "startedAt": "2026-11-12T10:00:00Z", "endedAt": "2026-11-12T10:00:01Z",
             "tool": {"name": "policy_lookup", "input": {"topic": "refund"}, "output": "The refund window is 30 days from the date of purchase."}},
        ],
    }


EVALS = [{"metric": m, "version": "1.0.0", "config": {}} for m in ("hallucination", "groundedness", "relevance", "tool_usage", "operational")]


class ProductionPayload(unittest.TestCase):
    def run_it(self, answer, extra=None):
        out = evaluate({"trace": trace(answer), "testCase": extra or {}, "evaluators": EVALS})
        return {r["metric"]: r for r in out["results"]}

    def test_supported_answer_is_not_flagged(self):
        r = self.run_it("The refund window is 30 days from the date of purchase.")
        self.assertEqual(r["hallucination"]["status"], "pass")
        self.assertEqual(r["groundedness"]["status"], "pass")
        self.assertIn(r["tool_usage"]["status"], ("pass", "inconclusive"))
        self.assertEqual(r["operational"]["metric"], "operational")

    def test_contradiction_with_recorded_tool_output_is_caught(self):
        r = self.run_it("The refund window is 90 days from the date of purchase.")
        self.assertEqual(r["hallucination"]["status"], "fail")

    def test_no_evidence_means_inconclusive_never_pass(self):
        t = trace("The refund window is 30 days.")
        t["spans"] = t["spans"][:1]
        out = evaluate({"trace": t, "testCase": {}, "evaluators": EVALS[:2]})
        self.assertTrue(all(r["status"] == "inconclusive" for r in out["results"]))

    def test_instruction_adherence_uses_policy_constraints(self):
        out = evaluate({"trace": trace("x" * 300), "testCase": {"constraints": {"maxChars": 100}}, "evaluators": [{"metric": "instruction_adherence", "version": "1.0.0", "config": {}}]})
        self.assertEqual(out["results"][0]["status"], "fail")


if __name__ == "__main__":
    unittest.main()
