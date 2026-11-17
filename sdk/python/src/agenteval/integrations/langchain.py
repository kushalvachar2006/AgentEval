"""LangChain / LangGraph callback handler.

Uses only the documented `langchain_core.callbacks.BaseCallbackHandler` interface (every hook accepts **kwargs so
newer langchain-core versions that add arguments keep working). LangGraph executes nodes as LangChain runnables, so
the SAME handler captures LangGraph runs when passed in the run config - see `langgraph.py`.

Observable events only: inputs, outputs, tool I/O, model metadata, token usage, errors. No hidden reasoning.
The handler never raises into the host application.
"""
from __future__ import annotations

import functools
import logging
import threading
from typing import Any, Callable, Optional

from ..builder import TraceBuilder
from ..redact import sanitize
from ..serialize import to_jsonable

log = logging.getLogger("agenteval")

try:  # real base class when LangChain is installed
    from langchain_core.callbacks import BaseCallbackHandler as _Base  # type: ignore
    LANGCHAIN_AVAILABLE = True
except ImportError:  # lets the SDK (and its tests) work without LangChain installed
    LANGCHAIN_AVAILABLE = False

    class _Base:  # type: ignore[no-redef]
        raise_error = False
        run_inline = False
        ignore_llm = ignore_chain = ignore_agent = ignore_retriever = ignore_chat_model = ignore_retry = ignore_custom_event = False

_CANCEL = {"CancelledError", "KeyboardInterrupt"}


def _dist_version(name: str) -> Optional[str]:
    try:
        from importlib.metadata import version
        return version(name)
    except Exception:  # noqa: BLE001
        return None


def _safe(fn: Callable) -> Callable:
    @functools.wraps(fn)
    def wrapper(self: "AgentEvalCallbackHandler", *a: Any, **kw: Any) -> Any:
        try:
            return fn(self, *a, **kw)
        except Exception:  # noqa: BLE001
            log.warning("agenteval: instrumentation error in %s (ignored)", fn.__name__, exc_info=log.isEnabledFor(logging.DEBUG))
    return wrapper


def _name(serialized: Optional[dict], kwargs: dict, default: str) -> str:
    n = kwargs.get("name") or (serialized or {}).get("name")
    if not n:
        ident = (serialized or {}).get("id")
        n = ident[-1] if isinstance(ident, list) and ident else None
    return str(n or default)


def _err(e: BaseException) -> dict:
    return {"type": type(e).__name__, "message": (str(e) or type(e).__name__)[:10000]}


def _int(v: Any) -> Optional[int]:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def _usage(response: Any) -> Optional[dict]:
    i = o = t = None
    try:
        gens = getattr(response, "generations", None)
        msg = getattr(gens[0][0], "message", None) if gens and gens[0] else None
        um = getattr(msg, "usage_metadata", None)
        if um:
            i, o, t = _int(um.get("input_tokens")), _int(um.get("output_tokens")), _int(um.get("total_tokens"))
        if i is None and o is None:
            lo = getattr(response, "llm_output", None) or {}
            tu = lo.get("token_usage") or lo.get("usage") or {}
            i = _int(tu.get("prompt_tokens", tu.get("input_tokens")))
            o = _int(tu.get("completion_tokens", tu.get("output_tokens")))
            t = _int(tu.get("total_tokens"))
    except Exception:  # noqa: BLE001
        return None
    if i is None and o is None:
        return None
    out = {"inputTokens": i or 0, "outputTokens": o or 0}
    out["totalTokens"] = t if t is not None else out["inputTokens"] + out["outputTokens"]
    return out


