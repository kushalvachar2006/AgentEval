import unittest

from agenteval_engine.evaluators import REGISTRY
from agenteval_engine.evaluators.accuracy import Accuracy
from agenteval_engine.evaluators.completeness import Completeness
from agenteval_engine.evaluators.grounding import Groundedness, Hallucination
from agenteval_engine.evaluators.instructions import InstructionAdherence
from agenteval_engine.evaluators.operational import OperationalPerformance
from agenteval_engine.evaluators.relevance import Relevance
from agenteval_engine.evaluators.tools import ToolUsage
from helpers import ctx, judge_returning, trace


def out(text, **kw):
    return trace(output=text, **kw)


class AccuracyTests(unittest.TestCase):
    def run_(self, ref, ans, **cfg):
        return Accuracy().evaluate(ctx(out(ans), {"referenceAnswer": ref}, cfg))

    def test_no_reference_is_inconclusive(self):
        self.assertEqual(Accuracy().evaluate(ctx(case={})).status, "inconclusive")

    def test_exact(self):
        self.assertEqual(self.run_("Paris", "paris.").status, "pass")
        self.assertEqual(self.run_("Paris", "Lyon").status, "fail")

    def test_numeric_with_tolerance(self):
        self.assertEqual(self.run_("₹47,999", "It costs 47999 rupees").status, "pass")
        self.assertEqual(self.run_("₹47,999", "It costs ₹52,999").status, "fail")
        self.assertEqual(self.run_("100", "about 100.5", tolerance=0.01).status, "pass")
        self.assertEqual(self.run_("100", "about 120", tolerance=0.01).status, "fail")

    def test_semantic_paraphrase_vs_wrong_number(self):
        ref = "Refunds are available within 30 days of purchase for all customers."
        good = self.run_(ref, "All customers can get a refund within 30 days of purchase.")
        self.assertEqual(good.status, "pass")
        bad = self.run_(ref, "Refunds are available within 90 days of purchase for all customers.")
        self.assertEqual(bad.status, "fail")
        self.assertIn("numbers_missing", [f["check"] for f in bad.findings])

    def test_judge_blends_with_lexical_and_raises_confidence(self):
        j = judge_returning({"verdict": "correct", "score": 0.95, "reason": "same meaning"})
        r = Accuracy().evaluate(ctx(out("You can return items for a full refund in a month."), {"referenceAnswer": "Refunds are available within 30 days of purchase for all customers."}, judge=j))
        self.assertEqual(r.meta["method"], "judge+lexical")
        self.assertGreaterEqual(r.score, 0.6)

    def test_empty_answer_fails_and_bad_config_raises(self):
        self.assertEqual(self.run_("Paris", "  ").status, "fail")
        with self.assertRaises(ValueError):
            self.run_("Paris", "Paris", mode="telepathy")
        with self.assertRaises(ValueError):
            self.run_("Paris", "Paris", threshold=5)


class GroundingTests(unittest.TestCase):
    def test_laptop_example_is_contradicted(self):
        h = Hallucination().evaluate(ctx())
        g = Groundedness().evaluate(ctx())
        self.assertEqual((h.status, g.status), ("fail", "fail"))
        self.assertEqual(h.findings[0]["classification"], "contradicted")
        self.assertEqual(h.score, 0.0)
        self.assertGreaterEqual(h.confidence, 0.85)

    def test_unsupported_is_penalised_less_than_contradicted(self):
        ev = {"referenceEvidence": ["Premium users receive an additional 10 days of support."]}
        t = out("Premium users receive an additional 10 days of support. The plan also includes a free yearly retreat.", spans=[])
        h = Hallucination().evaluate(ctx(t, ev))
        counts = h.meta["counts"]
        self.assertEqual((counts["supported"], counts["unsupported"], counts["contradicted"]), (1, 1, 0))
        self.assertEqual(h.score, 0.75)          # 1 - 0.5*1/2
        g = Groundedness().evaluate(ctx(t, ev))
        self.assertEqual(g.score, 0.5)           # groundedness is stricter

    def test_no_evidence_or_no_claims_is_inconclusive_not_a_pass(self):
        self.assertEqual(Hallucination().evaluate(ctx(out("The sky is blue today.", spans=[]), {})).status, "inconclusive")
        r = Hallucination().evaluate(ctx(out("Happy to help!", spans=[]), {"referenceEvidence": ["x y z"]}))
        self.assertEqual(r.status, "inconclusive")

    def test_judge_call_is_shared_between_the_two_evaluators(self):
        calls = []
        j = judge_returning(lambda u: calls.append(1) or {"claims": []})
        c = ctx(out("The warranty covers water damage fully.", spans=[]), {"referenceEvidence": ["The warranty covers theft."]}, judge=j)
        Hallucination().evaluate(c)
        Groundedness().evaluate(c)
        self.assertEqual(len(calls), 1)


