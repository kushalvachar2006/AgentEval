import json
from agenteval_engine.evaluators.base import EvalContext
from agenteval_engine.judge import FakeJudge

LAPTOP_TRACE = {
    "status": "success", "durationMs": 3200, "usage": {"totalTokens": 900},
    "input": "Find the cheapest laptop below ₹50,000.",
    "output": "The cheapest laptop under ₹50,000 is the Acme Book 14 at ₹52,999.",
    "spans": [{"spanId": "a" * 16, "type": "tool", "name": "search_products", "status": "success",
               "tool": {"name": "search_products", "input": {"query": "laptop", "maxPrice": 50000},
                        "output": {"results": [{"name": "Acme Book 14", "priceInr": 47999}]}}}],
}


def trace(**kw):
    t = json.loads(json.dumps(LAPTOP_TRACE))
    t.update(kw)
    return t


def ctx(trace_=None, case=None, config=None, judge=None):
    return EvalContext(trace=trace_ or trace(), test_case=case or {}, config=config or {}, judge=judge)


def judge_returning(obj):
    j = FakeJudge(lambda user: json.dumps(obj) if not callable(obj) else json.dumps(obj(user)))
    return j
