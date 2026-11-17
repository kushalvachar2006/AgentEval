import unittest

from agenteval_engine import EvaluatorResult, decide_status


class Decide(unittest.TestCase):
    def test_threshold(self):
        self.assertEqual(decide_status(0.9, 0.9, 0.7), "pass")
        self.assertEqual(decide_status(0.45, 0.93, 0.7), "fail")

    def test_low_confidence_is_inconclusive_even_with_high_score(self):
        self.assertEqual(decide_status(0.99, 0.2, 0.7), "inconclusive")

    def test_missing_score_is_inconclusive(self):
        self.assertEqual(decide_status(None, 0.9, 0.7), "inconclusive")


class Result(unittest.TestCase):
    def test_spec_example_serializes(self):
        r = EvaluatorResult(metric="groundedness", score=0.45, status="fail", confidence=0.93, threshold=0.7,
                            explanation="One claim is unsupported.", evaluator_version="1.0.0",
                            findings=[{"claim": "Premium users receive an additional 15 days.", "classification": "unsupported", "evidence": []}])
        d = r.to_dict()
        self.assertEqual(d["evaluatorVersion"], "1.0.0")
        self.assertEqual(d["status"], "fail")

    def test_rejects_bad_values(self):
        bad = [
            EvaluatorResult(metric="x", status="pass", evaluator_version="1.0.0"),                       # pass without score
            EvaluatorResult(metric="x", status="maybe", evaluator_version="1.0.0"),
            EvaluatorResult(metric="x", status="fail", score=1.5, evaluator_version="1.0.0"),
            EvaluatorResult(metric="x", status="inconclusive", evaluator_version="v1"),
            EvaluatorResult(metric="x", status="inconclusive", evaluator_version="1.0.0", findings=[{"classification": "false"}]),
        ]
        for r in bad:
            with self.subTest(r), self.assertRaises(ValueError):
                r.to_dict()

    def test_inconclusive_without_score_is_ok(self):
        EvaluatorResult(metric="x", status="inconclusive", evaluator_version="1.0.0").to_dict()


if __name__ == "__main__":
    unittest.main()