class RelevanceTests(unittest.TestCase):
    def test_refusal_and_empty(self):
        self.assertEqual(Relevance().evaluate(ctx(out("I'm sorry, I can't help with that."))).status, "fail")
        self.assertEqual(Relevance().evaluate(ctx(out(""))).status, "fail")

    def test_lexical_is_inconclusive_when_signal_is_weak_but_judge_decides(self):
        t = out("Seven.", spans=[])
        weak = Relevance().evaluate(ctx(t, {"input": "How many days are in a week?"}))
        self.assertEqual(weak.status, "inconclusive")
        j = judge_returning({"score": 0.9, "off_topic": False, "reason": "answers the question"})
        self.assertEqual(Relevance().evaluate(ctx(t, {"input": "How many days are in a week?"}, judge=j)).status, "pass")

    def test_strong_lexical_overlap_passes(self):
        self.assertEqual(Relevance().evaluate(ctx(out("The cheapest laptop below 50,000 rupees is the Acme Book 14."))).status, "pass")


class CompletenessTests(unittest.TestCase):
    CASE = {"requiredElements": ["Acme Book 14", "₹47,999", {"text": "free delivery", "alternatives": ["ships free"]}]}

    def test_rule_matching_numbers_and_alternatives(self):
        r = Completeness().evaluate(ctx(out("Acme Book 14 for ₹47,999. It ships free."), self.CASE))
        self.assertEqual((r.status, r.score), ("pass", 1.0))
        r = Completeness().evaluate(ctx(out("Acme Book 14 for ₹52,999."), self.CASE))
        self.assertEqual(r.score, round(1 / 3, 4))
        self.assertEqual([f["covered"] for f in r.findings], [True, False, False])

    def test_judge_needs_a_real_quote(self):
        ans = "The laptop arrives without any shipping charge."
        case = {"requiredElements": ["free delivery"]}
        good = judge_returning({"elements": [{"index": 0, "covered": True, "quote": "without any shipping charge"}]})
        fake = judge_returning({"elements": [{"index": 0, "covered": True, "quote": "free delivery is included for sure"}]})
        self.assertEqual(Completeness().evaluate(ctx(out(ans), case, judge=good)).score, 1.0)
        self.assertEqual(Completeness().evaluate(ctx(out(ans), case, judge=fake)).score, 0.0)

    def test_no_elements_inconclusive(self):
        self.assertEqual(Completeness().evaluate(ctx()).status, "inconclusive")
        with self.assertRaises(ValueError):
            Completeness().evaluate(ctx(case={"requiredElements": [5]}))


class ToolTests(unittest.TestCase):
    def multi(self):
        def span(i, name, args, status="success", output=None):
            return {"spanId": f"{i:016x}", "type": "tool", "name": name, "status": status, "tool": {"name": name, "input": args, "output": output or {"ok": True}},
                    **({"error": {"message": "boom"}} if status == "error" else {})}
        return trace(output="Done.", spans=[span(1, "search", {"q": "laptop", "maxPrice": 50000}), span(2, "book", {"id": 7}, status="error")])

    def test_laptop_trace_flags_interpretation_with_span_id(self):
        case = {"expectedToolCalls": [{"name": "search_products", "args": {"maxPrice": 50000, "query": "Laptop"}}]}
        r = ToolUsage().evaluate(ctx(case=case))
        self.assertEqual(r.meta["subscores"]["selection"], 1.0)
        self.assertEqual(r.meta["subscores"]["parameters"], 1.0)      # numeric + case-insensitive string match
        self.assertEqual(r.meta["subscores"]["interpretation"], 0.0)
        self.assertEqual(r.status, "fail")
        bad = [f for f in r.findings if f["check"] == "interpretation"][0]
        self.assertEqual(bad["spanId"], "a" * 16)

    def test_missing_tool_wrong_args_failed_execution(self):
        t = self.multi()
        case = {"expectedToolCalls": [{"name": "search", "args": {"maxPrice": 40000}}, {"name": "pay"}]}
        r = ToolUsage().evaluate(ctx(t, case))
        sub = r.meta["subscores"]
        self.assertEqual(sub["selection"], 0.5)
        self.assertEqual(sub["parameters"], 0.0)
        self.assertEqual(sub["execution"], 0.5)
        msgs = " ".join(f["message"] for f in r.findings)
        self.assertIn("'pay' was never called", msgs)
        self.assertIn("tool 'book' failed: boom", msgs)

    def test_ordering_and_unexpected_tools(self):
        t = self.multi()
        t["spans"][1]["status"] = "success"
        ordered = ToolUsage().evaluate(ctx(t, {"expectedToolCalls": [{"name": "book", "order": 1}, {"name": "search", "order": 2}]}))
        self.assertLess(ordered.meta["subscores"]["sequence"], 1.0)
        strict = ToolUsage().evaluate(ctx(t, {"expectedToolCalls": [{"name": "search"}]}, {"forbidUnexpected": True}))
        self.assertLess(strict.meta["subscores"]["selection"], 1.0)

    def test_inconclusive_when_nothing_to_judge(self):
        self.assertEqual(ToolUsage().evaluate(ctx(trace(spans=[]), {})).status, "inconclusive")
        self.assertEqual(ToolUsage().evaluate(ctx(trace(spans=[]), {"expectedToolCalls": [{"name": "x"}]})).status, "inconclusive")

    def test_string_json_arguments_are_parsed(self):
        t = trace()
        t["spans"][0]["tool"]["input"] = '{"query": "laptop", "maxPrice": 50000}'
        r = ToolUsage().evaluate(ctx(t, {"expectedToolCalls": [{"name": "search_products", "args": {"maxPrice": 50000}}]}))
        self.assertEqual(r.meta["subscores"]["parameters"], 1.0)


