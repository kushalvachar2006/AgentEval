import json
import random
import threading
import unittest
from uuid import uuid4

from agenteval import AgentEval, AgentEvalHTTPError
from agenteval.builder import TraceBuilder
from agenteval.http import AgentEvalNetworkError
from agenteval.redact import sanitize
from agenteval.transport import Transport
from agenteval import validate_trace

AGENT = "7" * 24


def make_trace(status="success", output="ok", error=None):
    b = TraceBuilder(AGENT, "langchain", input="hi")
    b.begin_span("r", None, "agent", "root")
    b.begin_span("t", "r", "tool", "search", tool={"name": "search", "input": {"api_key": "sk-abcdefghijklmnopqrstuvwxyz", "q": "x"}})
    b.end_span("t", tool={"output": "found sk-abcdefghijklmnopqrstuvwxyz1234"})
    b.end_span("r", output=output)
    return b.finish(status=status, output=output, error=error)


class Recorder:
    def __init__(self, script=None):
        self.bodies, self.script, self.lock = [], list(script or []), threading.Lock()

    def __call__(self, body):
        with self.lock:
            self.bodies.append(json.loads(body))
            step = self.script.pop(0) if self.script else None
        if isinstance(step, Exception):
            raise step
        n = len(self.bodies[-1]["traces"])
        return {"accepted": n, "duplicates": 0, "rejected": 0, "results": []}

    def traces(self):
        return [t for b in self.bodies for t in b["traces"]]


class Builder(unittest.TestCase):
    def test_trace_is_schema_valid_and_timestamps_monotonic(self):
        t = make_trace()
        self.assertEqual(validate_trace(t), [])
        self.assertEqual(len(t["traceId"]), 32)
        self.assertTrue(all(s["endedAt"] >= s["startedAt"] for s in t["spans"]))

    def test_unfinished_spans_are_cancelled_and_error_synthesised(self):
        b = TraceBuilder(AGENT, "custom", input=None)
        b.begin_span("r", None, "agent", "root")
        t = b.finish(status="error")
        self.assertEqual(validate_trace(t), [])
        self.assertEqual(t["spans"][0]["status"], "cancelled")
        self.assertEqual(t["error"]["message"], "unknown error")


class Redaction(unittest.TestCase):
    def test_keys_values_and_token_counts(self):
        v, n = sanitize({"password": "x", "usage": {"inputTokens": 3}, "text": "Bearer abcdefghijklmnop1234", "nested": [{"apiKey": "k"}]})
        self.assertEqual((v["password"], v["nested"][0]["apiKey"], v["text"], v["usage"]["inputTokens"]), ("[REDACTED]", "[REDACTED]", "[REDACTED]", 3))
        self.assertEqual(n, 3)

    def test_truncate_and_depth(self):
        v, _ = sanitize({"s": "a" * 50}, max_string_len=10)
        self.assertTrue(v["s"].startswith("a" * 10 + "…[truncated 40"))
        deep = {"a": {"b": {"c": {"d": 1}}}}
        self.assertEqual(sanitize(deep, max_depth=2)[0]["a"]["b"], "[DEPTH_LIMIT]")


