import json
import unittest
from uuid import uuid4

from agenteval import AgentEval, validate_trace
from agenteval.builder import TraceBuilder

AGENT = "9" * 24
RUN = "5" * 24
WORK = {"runId": RUN, "agentId": AGENT, "cases": [{"testCaseId": "a" * 24, "input": "q1"}, {"testCaseId": "b" * 24, "input": "q2"}, {"testCaseId": "c" * 24, "input": {"k": "v"}}]}


class FakeHttp:
    def __init__(self):
        self.calls = []

    def request(self, method, path, **kw):
        self.calls.append((method, path))
        return WORK


class Recorder:
    def __init__(self):
        self.traces = []

    def __call__(self, body):
        self.traces += json.loads(body)["traces"]
        return {"accepted": len(self.traces), "duplicates": 0, "rejected": 0, "results": []}


def client(rec, **kw):
    c = AgentEval("k", "https://a.example.com", sender=rec, flush_on_exit=False, flush_interval=0.1, **kw)
    c._http = FakeHttp()
    return c


class RunEvaluation(unittest.TestCase):
    def test_plain_python_agent_gets_a_tagged_valid_trace_per_case_even_with_sampling_off(self):
        rec = Recorder()
        with client(rec, sampling_rate=0.0) as c:
            s = c.run_evaluation(RUN, lambda text, cfg: f"answer to {text}")
        self.assertEqual((s["total"], s["sent"], s["agentErrors"]), (3, 3, []))
        self.assertEqual(len(rec.traces), 3)                                  # sampling_rate=0 does NOT drop evaluation traces
        for t, case in zip(rec.traces, WORK["cases"]):
            self.assertEqual(validate_trace(t), [])
            self.assertEqual(t["metadata"]["evaluation"], {"runId": RUN, "testCaseId": case["testCaseId"]})
            self.assertEqual((t["agentId"], t["environment"], t["status"]), (AGENT, "evaluation", "success"))
        self.assertEqual(rec.traces[0]["output"], "answer to q1")
        self.assertEqual(rec.traces[2]["input"], {"k": "v"})

    def test_agent_exception_becomes_an_error_trace_and_the_run_continues(self):
        rec = Recorder()

        def agent(text, cfg):
            if text == "q2":
                raise RuntimeError("model exploded")
            return "ok"

        with client(rec) as c:
            s = c.run_evaluation(RUN, agent)
        self.assertEqual([t["status"] for t in rec.traces], ["success", "error", "success"])
        self.assertEqual(rec.traces[1]["error"]["message"], "model exploded")
        self.assertEqual(s["agentErrors"][0]["error"], "RuntimeError: model exploded")

    def test_returned_trace_dict_is_used_and_retagged(self):
        rec = Recorder()

        def agent(text, cfg):
            b = TraceBuilder("someone-elses-id", "custom", input=text)
            b.begin_span("r", None, "agent", "mine")
            b.begin_span("t", "r", "tool", "search", tool={"name": "search", "input": {"q": text}})
            b.end_span("t", tool={"output": {"ok": 1}})
            b.end_span("r", output="done")
            return b.finish(output="done")

        with client(rec) as c:
            c.run_evaluation(RUN, agent)
        self.assertEqual({t["agentId"] for t in rec.traces}, {AGENT})        # forced to the run's agent
        self.assertEqual(sum(1 for t in rec.traces for s in t["spans"] if s["type"] == "tool"), 3)

    def test_langchain_style_handler_in_config_is_used_and_not_duplicated_by_the_fallback(self):
        rec = Recorder()

        def agent(text, cfg):
            h, rid = cfg["callbacks"][0], uuid4()
            h.on_chain_start({}, {"q": text}, run_id=rid, parent_run_id=None, name="chain")
            h.on_chain_end({"a": 1}, run_id=rid, parent_run_id=None)
            return None

        with client(rec) as c:
            s = c.run_evaluation(RUN, agent, framework="langgraph", agent_version="2.0")
        self.assertEqual(len(rec.traces), 3)                                   # exactly one trace per case
        self.assertEqual((rec.traces[0]["framework"]["name"], rec.traces[0]["agentVersion"], rec.traces[0]["spans"][0]["name"]), ("langgraph", "2.0", "chain"))
        self.assertEqual(rec.traces[1]["metadata"]["evaluation"]["testCaseId"], "b" * 24)
        self.assertEqual(s["sent"], 3)

    def test_secrets_in_agent_output_are_redacted_before_sending(self):
        rec = Recorder()
        with client(rec) as c:
            c.run_evaluation(RUN, lambda t, cfg: "my key is sk-abcdefghijklmnopqrstuvwxyz1234")
        self.assertNotIn("sk-abcdef", json.dumps(rec.traces))

    def test_requests_the_work_list_for_the_given_run(self):
        rec = Recorder()
        c = client(rec)
        c.run_evaluation(RUN, lambda t, cfg: "x")
        c.close()
        self.assertEqual(c._http.calls[0], ("GET", f"/api/v1/evaluations/{RUN}/work"))


if __name__ == "__main__":
    unittest.main()