class InstructionAndOperationalTests(unittest.TestCase):
    def test_constraints(self):
        c = {"constraints": {"maxChars": 20, "mustInclude": ["acme"], "mustNotInclude": ["sorry"], "format": "single_line"}}
        ok = InstructionAdherence().evaluate(ctx(out("Acme Book 14"), c))
        self.assertEqual((ok.status, ok.score), ("pass", 1.0))
        bad = InstructionAdherence().evaluate(ctx(out("Sorry, line one\nline two is long"), c))
        self.assertEqual(bad.status, "fail")
        self.assertEqual(sorted(f["check"] for f in bad.findings), sorted(["maxChars", "mustInclude", "mustNotInclude", "format"]))
        self.assertEqual(InstructionAdherence().evaluate(ctx(out('{"a": 1}'), {"constraints": {"format": "json"}})).status, "pass")
        self.assertEqual(InstructionAdherence().evaluate(ctx(out("nope"), {"constraints": {"format": "json"}})).status, "fail")
        self.assertEqual(InstructionAdherence().evaluate(ctx()).status, "inconclusive")

    def test_regex_constraints_are_not_supported_on_purpose(self):
        r = InstructionAdherence().evaluate(ctx(out("x"), {"constraints": {"regex": "(a+)+$"}}))
        self.assertEqual(r.status, "inconclusive")

    def test_operational_budgets_and_pricing(self):
        r = OperationalPerformance().evaluate(ctx(config={"maxLatencyMs": 5000, "maxTotalTokens": 500, "maxErrors": 0}))
        self.assertEqual(r.status, "fail")
        self.assertEqual(r.score, round(2 / 3, 4))
        self.assertEqual(r.meta["measurements"]["latencyMs"], 3200)
        t = trace(usage={"totalTokens": 10}, spans=[{"spanId": "b" * 16, "type": "llm", "status": "success", "name": "x", "llm": {"model": "m1", "usage": {"inputTokens": 1_000_000, "outputTokens": 500_000}}}])
        r = OperationalPerformance().evaluate(ctx(t, config={"maxCostUsd": 5.0, "pricing": {"m1": {"inputPer1M": 2.0, "outputPer1M": 4.0}}}))
        self.assertEqual((r.status, r.meta["measurements"]["costUsd"]), ("pass", 4.0))
        self.assertEqual(OperationalPerformance().evaluate(ctx()).status, "inconclusive")   # no budgets -> no verdict, never a fake pass

    def test_every_registered_evaluator_declares_a_semver(self):
        for versions in REGISTRY.values():
            for v, cls in versions.items():
                self.assertRegex(v, r"^\d+\.\d+\.\d+$")
                self.assertEqual(cls.version, v)


if __name__ == "__main__":
    unittest.main()


class Robustness(unittest.TestCase):
    def test_malformed_spans_never_crash_any_evaluator(self):
        from agenteval_engine.engine import evaluate
        t = trace(spans=[None, 5, "x", {"x": 1}, {"spanId": "a" * 16, "type": "tool", "status": "success", "tool": {"name": "t", "output": {"a": 1}}}])
        out = evaluate({"trace": t, "testCase": {"referenceAnswer": "x", "requiredElements": ["y"], "expectedToolCalls": [{"name": "t"}], "constraints": {"maxChars": 5}},
                        "evaluators": [{"metric": m} for m in REGISTRY]})
        self.assertTrue(all("could not run" not in r["explanation"] for r in out["results"]), [r["explanation"] for r in out["results"]])
