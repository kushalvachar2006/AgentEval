"""AgentEval client."""
from __future__ import annotations

import atexit
import logging
import random
import threading
from typing import Any, Callable, Optional
from urllib.parse import urlparse

from .builder import TraceBuilder
from .http import AgentEvalHTTPError, HttpClient
from .integrations.langchain import AgentEvalCallbackHandler
from .integrations.langgraph import merge_config
from .redact import sanitize
from .transport import Transport

log = logging.getLogger("agenteval")
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
_UA = "agenteval-python/0.3.0"


class AgentEval:
    def __init__(self, api_key: str, endpoint: str, *, timeout: float = 10.0, sampling_rate: float = 1.0, batch_size: int = 50,
                 flush_interval: float = 5.0, max_retries: int = 3, max_queue_size: int = 10_000, always_sample_errors: bool = True,
                 validate: bool = True, redact: bool = True, flush_on_exit: bool = True, sender: Optional[Callable[[bytes], Any]] = None,
                 rng: Optional[random.Random] = None) -> None:
        if not isinstance(api_key, str) or not api_key.strip():
            raise ValueError("api_key must be a non-empty string")
        parsed = urlparse(endpoint if isinstance(endpoint, str) else "")
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("endpoint must be an http(s) URL, e.g. https://agenteval.example.com")
        if parsed.scheme == "http" and parsed.hostname not in _LOCAL_HOSTS:
            raise ValueError("plain http is only allowed for localhost; use https so the API key is encrypted in transit")
        if not 0.0 <= sampling_rate <= 1.0:
            raise ValueError("sampling_rate must be between 0.0 and 1.0")
        if timeout <= 0 or batch_size <= 0 or flush_interval <= 0 or max_queue_size <= 0 or max_retries < 0:
            raise ValueError("timeout, batch_size, flush_interval and max_queue_size must be positive; max_retries must be >= 0")

        self._api_key = api_key
        self.endpoint = endpoint.rstrip("/")
        self.timeout, self.sampling_rate = timeout, sampling_rate
        self.batch_size, self.flush_interval = batch_size, flush_interval
        self.max_retries, self.max_queue_size = max_retries, max_queue_size
        self.always_sample_errors, self.validate, self.redact = always_sample_errors, validate, redact
        self._rng = rng or random.Random()
        self._http = HttpClient(self.endpoint, api_key, timeout, _UA)
        self._sender = sender
        self._transport: Optional[Transport] = None
        self._lock = threading.Lock()
        if flush_on_exit:
            atexit.register(self._at_exit)

    def __repr__(self) -> str:  # never reveal the key
        return f"AgentEval(endpoint={self.endpoint!r}, api_key='***')"

    def __enter__(self) -> "AgentEval":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ---- export pipeline ----
    def _ensure_transport(self) -> Transport:
        with self._lock:  # created lazily so constructing a client has no side effects
            if self._transport is None:
                send = self._sender or (lambda body: self._http.request("POST", "/api/v1/traces/batch", raw_body=body))
                self._transport = Transport(send, batch_size=self.batch_size, flush_interval=self.flush_interval, max_retries=self.max_retries,
                                            max_queue=self.max_queue_size, validate=self.validate)
            return self._transport

    def _on_trace(self, trace: dict, force: bool = False) -> None:
        keep = force or (self.always_sample_errors and trace.get("status") == "error") or self._rng.random() < self.sampling_rate
        if keep:
            if self.redact:  # secrets are removed in-process, before anything is queued or sent
                trace, _ = sanitize(trace)
            self._ensure_transport().enqueue(trace)

    def capture(self, trace: dict) -> None:
        """Send a trace you built yourself (custom frameworks). Applies sampling, redaction, batching and retries."""
        self._on_trace(trace)

    def flush(self, timeout: float = 10.0) -> bool:
        return self._transport.flush(timeout) if self._transport else True

    def close(self, timeout: float = 10.0) -> None:
        if self._transport:
            self._transport.close(timeout)

    def _at_exit(self) -> None:
        try:
            self.close(5.0)
        except Exception:  # noqa: BLE001
            pass

    @property
    def stats(self) -> dict:
        return dict(self._transport.stats) if self._transport else {}

    # ---- framework integrations ----
    def langchain_handler(self, agent_id: str, **kw: Any) -> AgentEvalCallbackHandler:
        return AgentEvalCallbackHandler(self._on_trace, agent_id, framework=kw.pop("framework", "langchain"), **kw)

    def langgraph_handler(self, agent_id: str, **kw: Any) -> AgentEvalCallbackHandler:
        return self.langchain_handler(agent_id, framework="langgraph", **kw)

    def langgraph_config(self, agent_id: str, *, thread_id: Optional[str] = None, session_id: Optional[str] = None, config: Optional[dict] = None, **kw: Any) -> dict:
        return merge_config(self.langgraph_handler(agent_id, **kw), thread_id=thread_id, session_id=session_id, config=config)

    def instrument(self, runnable: Any, agent_id: str, *, framework: str = "langchain", **kw: Any) -> Any:
        """Return `runnable` with the AgentEval handler attached (works for chains and compiled LangGraph graphs)."""
        return runnable.with_config({"callbacks": [self.langchain_handler(agent_id, framework=framework, **kw)]})

    # ---- evaluation runs driven from your own code (mode "sdk") ----
    def run_evaluation(self, run_id: str, agent_fn: Callable[[Any, dict], Any], *, agent_version: Optional[str] = None, framework: str = "langchain",
                       flush_timeout: float = 30.0, **handler_kw: Any) -> dict:
        """Run YOUR agent on every pending test case of an evaluation run and send the traces to AgentEval.

        `agent_fn(input, config)` is called once per case. For LangChain/LangGraph pass `config` to your runnable:
            run_evaluation(run_id, lambda text, config: graph.invoke({"question": text}, config=config))
        For custom code return your answer (a minimal trace is built for you) or return a trace dict you built with TraceBuilder.
        Evaluation traces are never sampled out. Nothing leaves your machine except the redacted traces.
        """
        work = self._http.request("GET", f"/api/v1/evaluations/{run_id}/work")
        agent_id = work["agentId"]
        summary: dict = {"runId": run_id, "total": len(work["cases"]), "sent": 0, "agentErrors": []}
        for case in work["cases"]:
            sent: list[dict] = []

            def sink(trace: dict, _case: dict = case, _sent: list = sent) -> None:
                self._send_evaluation_trace(trace, run_id, _case["testCaseId"])
                _sent.append(trace)

            handler = AgentEvalCallbackHandler(sink, agent_id, framework=framework, agent_version=agent_version, environment="evaluation", **handler_kw)
            config = {"callbacks": [handler], "metadata": {"agenteval_run_id": run_id, "agenteval_test_case_id": case["testCaseId"]}}
            result: Any = None
            error: Optional[BaseException] = None
            try:
                result = agent_fn(case["input"], config)
            except Exception as e:  # noqa: BLE001 - one failing case must not stop the run
                error = e
                summary["agentErrors"].append({"testCaseId": case["testCaseId"], "error": f"{type(e).__name__}: {str(e)[:200]}"})
            if not sent:  # the framework did not emit a trace (plain Python agent): use the one you returned, or build a minimal one
                if isinstance(result, dict) and "traceId" in result and "spans" in result:
                    trace = {**result, "agentId": agent_id, "environment": "evaluation"}
                else:
                    trace = self._fallback_trace(agent_id, case["input"], result, error, agent_version)
                self._send_evaluation_trace(trace, run_id, case["testCaseId"])
            summary["sent"] += 1
        self.flush(flush_timeout)
        summary["stats"] = self.stats
        return summary

    def _send_evaluation_trace(self, trace: dict, run_id: str, test_case_id: str) -> None:
        trace.setdefault("metadata", {})["evaluation"] = {"runId": run_id, "testCaseId": test_case_id}
        self._on_trace(trace, force=True)

    @staticmethod
    def _fallback_trace(agent_id: str, input: Any, output: Any, error: Optional[BaseException], agent_version: Optional[str]) -> dict:
        b = TraceBuilder(agent_id, "custom", agent_version=agent_version, environment="evaluation", input=input)
        b.begin_span("root", None, "agent", "agent", input=input)
        if error is not None:
            err = {"type": type(error).__name__, "message": (str(error) or type(error).__name__)[:10000]}
            b.end_span("root", error=err)
            return b.finish(status="error", error=err)
        out = output if isinstance(output, (str, int, float, bool, list, dict)) or output is None else str(output)
        b.end_span("root", output=out)
        return b.finish(status="success", output=out)

    # ---- agent registration ----
    def register_agent(self, name: str, framework: str, *, description: str = "", version: str = "1.0.0", integration_type: str = "sdk", config: Optional[dict] = None) -> dict:
        body = {"name": name, "framework": framework, "description": description, "version": version, "integrationType": integration_type}
        if config:
            body["config"] = config
        return self._http.request("POST", "/api/v1/agents", body=body)

    def get_or_create_agent(self, name: str, framework: str, **kw: Any) -> dict:
        """Idempotent: returns the existing agent with this name or registers it (needs an API key with agents:read + agents:write)."""
        found = self._http.request("GET", "/api/v1/agents", query={"name": name, "limit": 1})
        if found and found.get("items"):
            return found["items"][0]
        try:
            return self.register_agent(name, framework, **kw)
        except AgentEvalHTTPError as e:
            if e.status == 409:  # lost a race with another process
                return self._http.request("GET", "/api/v1/agents", query={"name": name, "limit": 1})["items"][0]
            raise
