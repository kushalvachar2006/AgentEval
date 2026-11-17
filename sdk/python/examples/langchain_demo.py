"""LangChain demo - NO LLM key needed (uses a fake chat model). Sends one trace to your AgentEval server.

    pip install -e "sdk/python[langchain]"
    export AGENTEVAL_API_KEY=ae_live_...      # Windows PowerShell:  $env:AGENTEVAL_API_KEY="ae_live_..."
    export AGENTEVAL_AGENT_ID=<agent id shown in the website>
    python sdk/python/examples/langchain_demo.py

The fake model deliberately answers with the WRONG price (52,999 instead of 47,999) so the Debugging view (Milestone 4)
has a real failure to explain.
"""
import os
import sys

from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.runnables import RunnableLambda
from langchain_core.tools import tool

from agenteval import AgentEval


@tool
def search_products(query: str, max_price: int) -> dict:
    """Search the product catalogue."""
    return {"results": [{"name": "Acme Book 14", "priceInr": 47999}]}


llm = FakeListChatModel(responses=["The cheapest laptop under ₹50,000 is the Acme Book 14 at ₹52,999."])


def agent(question: str, config):
    found = search_products.invoke({"query": "laptop", "max_price": 50000}, config=config)  # config carries our callbacks
    return llm.invoke(f"Question: {question}\nTool result: {found}", config=config).content


chain = RunnableLambda(agent).with_config(run_name="laptop_agent")

if __name__ == "__main__":
    key, agent_id = os.getenv("AGENTEVAL_API_KEY"), os.getenv("AGENTEVAL_AGENT_ID")
    if not key or not agent_id:
        sys.exit("Set AGENTEVAL_API_KEY and AGENTEVAL_AGENT_ID first (see the docstring).")
    with AgentEval(api_key=key, endpoint=os.getenv("AGENTEVAL_ENDPOINT", "http://localhost:4000")) as client:
        handler = client.langchain_handler(agent_id, agent_version="1.0.0", environment="test")
        print(chain.invoke("Find the cheapest laptop below ₹50,000.", config={"callbacks": [handler]}))
        client.flush()
        print("export stats:", client.stats)   # expect accepted: 1
