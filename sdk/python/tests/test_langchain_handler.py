"""Simulates the documented LangChain callback sequence. These tests verify OUR logic (span tree, usage, errors,
privacy switches, never-raise). They do NOT prove compatibility with a specific langchain-core release - run
examples/langchain_demo.py against your installed version for that."""
import unittest
from types import SimpleNamespace as NS
from uuid import uuid4

from agenteval import validate_trace
from agenteval.integrations.langchain import AgentEvalCallbackHandler
from agenteval.integrations.langgraph import merge_config

AGENT = "6" * 24


class Msg:  # duck-typed BaseMessage
    def __init__(self, type_, content): self.type, self.content = type_, content


def llm_result(text="hello", usage=True):
    msg = NS(content=text, usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15} if usage else None)
    return NS(generations=[[NS(text=text, message=msg)]], llm_output={"model_name": "gpt-4o-mini"})


def run_laptop_agent(h, price_in_answer="₹52,999"):
    root, chain, llm1, tool, llm2 = (uuid4() for _ in range(5))
    h.on_chain_start({"name": "x"}, {"question": "cheapest laptop under ₹50,000?"}, run_id=root, parent_run_id=None, name="laptop_agent",
                     metadata={"thread_id": "t-1"})
    h.on_chain_start(None, {"q": 1}, run_id=chain, parent_run_id=root, name="react_loop", tags=["seq"], metadata={"langgraph_node": "agent"})
    h.on_chat_model_start({"id": ["langchain", "chat_models", "openai", "ChatOpenAI"]}, [[Msg("human", "find laptop")]], run_id=llm1, parent_run_id=chain,
                          metadata={"ls_provider": "openai", "ls_model_name": "gpt-4o-mini"}, invocation_params={"temperature": 0})
    h.on_llm_end(llm_result("CALL search"), run_id=llm1, parent_run_id=chain)
    h.on_tool_start({"name": "search_products"}, "laptop", run_id=tool, parent_run_id=chain, inputs={"query": "laptop", "max_price": 50000, "api_key": "sk-abcdefghijklmnopqrstuvwxyz"})
    h.on_tool_end({"results": [{"name": "Acme Book 14", "priceInr": 47999}]}, run_id=tool, parent_run_id=chain)
    h.on_llm_start({"name": "ChatFake"}, ["summarise"], run_id=llm2, parent_run_id=chain, invocation_params={"model_name": "fake"})
    h.on_llm_end(llm_result(f"Acme Book 14 at {price_in_answer}"), run_id=llm2, parent_run_id=chain)
    h.on_chain_end({"output": f"Acme Book 14 at {price_in_answer}"}, run_id=chain, parent_run_id=root)
    h.on_chain_end({"output": f"Acme Book 14 at {price_in_answer}"}, run_id=root, parent_run_id=None)
    return root


