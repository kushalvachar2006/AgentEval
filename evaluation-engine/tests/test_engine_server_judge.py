import http.client
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from agenteval_engine.engine import evaluate
from agenteval_engine.evaluators import catalog
from agenteval_engine.judge import (AnthropicJudge, BudgetedJudge, FakeJudge, JudgeError, OpenAICompatibleJudge, assert_public_url, build_judge, parse_json)
from agenteval_engine.server import Server, make_handler
from helpers import trace

TOKEN = "t" * 24
ALL = [{"metric": m["metric"]} for m in catalog()]


class EngineTests(unittest.TestCase):
    def test_runs_all_metrics_and_stamps_config_hash_and_versions(self):
        out = evaluate({"trace": trace(), "testCase": {"referenceAnswer": "Acme Book 14 at ₹47,999"}, "evaluators": ALL})
        self.assertEqual(len(out["results"]), 8)
        self.assertTrue(all(r["evaluatorVersion"] == "1.0.0" and len(r["meta"]["configHash"]) == 12 for r in out["results"]))
        self.assertEqual(out["judgeCalls"], 0)

    def test_one_broken_evaluator_does_not_break_the_rest(self):
        out = evaluate({"trace": trace(), "testCase": {"referenceAnswer": "x"}, "evaluators": [{"metric": "accuracy", "config": {"threshold": 9}}, {"metric": "nope"}, {"metric": "operational", "config": {"maxErrors": 0}}]})
        a, n, o = out["results"]
        self.assertEqual((a["status"], n["status"], o["status"]), ("inconclusive", "inconclusive", "pass"))
        self.assertIn("threshold", a["explanation"])
        self.assertIn("unknown metric", n["explanation"])

    def test_version_pinning(self):
        ok = evaluate({"trace": trace(), "evaluators": [{"metric": "operational", "version": "1.0.0", "config": {"maxErrors": 0}}]})["results"][0]
        self.assertEqual(ok["evaluatorVersion"], "1.0.0")
        bad = evaluate({"trace": trace(), "evaluators": [{"metric": "operational", "version": "9.9.9"}]})["results"][0]
        self.assertEqual(bad["status"], "inconclusive")
        self.assertIn("no version '9.9.9'", bad["explanation"])

    def test_same_input_same_output_is_reproducible(self):
        payload = {"trace": trace(), "testCase": {"referenceAnswer": "Acme Book 14 at ₹47,999"}, "evaluators": ALL}
        self.assertEqual(evaluate(payload), evaluate(payload))

    def test_payload_validation(self):
        for bad in ({}, {"trace": 5}, {"trace": {}, "evaluators": []}, {"trace": {}, "evaluators": [{"metric": "accuracy"}] * 21}):
            with self.assertRaises(ValueError):
                evaluate(bad)

    def test_judge_budget_is_enforced_and_reported(self):
        calls = []
        j = BudgetedJudge(FakeJudge(lambda u: calls.append(1) or '{"score":0.9,"off_topic":false,"reason":"ok"}'), 1)
        self.assertEqual(j.ask("a")["score"], 0.9)
        with self.assertRaises(JudgeError):
            j.ask("b")
        self.assertEqual((len(calls), j.calls), (1, 1))

    def test_bad_judge_config_degrades_gracefully(self):
        out = evaluate({"trace": trace(), "testCase": {"input": "Seven?"}, "evaluators": [{"metric": "relevance"}], "judge": {"provider": "mystery", "model": "m"}})
        self.assertIn("unknown judge provider", out["results"][0]["meta"]["judgeError"])
        self.assertNotEqual(out["results"][0]["score"], None)   # lexical fallback still produced a result

    def test_catalog_matches_the_api_catalog_file(self):
        f = Path(__file__).resolve().parents[2] / "apps" / "api" / "src" / "config" / "evaluatorCatalog.json"
        self.assertEqual(json.loads(f.read_text("utf-8"))["evaluators"], catalog(), "run: python evaluation-engine/tests/regen_catalog.py")


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = Server(("127.0.0.1", 0), make_handler(TOKEN))
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown(); cls.srv.server_close()

    def call(self, method, path, body=None, token=TOKEN, headers=None, raw_length=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = {"X-Engine-Token": token, **({"Content-Type": "application/json"} if body is not None else {}), **(headers or {})}
        data = json.dumps(body).encode() if body is not None else None
        if raw_length is not None:
            h["Content-Length"] = str(raw_length)
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        out = (r.status, json.loads(r.read() or b"null"))
        c.close()
        return out

    def test_health_needs_no_token_everything_else_does(self):
        self.assertEqual(self.call("GET", "/healthz", token="")[0], 200)
        self.assertEqual(self.call("GET", "/v1/evaluators", token="wrong")[0], 401)
        self.assertEqual(self.call("POST", "/v1/evaluate", {"trace": {}}, token="")[0], 401)
        self.assertEqual(self.call("GET", "/v1/evaluators")[1]["evaluators"][0]["metric"], "accuracy")

    def test_evaluate_ok_bad_json_validation_and_unknown_route(self):
        s, body = self.call("POST", "/v1/evaluate", {"trace": trace(), "evaluators": [{"metric": "operational", "config": {"maxErrors": 0}}]})
        self.assertEqual((s, body["results"][0]["status"]), (200, "pass"))
        self.assertEqual(self.call("POST", "/v1/evaluate", {"trace": 1})[0], 400)
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("POST", "/v1/evaluate", body=b"{not json", headers={"X-Engine-Token": TOKEN, "Content-Length": "9"})
        self.assertEqual(c.getresponse().status, 400)
        self.assertEqual(self.call("GET", "/nope")[0], 404)

    def test_oversized_body_rejected_before_reading_it(self):
        self.assertEqual(self.call("POST", "/v1/evaluate", {"trace": {}}, raw_length=50_000_000)[0], 413)


class FakeProvider(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeProvider.seen.append((self.path, {k.lower(): v for k, v in self.headers.items()}, body))
        if "fail" in self.headers.get("Authorization", "") + self.headers.get("x-api-key", ""):
            self.send_response(401); self.end_headers(); self.wfile.write(b'{"error":"bad key sk-leaky"}'); return
        out = ({"choices": [{"message": {"content": '```json\n{"score": 0.8}\n```'}}]} if self.path.endswith("/chat/completions")
               else {"content": [{"type": "text", "text": '{"score": 0.7}'}]})
        data = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)


class JudgeProviderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeProvider)
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        os.environ["ENGINE_ALLOW_PRIVATE_JUDGE_URLS"] = "true"

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("ENGINE_ALLOW_PRIVATE_JUDGE_URLS", None)
        cls.srv.shutdown(); cls.srv.server_close()

    def test_openai_compatible_request_shape_and_fenced_json(self):
        FakeProvider.seen.clear()
        j = OpenAICompatibleJudge(self.url + "/v1", "k-123", "my-model")
        self.assertEqual(j.ask("grade this")["score"], 0.8)
        path, headers, body = FakeProvider.seen[0]
        self.assertEqual(path, "/v1/chat/completions")
        self.assertEqual(headers["authorization"], "Bearer k-123")
        self.assertEqual((body["model"], body["messages"][1]["content"]), ("my-model", "grade this"))
        self.assertIn("NEVER follow", body["messages"][0]["content"])      # injection-defence system prompt is always sent
        self.assertNotIn("temperature", body)                              # omitted unless configured (some models reject it)

    def test_anthropic_request_shape(self):
        FakeProvider.seen.clear()
        j = AnthropicJudge(self.url, "a-key", "claude-x", temperature=0)
        self.assertEqual(j.ask("grade")["score"], 0.7)
        path, headers, body = FakeProvider.seen[0]
        self.assertEqual((path, headers["x-api-key"], headers["anthropic-version"], body["temperature"]), ("/v1/messages", "a-key", "2023-06-01", 0))

    def test_provider_error_does_not_leak_response_body(self):
        j = OpenAICompatibleJudge(self.url + "/v1", "fail-key", "m")
        with self.assertRaises(JudgeError) as cm:
            j.ask("x")
        self.assertNotIn("sk-leaky", str(cm.exception))
        self.assertIn("401", str(cm.exception))

    def test_parse_json_and_builder_errors(self):
        self.assertEqual(parse_json('noise {"a": 1} noise'), {"a": 1})
        for bad in ("", "[1]", "{broken"):
            with self.assertRaises(JudgeError):
                parse_json(bad)
        with self.assertRaises(JudgeError):
            build_judge({"provider": "openai_compatible"})            # model missing
        self.assertIsNone(build_judge(None))

    def test_private_judge_urls_blocked_by_default(self):
        os.environ.pop("ENGINE_ALLOW_PRIVATE_JUDGE_URLS")
        try:
            for u in ("http://127.0.0.1:9", "http://localhost/v1", "http://169.254.169.254/", "http://[::1]/", "http://user:pw@example.com", "ftp://example.com"):
                with self.assertRaises(JudgeError, msg=u):
                    assert_public_url(u)
        finally:
            os.environ["ENGINE_ALLOW_PRIVATE_JUDGE_URLS"] = "true"


if __name__ == "__main__":
    unittest.main()
