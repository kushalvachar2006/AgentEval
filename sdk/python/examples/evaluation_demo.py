"""Run an SDK-mode evaluation from your own machine - NO LangChain and NO LLM key needed.

1. In the website: Test suites -> create a suite and import cases; Evaluations -> start a run with mode "SDK (my code)".
2. Copy the run id, then:

    export AGENTEVAL_API_KEY=ae_live_...   # a key with the "Allow evaluation runs" option (create it on the agent page)
    export AGENTEVAL_RUN_ID=<run id>
    python sdk/python/examples/evaluation_demo.py

The demo agent answers the laptop question with a wrong price on purpose (the tool says 47,999, it says 52,999) and the other
sample questions correctly, so the report shows one explained failure and two passes.
For a real LangChain / LangGraph agent replace `my_agent` with:
    lambda text, config: graph.invoke({"question": text}, config=config)
"""
import os
import sys

from agenteval import AgentEval
from agenteval.builder import TraceBuilder


def my_agent(text, config):
    """A pretend agent. Returns the trace it built (the SDK tags it and sends it)."""
    q = str(text).lower()
    b = TraceBuilder("ignored-the-SDK-fills-this-in", "custom", input=text, agent_version="demo-1")
    b.begin_span("root", None, "agent", "demo_agent", input=text)
    if "laptop" in q:
        b.begin_span("tool", "root", "tool", "search_products", tool={"name": "search_products", "input": {"query": "laptop", "maxPrice": 50000}})
        b.end_span("tool", tool={"output": {"results": [{"name": "Acme Book 14", "priceInr": 47999}]}})
        answer = "The cheapest laptop under ₹50,000 is the Acme Book 14 at ₹52,999."      # <- the planted bug
    elif "refund" in q:
        answer = "Refunds are available within 30 days of purchase."
    else:
        answer = "Hello!"
    b.end_span("root", output=answer)
    return b.finish(output=answer)


if __name__ == "__main__":
    key, run_id = os.getenv("AGENTEVAL_API_KEY"), os.getenv("AGENTEVAL_RUN_ID")
    if not key or not run_id:
        sys.exit("Set AGENTEVAL_API_KEY and AGENTEVAL_RUN_ID first (see the top of this file).")
    with AgentEval(api_key=key, endpoint=os.getenv("AGENTEVAL_ENDPOINT", "http://localhost:4000")) as client:
        summary = client.run_evaluation(run_id, my_agent)
        print(f"Sent {summary['sent']} of {summary['total']} traces. Agent errors: {len(summary['agentErrors'])}")
        print("Open the Evaluations page in the website to watch the results arrive.")
