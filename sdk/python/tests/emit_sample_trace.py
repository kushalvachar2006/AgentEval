"""Prints one SDK-generated trace as JSON. verify.mjs pipes it through the JS server validator (cross-language contract)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_langchain_handler import AGENT, AgentEvalCallbackHandler, run_laptop_agent  # noqa: E402

out = []
run_laptop_agent(AgentEvalCallbackHandler(out.append, AGENT, agent_version="1.0.0", framework="langgraph"))
print(json.dumps(out[0]))
