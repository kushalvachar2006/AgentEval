import copy
import json
import unittest
from pathlib import Path

from agenteval import AgentEval, validate_trace

FIX = Path(__file__).resolve().parents[3] / "packages" / "trace-schema" / "fixtures"
load = lambda name: json.loads((FIX / name).read_text(encoding="utf-8"))


def apply_ops(trace, ops):
    t = copy.deepcopy(trace)
    for op in ops:
        keys = [int(k) if k.isdigit() else k for k in op["path"].split(".")]
        cur = t
        for k in keys[:-1]:
            cur = cur[k]
        if op.get("delete"):
            del cur[keys[-1]]
        else:
            cur[keys[-1]] = op["value"]
    return t


class TraceContract(unittest.TestCase):
    def test_valid_fixture_accepted(self):
        self.assertEqual(validate_trace(load("valid-trace.json")), [])

    def test_invalid_cases_rejected_at_expected_path(self):
        base = load("valid-trace.json")
        for case in load("invalid-cases.json"):
            with self.subTest(case["name"]):
                errs = validate_trace(apply_ops(base, case["ops"]))
                self.assertTrue(errs, "expected errors")
                self.assertTrue(any(case["expectPath"] in e["path"] for e in errs), errs)

    def test_non_object_and_span_limit(self):
        self.assertTrue(validate_trace(None))
        self.assertTrue(validate_trace(load("valid-trace.json"), max_spans=2))


class ClientConfig(unittest.TestCase):
    def test_valid_and_key_not_in_repr(self):
        c = AgentEval(api_key="sk-secret-123", endpoint="https://agenteval.example.com/")
        self.assertEqual(c.endpoint, "https://agenteval.example.com")
        self.assertNotIn("sk-secret-123", repr(c))

    def test_localhost_http_allowed_remote_http_rejected(self):
        AgentEval(api_key="k", endpoint="http://localhost:4000")
        with self.assertRaises(ValueError):
            AgentEval(api_key="k", endpoint="http://evil.example.com")

    def test_bad_inputs(self):
        for kw in ({"api_key": ""}, {"endpoint": "ftp://x"}, {"sampling_rate": 1.5}, {"timeout": 0}):
            args = {"api_key": "k", "endpoint": "https://a.example.com", **kw}
            with self.subTest(kw), self.assertRaises(ValueError):
                AgentEval(**args)


if __name__ == "__main__":
    unittest.main()