class AgentEvalCallbackHandler(_Base):
    name = "agenteval"

    def __init__(self, sink: Callable[[dict], None], agent_id: str, *, agent_version: Optional[str] = None,
                 framework: str = "langchain", environment: str = "production", capture_io: bool = True,
                 capture_tool_io: bool = True, metadata: Optional[dict] = None, max_active: int = 1000) -> None:
        super().__init__()
        self._sink, self._agent_id, self._agent_version = sink, agent_id, agent_version
        self._framework, self._env, self._meta = framework, environment, metadata
        self._capture_io, self._capture_tool_io, self._max_active = capture_io, capture_tool_io, max_active
        self._fw_version = _dist_version("langgraph" if framework == "langgraph" else "langchain-core")
        self._lock = threading.RLock()
        self._root_of: dict[str, str] = {}          # run_id -> root run_id
        self._builders: dict[str, TraceBuilder] = {}  # root run_id -> builder

    # ---- shared plumbing -------------------------------------------------------------------------------------
    def _io(self, v: Any, allowed: bool = True) -> Any:
        return to_jsonable(v) if allowed and self._capture_io else None

    def _begin(self, run_id: Any, parent_run_id: Any, span_type: str, name: str, *, input: Any = None, metadata: Optional[dict] = None, tags: Any = None, **extra: Any) -> None:
        rid, pid = str(run_id), (str(parent_run_id) if parent_run_id else None)
        span_meta = {k: v for k, v in {"tags": list(tags) if tags else None, "langgraphNode": (metadata or {}).get("langgraph_node"), "langgraphStep": (metadata or {}).get("langgraph_step")}.items() if v}
        with self._lock:
            if pid is None or pid not in self._root_of:  # new trace (or a child whose parent we never saw)
                if len(self._builders) >= self._max_active:
                    return
                m = metadata or {}
                b = TraceBuilder(self._agent_id, self._framework, framework_version=self._fw_version, agent_version=self._agent_version,
                                 session_id=next((str(m[k]) for k in ("session_id", "thread_id", "conversation_id") if m.get(k)), None),
                                 environment=self._env, input=input if span_type == "chain" else None, metadata=self._meta)
                self._builders[rid], self._root_of[rid] = b, rid
                b.begin_span(rid, None, "agent" if span_type == "chain" else span_type, name, input=input, metadata=span_meta or None, **extra)
            else:
                root = self._root_of[pid]
                self._root_of[rid] = root
                self._builders[root].begin_span(rid, pid, span_type, name, input=input, metadata=span_meta or None, **extra)

    def _end(self, run_id: Any, *, output: Any = None, error: Optional[BaseException] = None, **fields: Any) -> None:
        rid = str(run_id)
        with self._lock:
            root = self._root_of.pop(rid, None)
            b = self._builders.get(root) if root else None
            if b is None:
                return
            e = _err(error) if error is not None else None
            cancelled = error is not None and type(error).__name__ in _CANCEL
            b.end_span(rid, output=output, error=e, status="cancelled" if cancelled else None, **fields)
            if rid != root:
                return
            del self._builders[root]
            for k in [k for k, v in self._root_of.items() if v == root]:
                self._root_of.pop(k, None)
        status = "cancelled" if cancelled else "error" if e else "success"
        trace = b.finish(status=status, output=output, error=e)
        try:
            self._sink(trace)
        except Exception:  # noqa: BLE001
            log.warning("agenteval: sink failed (ignored)")

    # ---- chains (LangGraph nodes and the graph itself are chains) ---------------------------------------------
    @_safe
    def on_chain_start(self, serialized, inputs, *, run_id, parent_run_id=None, tags=None, metadata=None, **kwargs):
        self._begin(run_id, parent_run_id, "chain", _name(serialized, kwargs, "chain"), input=self._io(inputs), metadata=metadata, tags=tags)

    @_safe
    def on_chain_end(self, outputs, *, run_id, parent_run_id=None, **kwargs):
        self._end(run_id, output=self._io(outputs))

    @_safe
    def on_chain_error(self, error, *, run_id, parent_run_id=None, **kwargs):
        self._end(run_id, error=error)

    # ---- LLMs / chat models ----------------------------------------------------------------------------------
    def _llm_begin(self, serialized, run_id, parent_run_id, input, metadata, tags, kwargs):
        m, inv = metadata or {}, kwargs.get("invocation_params") or {}
        ser_kw = (serialized or {}).get("kwargs") or {}
        model = m.get("ls_model_name") or inv.get("model") or inv.get("model_name") or ser_kw.get("model_name") or ser_kw.get("model") or "unknown"
        provider = m.get("ls_provider")
        params = {k: inv[k] for k in ("temperature", "max_tokens", "top_p") if k in inv}
        llm = {"model": str(model), **({"provider": str(provider)} if provider else {}), **({"params": to_jsonable(params)} if params else {})}
        self._begin(run_id, parent_run_id, "llm", _name(serialized, kwargs, str(model)), input=self._io(input), metadata=metadata, tags=tags, llm=llm)

    @_safe
    def on_llm_start(self, serialized, prompts, *, run_id, parent_run_id=None, tags=None, metadata=None, **kwargs):
        self._llm_begin(serialized, run_id, parent_run_id, prompts, metadata, tags, kwargs)

    @_safe
    def on_chat_model_start(self, serialized, messages, *, run_id, parent_run_id=None, tags=None, metadata=None, **kwargs):
        self._llm_begin(serialized, run_id, parent_run_id, messages[0] if messages else [], metadata, tags, kwargs)

    @_safe
    def on_llm_end(self, response, *, run_id, parent_run_id=None, **kwargs):
        text = None
        gens = getattr(response, "generations", None)
        if gens and gens[0]:
            g = gens[0][0]
            text = getattr(g, "text", None) or getattr(getattr(g, "message", None), "content", None)
        model = (getattr(response, "llm_output", None) or {}).get("model_name")
        usage = _usage(response)
        self._end(run_id, output=self._io(text), llm={**({"usage": usage} if usage else {}), **({"model": str(model)} if model else {})} or None)

    @_safe
    def on_llm_error(self, error, *, run_id, parent_run_id=None, **kwargs):
        self._end(run_id, error=error)

    # ---- tools -----------------------------------------------------------------------------------------------
    @_safe
    def on_tool_start(self, serialized, input_str, *, run_id, parent_run_id=None, tags=None, metadata=None, inputs=None, **kwargs):
        name = _name(serialized, kwargs, "tool")
        tool_in = to_jsonable(inputs if inputs is not None else input_str) if self._capture_tool_io else None
        self._begin(run_id, parent_run_id, "tool", name, metadata=metadata, tags=tags, tool={"name": name, **({"input": tool_in} if tool_in is not None else {})})

    @_safe
    def on_tool_end(self, output, *, run_id, parent_run_id=None, **kwargs):
        out = to_jsonable(output) if self._capture_tool_io else None
        self._end(run_id, tool={"output": out} if out is not None else None)

    @_safe
    def on_tool_error(self, error, *, run_id, parent_run_id=None, **kwargs):
        self._end(run_id, error=error)

    # ---- retrievers ------------------------------------------------------------------------------------------
    @_safe
    def on_retriever_start(self, serialized, query, *, run_id, parent_run_id=None, tags=None, metadata=None, **kwargs):
        self._begin(run_id, parent_run_id, "retriever", _name(serialized, kwargs, "retriever"), metadata=metadata, tags=tags, retriever={"query": str(query)[:5000]} if self._capture_io else {})

    @_safe
    def on_retriever_end(self, documents, *, run_id, parent_run_id=None, **kwargs):
        docs = to_jsonable(list(documents)[:20]) if self._capture_io else None
        self._end(run_id, retriever={"documents": docs} if docs is not None else None)

    @_safe
    def on_retriever_error(self, error, *, run_id, parent_run_id=None, **kwargs):
        self._end(run_id, error=error)