class Handler(unittest.TestCase):
    def make(self, **kw):
        self.out = []
        return AgentEvalCallbackHandler(self.out.append, AGENT, agent_version="1.0.0", **kw)

    def test_builds_valid_nested_trace(self):
        h = self.make(framework="langgraph")
        run_laptop_agent(h)
        self.assertEqual(len(self.out), 1)
        t = self.out[0]
        self.assertEqual(validate_trace(t), [])
        self.assertEqual((t["status"], t["agentId"], t["agentVersion"], t["sessionId"]), ("success", AGENT, "1.0.0", "t-1"))
        self.assertEqual(t["framework"]["name"], "langgraph")
        types = [s["type"] for s in t["spans"]]
        self.assertEqual(types, ["agent", "chain", "llm", "tool", "llm"])
        by_name = {s["name"]: s for s in t["spans"]}
        root, chain = t["spans"][0], by_name["react_loop"]
        self.assertIsNone(root["parentSpanId"])
        self.assertEqual(chain["parentSpanId"], root["spanId"])
        for s in t["spans"][2:]:
            self.assertEqual(s["parentSpanId"], chain["spanId"])
        self.assertEqual(chain["metadata"]["langgraphNode"], "agent")
        self.assertEqual(t["output"], {"output": "Acme Book 14 at ₹52,999"})

    def test_llm_and_tool_details(self):
        h = self.make()
        run_laptop_agent(h)
        t = self.out[0]
        llm1, tool, llm2 = t["spans"][2], t["spans"][3], t["spans"][4]
        self.assertEqual((llm1["llm"]["provider"], llm1["llm"]["model"]), ("openai", "gpt-4o-mini"))
        self.assertEqual(llm1["llm"]["usage"], {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15})
        self.assertEqual(llm1["input"], [{"role": "human", "content": "find laptop"}])
        self.assertEqual(llm2["llm"]["model"], "gpt-4o-mini")  # end-of-run model name overrides the placeholder
        self.assertEqual(tool["tool"]["name"], "search_products")
        self.assertEqual(tool["tool"]["output"]["results"][0]["priceInr"], 47999)
        self.assertEqual(t["usage"], {"inputTokens": 20, "outputTokens": 10, "totalTokens": 30})
        self.assertGreaterEqual(t["durationMs"], 0)

    def test_tool_error_marks_span_but_trace_still_succeeds(self):
        h = self.make()
        root, tool = uuid4(), uuid4()
        h.on_chain_start({}, {"q": 1}, run_id=root, parent_run_id=None, name="a")
        h.on_tool_start({"name": "t"}, "x", run_id=tool, parent_run_id=root)
        h.on_tool_error(ValueError("bad input"), run_id=tool, parent_run_id=root)
        h.on_chain_end({"ok": True}, run_id=root, parent_run_id=None)
        t = self.out[0]
        self.assertEqual(validate_trace(t), [])
        self.assertEqual((t["status"], t["spans"][1]["status"], t["spans"][1]["error"]["type"]), ("success", "error", "ValueError"))

    def test_root_error_fails_trace(self):
        h = self.make()
        root, llm = uuid4(), uuid4()
        h.on_chain_start({}, {"q": 1}, run_id=root, parent_run_id=None, name="a")
        h.on_llm_start({}, ["p"], run_id=llm, parent_run_id=root)
        h.on_llm_error(RuntimeError("rate limited"), run_id=llm, parent_run_id=root)
        h.on_chain_error(RuntimeError("rate limited"), run_id=root, parent_run_id=None)
        t = self.out[0]
        self.assertEqual(validate_trace(t), [])
        self.assertEqual((t["status"], t["error"]["message"]), ("error", "rate limited"))

    def test_cancelled_error_and_unfinished_spans(self):
        h = self.make()
        root = uuid4()
        h.on_chain_start({}, {}, run_id=root, parent_run_id=None, name="a")
        h.on_chain_error(KeyboardInterrupt(), run_id=root, parent_run_id=None)
        self.assertEqual(self.out[0]["status"], "cancelled")

    def test_privacy_switches(self):
        h = self.make(capture_tool_io=False)
        run_laptop_agent(h)
        tool = self.out[0]["spans"][3]
        self.assertEqual(tool["tool"], {"name": "search_products"})
        h2 = self.make(capture_io=False, capture_tool_io=False)
        run_laptop_agent(h2)
        t = self.out[0]
        self.assertEqual(validate_trace(t), [])
        self.assertIsNone(t["input"])
        self.assertNotIn("output", t["spans"][2])
        self.assertNotIn("input", t["spans"][2])

    def test_never_raises_on_unknown_or_malformed_events(self):
        h = self.make()
        h.on_chain_end({}, run_id=uuid4())                      # end without start
        h.on_tool_error(Exception("x"), run_id=uuid4())
        h.on_llm_end(object(), run_id=uuid4())
        h.on_chain_start(None, object(), run_id="not-a-uuid", parent_run_id=None)  # odd types are tolerated
        h.on_chat_model_start(None, [], run_id=uuid4(), parent_run_id=None)
        self.assertEqual(self.out, [])

    def test_sink_failure_does_not_propagate(self):
        h = AgentEvalCallbackHandler(lambda t: 1 / 0, AGENT)
        root = uuid4()
        h.on_chain_start({}, {}, run_id=root, parent_run_id=None, name="a")
        h.on_chain_end({}, run_id=root, parent_run_id=None)

    def test_two_concurrent_runs_stay_separate_and_state_is_released(self):
        h = self.make()
        a, b, la = uuid4(), uuid4(), uuid4()
        h.on_chain_start({}, {"n": "a"}, run_id=a, parent_run_id=None, name="A")
        h.on_chain_start({}, {"n": "b"}, run_id=b, parent_run_id=None, name="B")
        h.on_llm_start({}, ["p"], run_id=la, parent_run_id=a)
        h.on_llm_end(llm_result(), run_id=la, parent_run_id=a)
        h.on_chain_end({}, run_id=b, parent_run_id=None)
        h.on_chain_end({}, run_id=a, parent_run_id=None)
        self.assertEqual(sorted(len(t["spans"]) for t in self.out), [1, 2])
        self.assertEqual((h._builders, h._root_of), ({}, {}))
        self.assertEqual(len({t["traceId"] for t in self.out}), 2)

    def test_max_active_guard(self):
        h = self.make(max_active=1)
        h.on_chain_start({}, {}, run_id=uuid4(), parent_run_id=None, name="a")
        h.on_chain_start({}, {}, run_id=uuid4(), parent_run_id=None, name="b")
        self.assertEqual(len(h._builders), 1)

    def test_secrets_are_redacted_by_transport_path(self):
        from agenteval.redact import sanitize
        run_laptop_agent(self.make())
        clean, n = sanitize(self.out[0])
        self.assertIn("sk-abcdefghijklmnopqrstuvwxyz", str(self.out[0]["spans"][3]["tool"]["input"]))  # handler itself keeps raw data...
        self.assertNotIn("sk-abcdef", str(clean))                                                     # ...redaction happens before sending
        self.assertGreaterEqual(n, 1)


class LangGraphConfig(unittest.TestCase):
    def test_merge_preserves_existing_config(self):
        h = object()
        cfg = merge_config(h, thread_id="t9", config={"callbacks": ["x"], "configurable": {"k": 1}, "tags": ["a"]})
        self.assertEqual(cfg["callbacks"], ["x", h])
        self.assertEqual(cfg["configurable"], {"k": 1, "thread_id": "t9"})
        self.assertEqual(cfg["metadata"], {"session_id": "t9"})
        self.assertEqual(cfg["tags"], ["a"])


if __name__ == "__main__":
    unittest.main()