class ClientExport(unittest.TestCase):
    def client(self, rec, **kw):
        return AgentEval("k", "https://agenteval.example.com", sender=rec, flush_on_exit=False, flush_interval=0.2, **kw)

    def test_batches_and_secrets_never_leave_the_process(self):
        rec = Recorder()
        with self.client(rec, batch_size=10) as c:
            for _ in range(5):
                c._on_trace(make_trace())
            self.assertTrue(c.flush(5))
        sent = json.dumps(rec.bodies)
        self.assertEqual(len(rec.traces()), 5)
        self.assertNotIn("sk-abcdef", sent)
        self.assertIn("[REDACTED]", sent)
        self.assertLessEqual(len(rec.bodies), 5)
        self.assertEqual(c.stats["accepted"], 5)

    def test_public_capture_goes_through_the_same_pipeline(self):
        rec = Recorder()
        with self.client(rec) as c:
            c.capture(make_trace())
            c.flush(5)
        self.assertEqual(len(rec.traces()), 1)
        self.assertNotIn("sk-abcdef", json.dumps(rec.bodies))

    def test_batch_size_is_respected(self):
        rec = Recorder()
        with self.client(rec, batch_size=3) as c:
            for _ in range(7):
                c._on_trace(make_trace())
            c.flush(5)
        self.assertTrue(all(len(b["traces"]) <= 3 for b in rec.bodies))
        self.assertEqual(len(rec.traces()), 7)

    def test_sampling_drops_successes_but_keeps_errors(self):
        rec = Recorder()
        with self.client(rec, sampling_rate=0.0) as c:
            for _ in range(10):
                c._on_trace(make_trace())
            c._on_trace(make_trace(status="error", error={"type": "E", "message": "boom"}))
            c.flush(5)
        self.assertEqual([t["status"] for t in rec.traces()], ["error"])

    def test_sampling_can_drop_errors_too_when_configured(self):
        rec = Recorder()
        with self.client(rec, sampling_rate=0.0, always_sample_errors=False) as c:
            c._on_trace(make_trace(status="error", error={"type": "E", "message": "boom"}))
            c.flush(1)
        self.assertEqual(rec.traces(), [])

    def test_partial_sampling_uses_injected_rng(self):
        rec = Recorder()
        with self.client(rec, sampling_rate=0.5, rng=random.Random(1)) as c:
            for _ in range(200):
                c._on_trace(make_trace())
            c.flush(10)
        self.assertTrue(60 < len(rec.traces()) < 140)

    def test_retries_server_errors_then_succeeds(self):
        rec = Recorder(script=[AgentEvalHTTPError(503, "X", "down"), AgentEvalNetworkError("reset")])
        sleeps = []
        t = Transport(rec, batch_size=5, flush_interval=0.1, max_retries=3, sleep=sleeps.append)
        t.enqueue(make_trace())
        self.assertTrue(t.flush(5))
        t.close()
        self.assertEqual(len(rec.bodies), 3)      # fail, fail, success
        self.assertEqual(t.stats["accepted"], 1)
        self.assertEqual(len(sleeps), 2)
        self.assertGreater(sleeps[1], sleeps[0] - 0.3)  # backoff grows

    def test_does_not_retry_auth_errors_and_gives_up_after_max_retries(self):
        rec = Recorder(script=[AgentEvalHTTPError(401, "INVALID_API_KEY", "bad")])
        t = Transport(rec, flush_interval=0.1, sleep=lambda s: None)
        t.enqueue(make_trace()); t.flush(5)
        self.assertEqual((len(rec.bodies), t.stats["failed"]), (1, 1))
        rec2 = Recorder(script=[AgentEvalHTTPError(500, "X", "x")] * 10)
        t2 = Transport(rec2, flush_interval=0.1, max_retries=2, sleep=lambda s: None)
        t2.enqueue(make_trace()); t2.flush(5)
        self.assertEqual((len(rec2.bodies), t2.stats["failed"]), (3, 1))
        t.close(); t2.close()

    def test_413_splits_the_batch(self):
        rec = Recorder(script=[AgentEvalHTTPError(413, "PAYLOAD_TOO_LARGE", "big")])
        t = Transport(rec, batch_size=4, flush_interval=0.3, sleep=lambda s: None)
        for _ in range(4):
            t.enqueue(make_trace())
        t.flush(5); t.close()
        self.assertEqual(len(rec.traces()), 8)          # rejected full batch (4) + two halves (2+2)
        self.assertEqual(t.stats["accepted"], 4)

    def test_invalid_oversized_and_overflowing_traces_are_dropped_not_raised(self):
        gate = threading.Event()
        t = Transport(lambda body: gate.wait(5) and {"accepted": 1}, batch_size=1, max_queue=2, flush_interval=0.1, validate=True)  # worker holds 1 in flight, queue holds 2
        self.assertFalse(t.enqueue({"nope": 1}))
        big = make_trace(output="x" * (4 * 1024 * 1024))
        self.assertFalse(t.enqueue(big))
        self.assertEqual((t.stats["dropped_invalid"], t.stats["dropped_too_large"]), (1, 1))
        results = [t.enqueue(make_trace()) for _ in range(6)]
        self.assertIn(False, results)
        self.assertGreaterEqual(t.stats["dropped_queue_full"], 1)
        gate.set(); t.close()

    def test_constructing_a_client_starts_no_threads(self):
        before = threading.active_count()
        AgentEval("k", "https://a.example.com", flush_on_exit=False)
        self.assertEqual(threading.active_count(), before)

    def test_register_and_get_or_create_use_expected_requests(self):
        calls = []

        class Fake:
            def request(self, method, path, **kw):
                calls.append((method, path, kw))
                if method == "GET":
                    return {"items": []} if len([c for c in calls if c[0] == "GET"]) == 1 else {"items": [{"id": "A" * 24}]}
                if len(calls) == 2:
                    raise AgentEvalHTTPError(409, "AGENT_NAME_EXISTS", "dup")
                return {"id": "B" * 24}

        c = AgentEval("k", "https://a.example.com", flush_on_exit=False)
        c._http = Fake()
        agent = c.get_or_create_agent("bot", "langchain")
        self.assertEqual(agent["id"], "A" * 24)  # lost the creation race -> re-fetched
        self.assertEqual([x[0] for x in calls], ["GET", "POST", "GET"])
        self.assertEqual(calls[1][2]["body"]["integrationType"], "sdk")

    def test_config_validation_and_secret_not_in_repr(self):
        for kw in ({"api_key": ""}, {"endpoint": "ftp://x"}, {"endpoint": "http://evil.example.com"}, {"sampling_rate": 1.5}, {"timeout": 0}, {"max_retries": -1}):
            with self.subTest(kw), self.assertRaises(ValueError):
                AgentEval(**{"api_key": "k", "endpoint": "https://a.example.com", **kw})
        self.assertNotIn("sk-secret", repr(AgentEval("sk-secret-1", "http://localhost:4000", flush_on_exit=False)))


if __name__ == "__main__":
    unittest.main()
