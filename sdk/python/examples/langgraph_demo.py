"""LangGraph demo - NO LLM key needed. Two nodes (search -> respond); every node shows up as a span.

    pip install -e "sdk/python[langgraph]"
    (same environment variables as langchain_demo.py)
"""
import os
import sys
from typing import TypedDict

from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph

from agenteval import AgentEval


class State(TypedDict, total=False):
    question: str
    products: dict
    answer: str


@tool
def search_products(query: str, max_price: int) -> dict:
    """Search the product catalogue."""
    return {"results": [{"name": "Acme Book 14", "priceInr": 47999}]}


def search(state: State, config):
    return {"products": search_products.invoke({"query": "laptop", "max_price": 50000}, config=config)}


def respond(state: State):
    return {"answer": "The cheapest laptop under ₹50,000 is the Acme Book 14 at ₹52,999."}


builder = StateGraph(State)
builder.add_node("search", search)
builder.add_node("respond", respond)
builder.add_edge(START, "search")
builder.add_edge("search", "respond")
builder.add_edge("respond", END)
graph = builder.compile()

if __name__ == "__main__":
    key, agent_id = os.getenv("AGENTEVAL_API_KEY"), os.getenv("AGENTEVAL_AGENT_ID")
    if not key or not agent_id:
        sys.exit("Set AGENTEVAL_API_KEY and AGENTEVAL_AGENT_ID first.")
    with AgentEval(api_key=key, endpoint=os.getenv("AGENTEVAL_ENDPOINT", "http://localhost:4000")) as client:
        cfg = client.langgraph_config(agent_id, thread_id="demo-thread-1", agent_version="1.0.0", environment="test")
        print(graph.invoke({"question": "Find the cheapest laptop below ₹50,000."}, config=cfg)["answer"])
        client.flush()
        print("export stats:", client.stats)
