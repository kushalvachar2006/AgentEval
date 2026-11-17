"""Sends a hand-built demo trace. Needs NO LangChain and NO LLM key - the quickest way to see data in the website.

    pip install -e sdk/python
    export AGENTEVAL_API_KEY=ae_live_...        # Windows PowerShell:  $env:AGENTEVAL_API_KEY="ae_live_..."
    export AGENTEVAL_AGENT_ID=<agent id from the website>
    python sdk/python/examples/send_test_trace.py            # one good trace
    python sdk/python/examples/send_test_trace.py --fail     # one failed trace (try the "error" filter)
    python sdk/python/examples/send_test_trace.py --twice    # same trace sent twice -> 1 accepted, 1 duplicate

The trace contains a deliberate bug (tool says 47,999, answer says 52,999) and a fake secret, so you can check that
the website shows the bug and that the secret was redacted before leaving your computer.
"""
import argparse
import os
import sys

from agenteval import AgentEval
from agenteval.builder import TraceBuilder

QUESTION = "Find the cheapest laptop below ₹50,000."


def build(agent_id: str, fail: bool = False) -> dict:
    b = TraceBuilder(agent_id, "custom", agent_version="1.0.0", environment="test", input=QUESTION)
    b.begin_span("root", None, "agent", "laptop_agent", input=QUESTION)
    b.begin_span("plan", "root", "llm", "planner", input=QUESTION, llm={"provider": "demo", "model": "demo-model"})
    b.end_span("plan", output="CALL search_products", llm={"usage": {"inputTokens": 120, "outputTokens": 12, "totalTokens": 132}})
    b.begin_span("tool", "root", "tool", "search_products",
                 tool={"name": "search_products", "input": {"query": "laptop", "maxPrice": 50000, "api_key": "sk-demo1234567890abcdefghij"}})
    b.end_span("tool", tool={"output": {"results": [{"name": "Acme Book 14", "priceInr": 47999}]}})
    b.begin_span("answer", "root", "llm", "responder", input="Tool result: Acme Book 14 47999. My key is sk-demo1234567890abcdefghij",
                 llm={"provider": "demo", "model": "demo-model"})
    if fail:
        err = {"type": "TimeoutError", "message": "model timed out after 30s"}
        b.end_span("answer", error=err)
        b.end_span("root", error=err)
        return b.finish(status="error", error=err)
    answer = "The cheapest laptop under ₹50,000 is the Acme Book 14 at ₹52,999."
    b.end_span("answer", output=answer, llm={"usage": {"inputTokens": 150, "outputTokens": 20, "totalTokens": 170}})
    b.end_span("root", output=answer)
    return b.finish(status="success", output=answer)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fail", action="store_true")
    ap.add_argument("--twice", action="store_true")
    args = ap.parse_args()
    key, agent_id = os.getenv("AGENTEVAL_API_KEY"), os.getenv("AGENTEVAL_AGENT_ID")
    if not key or not agent_id:
        sys.exit("Set AGENTEVAL_API_KEY and AGENTEVAL_AGENT_ID first (see the top of this file).")
    with AgentEval(api_key=key, endpoint=os.getenv("AGENTEVAL_ENDPOINT", "http://localhost:4000")) as client:
        trace = build(agent_id, fail=args.fail)
        client.capture(trace)
        if args.twice:
            client.flush()
            client.capture(trace)
        client.flush()
        print("export stats:", client.stats)
        print(f"trace id: {trace['traceId']}")
