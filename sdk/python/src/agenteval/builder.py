"""Framework-independent trace builder. Adapters (LangChain, LangGraph, custom) call begin_span/end_span;
the builder produces a dict conforming to the normalized trace schema 1.0."""
from __future__ import annotations

import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from .trace import SCHEMA_VERSION


def _hex_id(nbytes: int) -> str:
    while True:
        v = secrets.token_hex(nbytes)
        if set(v) != {"0"}:
            return v


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


class TraceBuilder:
    def __init__(self, agent_id: str, framework_name: str, *, framework_version: Optional[str] = None,
                 agent_version: Optional[str] = None, session_id: Optional[str] = None,
                 environment: str = "production", input: Any = None, metadata: Optional[dict] = None) -> None:
        self.trace_id = _hex_id(16)
        self.agent_id = agent_id
        self._start = datetime.now(timezone.utc)
        self._t0 = time.perf_counter()  # monotonic: timestamps can never go backwards even if the wall clock does
        self._framework = {"name": framework_name, **({"version": framework_version} if framework_version else {})}
        self._agent_version, self.session_id, self._environment = agent_version, session_id, environment
        self._input, self._metadata = input, metadata
        self.spans: list[dict] = []
        self._open: dict[str, tuple[dict, float]] = {}
        self._ids: dict[str, str] = {}

    def _at(self) -> tuple[str, float]:
        elapsed = time.perf_counter() - self._t0
        return _iso(self._start + timedelta(seconds=elapsed)), elapsed

    def span_id(self, key: str) -> Optional[str]:
        return self._ids.get(key)

    def begin_span(self, key: str, parent_key: Optional[str], span_type: str, name: str, *, input: Any = None, **extra: Any) -> str:
        sid = _hex_id(8)
        started, elapsed = self._at()
        span = {"spanId": sid, "parentSpanId": self._ids.get(parent_key) if parent_key else None, "type": span_type,
                "name": (name or span_type)[:256], "status": "success", "startedAt": started}
        if input is not None:
            span["input"] = input
        span.update({k: v for k, v in extra.items() if v is not None})
        self.spans.append(span)
        self._open[key] = (span, elapsed)
        self._ids[key] = sid
        return sid

    def update_span(self, key: str, **fields: Any) -> None:
        if key in self._open:
            self._open[key][0].update({k: v for k, v in fields.items() if v is not None})

    def end_span(self, key: str, *, output: Any = None, error: Optional[dict] = None, status: Optional[str] = None, **fields: Any) -> None:
        entry = self._open.pop(key, None)
        if entry is None:
            return
        span, began = entry
        ended, elapsed = self._at()
        span["endedAt"], span["durationMs"] = ended, max(0, round((elapsed - began) * 1000))
        if output is not None:
            span["output"] = output
        for k, v in fields.items():
            if v is not None:
                if isinstance(v, dict) and isinstance(span.get(k), dict):
                    span[k] = {**span[k], **v}
                else:
                    span[k] = v
        if error:
            span["status"], span["error"] = status or "error", error
        elif status:
            span["status"] = status

    def finish(self, *, status: str = "success", output: Any = None, error: Optional[dict] = None) -> dict:
        ended, elapsed = self._at()
        for key in list(self._open):  # anything still open was interrupted
            self.end_span(key, status="cancelled")
        if status == "error" and not error:
            error = {"type": "Error", "message": "unknown error"}
        trace: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION, "traceId": self.trace_id, "agentId": self.agent_id, "environment": self._environment,
            "framework": self._framework, "status": status, "input": self._input, "output": output,
            "startedAt": _iso(self._start), "endedAt": ended, "durationMs": max(0, round(elapsed * 1000)), "spans": self.spans,
        }
        if self._agent_version:
            trace["agentVersion"] = self._agent_version
        if self.session_id:
            trace["sessionId"] = self.session_id
        if error:
            trace["error"] = error
        if self._metadata:
            trace["metadata"] = self._metadata
        usage = self._sum_usage()
        if usage:
            trace["usage"] = usage
        return trace

    def _sum_usage(self) -> Optional[dict]:
        i = o = t = 0
        seen = False
        for s in self.spans:
            u = (s.get("llm") or {}).get("usage") if s["type"] == "llm" else None
            if u:
                seen = True
                i += u.get("inputTokens", 0)
                o += u.get("outputTokens", 0)
                t += u.get("totalTokens", u.get("inputTokens", 0) + u.get("outputTokens", 0))
        return {"inputTokens": i, "outputTokens": o, "totalTokens": t} if seen else None
