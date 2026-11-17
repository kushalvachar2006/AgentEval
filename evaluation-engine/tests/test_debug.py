import http.client
import json
import threading
import unittest

from agenteval_engine.debug import analyze_trace
from agenteval_engine.server import Server, make_handler


def trace(spans, **kw):
    t = {"traceId": "a" * 32, "status": "success", "durationMs": 3000, "input": "Find the cheapest laptop below ₹50,000.",
         "output": "The cheapest laptop under ₹50,000 is the Acme Book 14 at ₹52,999.", "spans": spans}
    t.update(kw)
    return t


ROOT = {"spanId": "0" * 15 + "1", "parentSpanId": None, "type": "agent", "name": "laptop_agent", "status": "success", "durationMs": 3000}
CHAIN = {"spanId": "0" * 15 + "2", "parentSpanId": ROOT["spanId"], "type": "chain", "name": "react_loop", "status": "success", "durationMs": 2900}


def tool(i, name="search_products", out=None, status="success", args=None, dur=400, error=None):
    return {"spanId": f"{i:016x}", "parentSpanId": CHAIN["spanId"], "type": "tool", "name": name, "status": status, "durationMs": dur,
            "tool": {"name": name, "input": args or {"query": "laptop", "maxPrice": 50000}, "output": out if out is not None else {"results": [{"name": "Acme Book 14", "priceInr": 47999}]}},
            **({"error": {"message": error}} if error else {})}


class DebugTests(unittest.TestCase):
    def test_flagship_contradiction_points_at_the_tool_step_with_honest_certainty(self):
        t = trace([ROOT, CHAIN, tool(0xB7)])
        r = analyze_trace(t)
        self.assertEqual(r["verdict"], "failed")
        f = r["findings"][0]
        self.assertEqual((f["type"], f["severity"], f["certainty"], f["spanId"]), ("contradiction", "error", "likely", f"{0xB7:016x}"))
        self.assertEqual(f["conflict"]["claim"], 52999)
        self.assertEqual(f["conflict"]["evidence"], 47999)
        self.assertIn("52,999", f["explanation"])
        self.assertIn("47,999", f["explanation"])
        self.assertIn("'search_products'", f["explanation"])
        self.assertEqual([p["name"] for p in f["path"]], ["laptop_agent", "react_loop", "search_products"])   # root -> culprit
        self.assertEqual(r["suspectedPath"], f["path"])
        self.assertTrue(r["headline"].startswith("Likely:"))
        self.assertIn("lead, not a proven root cause", r["caveats"][0])
        self.assertIn("potentialMetrics", f)                       # no evaluation run: metrics are only "potential"
        self.assertEqual(f["affectedMetrics"], [])
        self.assertIn("not part of an evaluation run", " ".join(r["caveats"]))

    def test_the_price_the_user_asked_for_is_not_treated_as_a_claim(self):
        ok = trace([ROOT, CHAIN, tool(0x11)], output="The cheapest laptop under ₹50,000 is the Acme Book 14 at ₹47,999.")
        self.assertEqual(analyze_trace(ok)["verdict"], "clean")

    def test_span_error_and_swallowed_error(self):
        t = trace([ROOT, CHAIN, tool(0x12, status="error", out={}, error="HTTP 500 from catalogue")], output="Here is a general answer.")
        r = analyze_trace(t)
        kinds = {f["type"]: f for f in r["findings"]}
        self.assertEqual((kinds["span_error"]["severity"], kinds["span_error"]["certainty"]), ("error", "observed"))
        self.assertIn("HTTP 500 from catalogue", kinds["span_error"]["explanation"])
        self.assertEqual(kinds["swallowed_error"]["severity"], "warning")
        self.assertEqual(r["verdict"], "failed")

    def test_trace_level_error_without_a_failing_step(self):
        r = analyze_trace(trace([ROOT], status="error", error={"message": "timeout"}, output=None))
        self.assertEqual(r["findings"][0]["type"], "trace_error")

    def test_empty_tool_output_but_answer_has_numbers(self):
        r = analyze_trace(trace([ROOT, CHAIN, tool(3, out={"results": []})]))
        self.assertIn("empty_tool_output", [f["type"] for f in r["findings"]])
        self.assertEqual(r["verdict"], "suspicious")

    def test_repeated_identical_calls_suggest_a_loop(self):
        t = trace([ROOT, CHAIN, tool(4), tool(5), tool(6)], output="Done.")
        f = next(x for x in analyze_trace(t)["findings"] if x["type"] == "repeated_call")
        self.assertEqual((f["severity"], f["certainty"]), ("warning", "possible"))
        self.assertIn("3 times", f["title"])

    def test_slow_step(self):
        slow = tool(7, dur=2800)
        r = analyze_trace(trace([ROOT, CHAIN, slow], output="Done."))
        f = next(x for x in r["findings"] if x["type"] == "slow_step")
        self.assertEqual((f["severity"], f["certainty"]), ("info", "observed"))
        self.assertIn("93%", f["explanation"])
        self.assertEqual(r["verdict"], "clean")                    # information only

    def test_clean_trace_and_no_evidence_caveat(self):
        r = analyze_trace(trace([ROOT], output="Hello!"))
        self.assertEqual((r["verdict"], r["findings"]), ("clean", []))
        self.assertIn("No tool or retrieval output was recorded", " ".join(r["caveats"]))
        self.assertEqual(r["headline"], "No problems were detected in the recorded steps.")

    def test_evaluation_results_attach_affected_metrics_and_add_what_rules_cannot_see(self):
        t = trace([ROOT, CHAIN, tool(0xB7)])
        claim = t["output"]
        results = [{"runId": "r1", "testCaseId": "c1", "status": "failed", "metrics": [
            {"metric": "hallucination", "status": "fail", "score": 0.0, "findings": [{"claim": claim, "classification": "contradicted", "reason": "claim says 52999 but the evidence says 47999", "evidence": [{"spanId": f"{0xB7:016x}", "text": "x"}]}]},
            {"metric": "tool_usage", "status": "fail", "score": 0.77, "findings": [{"check": "interpretation", "ok": False, "message": "answer contradicts tool output", "claim": claim}, {"check": "selection", "ok": False, "message": "expected tool 'pay' was never called"}]},
            {"metric": "accuracy", "status": "fail", "score": 0.4, "explanation": "Semantic comparison (lexical).", "findings": []},
            {"metric": "relevance", "status": "pass", "score": 1.0, "findings": []}]}]
        r = analyze_trace(t, results)
        contra = next(f for f in r["findings"] if f["type"] == "contradiction")
        self.assertEqual(sorted(contra["affectedMetrics"]), ["hallucination", "tool_usage"])      # merged, not duplicated
        self.assertNotIn("potentialMetrics", contra)
        self.assertEqual(sum(1 for f in r["findings"] if f["claim"] and f["claim"] == claim), 1)
        self.assertIn("evaluation_check", [f["type"] for f in r["findings"]])                     # 'pay' was never called
        mf = next(f for f in r["findings"] if f["type"] == "metric_failed")
        self.assertEqual((mf["affectedMetrics"], mf["explanation"]), (["accuracy"], "Semantic comparison (lexical)."))
        self.assertEqual({m["metric"] for m in r["failedMetrics"]}, {"hallucination", "tool_usage", "accuracy"})
        self.assertNotIn("not part of an evaluation run", " ".join(r["caveats"]))
        self.assertEqual([f["id"] for f in r["findings"]], [f"f{i}" for i in range(1, len(r["findings"]) + 1)])

    def test_findings_are_sorted_most_serious_first(self):
        r = analyze_trace(trace([ROOT, CHAIN, tool(0xB7), tool(4), tool(5), tool(6, dur=2900)]))
        sev = [f["severity"] for f in r["findings"]]
        self.assertEqual(sev, sorted(sev, key=lambda s: {"error": 0, "warning": 1, "info": 2}[s]))

    def test_bad_input(self):
        with self.assertRaises(ValueError):
            analyze_trace("nope")
        self.assertEqual(analyze_trace({"status": "success", "output": "Hi", "spans": [None, 5, {"x": 1}]})["verdict"], "clean")   # junk spans ignored


class DebugEndpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = Server(("127.0.0.1", 0), make_handler("t" * 24))
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown(); cls.srv.server_close()

    def post(self, body, token="t" * 24):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("POST", "/v1/debug", body=json.dumps(body), headers={"X-Engine-Token": token, "Content-Type": "application/json"})
        r = c.getresponse(); out = (r.status, json.loads(r.read())); c.close(); return out

    def test_endpoint(self):
        s, body = self.post({"trace": trace([ROOT, CHAIN, tool(0xB7)])})
        self.assertEqual((s, body["verdict"]), (200, "failed"))
        self.assertEqual(self.post({"trace": 5})[0], 400)
        self.assertEqual(self.post({"trace": {}}, token="wrong")[0], 401)


if __name__ == "__main__":
    unittest.main()


class UnitInExplanation(unittest.TestCase):
    def test_explanation_names_the_unit_for_counts(self):
        spans = [ROOT, CHAIN, tool(9, name="get_shipping_info", out={"zip": "560001", "days": 3})]
        t = trace(spans, input="How long does delivery take?", output="Delivery takes 5 days.")
        f = analyze_trace(t)["findings"][0]
        self.assertEqual((f["type"], f["certainty"]), ("contradiction", "possible"))        # 0.8 confidence -> a lead, not "likely"
        self.assertIn("5 days", f["explanation"])
        self.assertIn("3 days", f["explanation"])
        self.assertEqual(analyze_trace(trace(spans, input="How long does delivery take?", output="Delivery takes 3 days."))["verdict"], "clean")


class ErrorPropagation(unittest.TestCase):
    def test_only_the_deepest_failing_step_is_reported_and_propagation_is_mentioned(self):
        err = {"message": "Upstream timeout after 30s"}
        root = {**ROOT, "status": "error", "error": err}
        chain = {**CHAIN, "status": "error", "error": err}
        t = trace([root, chain, tool(5, status="error", out={}, error="Upstream timeout after 30s")], status="error", output=None, error={"message": "Upstream timeout after 30s"})
        r = analyze_trace(t)
        errs = [f for f in r["findings"] if f["type"] == "span_error"]
        self.assertEqual(len(errs), 1)
        self.assertEqual(errs[0]["title"], "Step 'search_products' failed")
        self.assertIn("propagated up through 'react_loop', 'laptop_agent'", errs[0]["explanation"])
        self.assertEqual([p["name"] for p in errs[0]["path"]], ["laptop_agent", "react_loop", "search_products"])
        self.assertEqual(r["verdict"], "failed")
        self.assertTrue(r["headline"].startswith("Observed:"))

    def test_two_independent_failures_are_both_reported(self):
        a, b = tool(6, status="error", out={}, error="a failed"), tool(7, name="other", status="error", out={}, error="b failed")
        r = analyze_trace(trace([ROOT, CHAIN, a, b], output="x"))
        self.assertEqual(sum(1 for f in r["findings"] if f["type"] == "span_error"), 2)
