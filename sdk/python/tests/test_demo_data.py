import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))
from generate_demo_data import generate  # noqa: E402

from agenteval import validate_trace  # noqa: E402

NOW = datetime(2026, 11, 10, 12, tzinfo=timezone.utc)


class DemoData(unittest.TestCase):
    def test_valid_repeatable_and_always_marked_as_demo(self):
        a = generate("a" * 24, days=10, per_day=5, now=NOW)
        self.assertEqual(len(a), 50)
        self.assertTrue(all(validate_trace(t) == [] for t in a))
        self.assertTrue(all(t["metadata"] == {"demo": True} for t in a))         # the website labels these "demo"
        self.assertEqual(len({t["traceId"] for t in a}), 50)
        b = generate("a" * 24, days=10, per_day=5, now=NOW)
        self.assertEqual([(t["startedAt"], t["status"], t["output"]) for t in a], [(t["startedAt"], t["status"], t["output"]) for t in b])   # same seed, same data

    def test_two_versions_with_a_visible_improvement_and_spread_over_days(self):
        ts = generate("a" * 24, now=NOW)
        v = {x: [t for t in ts if t["agentVersion"] == x] for x in ("1.0.0", "1.1.0")}
        self.assertEqual((len(v["1.0.0"]), len(v["1.1.0"])), (56, 56))
        mean = lambda xs: sum(xs) / len(xs)  # noqa: E731
        self.assertLess(mean([t["durationMs"] for t in v["1.1.0"]]), mean([t["durationMs"] for t in v["1.0.0"]]))
        err = lambda xs: sum(t["status"] == "error" for t in xs) / len(xs)  # noqa: E731
        self.assertLess(err(v["1.1.0"]), err(v["1.0.0"]))
        self.assertEqual(len({t["startedAt"][:10] for t in ts}), 14)
        self.assertTrue(all(t["startedAt"] < NOW.isoformat() for t in ts))        # all in the past

    def test_planted_problems_exist(self):
        ts = generate("a" * 24, now=NOW)
        outs = [t["output"] for t in ts if t["output"]]
        self.assertTrue(any("52,999" in o for o in outs))
        self.assertTrue(any("5 days" in o for o in outs))
        self.assertTrue(any(t["status"] == "error" and t["error"]["message"].startswith("Upstream") for t in ts))
        self.assertTrue(all(t["usage"]["totalTokens"] == t["usage"]["inputTokens"] + t["usage"]["outputTokens"] for t in ts))


if __name__ == "__main__":
    unittest.main()
