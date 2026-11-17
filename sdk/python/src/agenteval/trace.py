"""Normalized AgentEval trace contract (schemaVersion 1.x).

Mirrors apps/api/src/modules/traces/traceSchema.js. Both are verified against
packages/trace-schema/fixtures so the SDK and server cannot silently drift apart.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

SCHEMA_VERSION = "1.0"
DEFAULT_MAX_SPANS = 5000

_TRACE_ID = re.compile(r"^[0-9a-f]{32}$")
_SPAN_ID = re.compile(r"^[0-9a-f]{16}$")
_ISO = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$"
)
_TRACE_STATUS = {"success", "error", "cancelled", "timeout"}
_SPAN_STATUS = {"success", "error", "cancelled"}
_SPAN_TYPES = {"agent", "chain", "llm", "tool", "retriever", "other"}
_ENVIRONMENTS = {"production", "test", "evaluation"}

Error = dict  # {"path": str, "message": str}


def _is_obj(v: Any) -> bool:
    return isinstance(v, dict)


def _non_neg_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _non_neg_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 and v == v and v != float("inf")


def _non_empty_str(v: Any, mx: int = 256) -> bool:
    return isinstance(v, str) and 0 < len(v) <= mx


def _parse_iso(v: Any) -> datetime | None:
    if not isinstance(v, str):
        return None
    m = _ISO.match(v)
    if not m:
        return None
    y, mo, d, h, mi, s, frac, tz = m.groups()
    try:
        micro = int((frac or "0").ljust(6, "0"))
        if tz == "Z":
            tzinfo = timezone.utc
        else:
            sign = 1 if tz[0] == "+" else -1
            tzinfo = timezone(sign * timedelta(hours=int(tz[1:3]), minutes=int(tz[4:6])))
        return datetime(int(y), int(mo), int(d), int(h), int(mi), int(s), micro, tzinfo=tzinfo)
    except ValueError:
        return None


def _check_times(o: dict, prefix: str, errors: list[Error]) -> None:
    start, end = _parse_iso(o.get("startedAt")), _parse_iso(o.get("endedAt"))
    if start is None:
        errors.append({"path": f"{prefix}startedAt", "message": "must be ISO-8601 with timezone"})
    if end is None:
        errors.append({"path": f"{prefix}endedAt", "message": "must be ISO-8601 with timezone"})
    if start and end and end < start:
        errors.append({"path": f"{prefix}endedAt", "message": "must not be earlier than startedAt"})
    if "durationMs" in o and not _non_neg_num(o["durationMs"]):
        errors.append({"path": f"{prefix}durationMs", "message": "must be a non-negative number"})


def _check_usage(u: Any, path: str, errors: list[Error]) -> None:
    if u is None:
        return
    if not _is_obj(u):
        errors.append({"path": path, "message": "must be an object"})
        return
    for k in ("inputTokens", "outputTokens", "totalTokens"):
        if k in u and not _non_neg_int(u[k]):
            errors.append({"path": f"{path}.{k}", "message": "must be a non-negative integer"})
    if "estimatedCostUsd" in u and not _non_neg_num(u["estimatedCostUsd"]):
        errors.append({"path": f"{path}.estimatedCostUsd", "message": "must be a non-negative number"})


def _check_error(err: Any, status: Any, path: str, errors: list[Error]) -> None:
    if err is None:
        if status == "error":
            errors.append({"path": path, "message": 'required when status is "error"'})
        return
    if not _is_obj(err) or not _non_empty_str(err.get("message"), 10000):
        errors.append({"path": f"{path}.message", "message": "must be a non-empty string"})


def _check_span(s: Any, i: int, errors: list[Error]) -> None:
    p = f"spans.{i}"
    if not _is_obj(s):
        errors.append({"path": p, "message": "must be an object"})
        return
    sid = s.get("spanId")
    if not (isinstance(sid, str) and _SPAN_ID.match(sid)) or set(sid) == {"0"}:
        errors.append({"path": f"{p}.spanId", "message": "must be 16 lowercase hex chars (not all zero)"})
    if s.get("type") not in _SPAN_TYPES:
        errors.append({"path": f"{p}.type", "message": "invalid span type"})
    if not _non_empty_str(s.get("name")):
        errors.append({"path": f"{p}.name", "message": "must be a non-empty string"})
    if s.get("status") not in _SPAN_STATUS:
        errors.append({"path": f"{p}.status", "message": "invalid span status"})
    _check_times(s, f"{p}.", errors)
    _check_error(s.get("error"), s.get("status"), f"{p}.error", errors)
    if s.get("type") == "llm":
        llm = s.get("llm")
        if not _is_obj(llm):
            errors.append({"path": f"{p}.llm", "message": "required for llm spans"})
        else:
            if not _non_empty_str(llm.get("model")):
                errors.append({"path": f"{p}.llm.model", "message": "must be a non-empty string"})
            _check_usage(llm.get("usage"), f"{p}.llm.usage", errors)
    if s.get("type") == "tool":
        tool = s.get("tool")
        if not _is_obj(tool):
            errors.append({"path": f"{p}.tool", "message": "required for tool spans"})
        elif not _non_empty_str(tool.get("name")):
            errors.append({"path": f"{p}.tool.name", "message": "must be a non-empty string"})


def validate_trace(t: Any, max_spans: int = DEFAULT_MAX_SPANS) -> list[Error]:
    """Return a list of {path, message} errors; an empty list means the trace is valid."""
    errors: list[Error] = []
    if not _is_obj(t):
        return [{"path": "", "message": "trace must be an object"}]

    sv = t.get("schemaVersion")
    if not (isinstance(sv, str) and re.match(r"^1\.\d+$", sv)):
        errors.append({"path": "schemaVersion", "message": "unsupported; accepts 1.x"})
    tid = t.get("traceId")
    if not (isinstance(tid, str) and _TRACE_ID.match(tid)) or set(tid) == {"0"}:
        errors.append({"path": "traceId", "message": "must be 32 lowercase hex chars (not all zero)"})
    if not _non_empty_str(t.get("agentId"), 128):
        errors.append({"path": "agentId", "message": "must be a non-empty string (max 128)"})
    for k in ("agentVersion", "sessionId"):
        if k in t and not _non_empty_str(t[k], 128):
            errors.append({"path": k, "message": "must be a non-empty string (max 128)"})
    if "environment" in t and t["environment"] not in _ENVIRONMENTS:
        errors.append({"path": "environment", "message": "invalid environment"})
    fw = t.get("framework")
    if not (_is_obj(fw) and _non_empty_str(fw.get("name"), 64)):
        errors.append({"path": "framework.name", "message": "must be a non-empty string"})
    if t.get("status") not in _TRACE_STATUS:
        errors.append({"path": "status", "message": "invalid status"})
    if "input" not in t:
        errors.append({"path": "input", "message": "is required"})
    _check_times(t, "", errors)
    _check_usage(t.get("usage"), "usage", errors)
    _check_error(t.get("error"), t.get("status"), "error", errors)

    spans = t.get("spans")
    if not isinstance(spans, list):
        errors.append({"path": "spans", "message": "must be an array"})
    elif len(spans) > max_spans:
        errors.append({"path": "spans", "message": f"too many spans (max {max_spans})"})
    else:
        for i, s in enumerate(spans):
            _check_span(s, i, errors)
        by_id: dict[str, dict] = {}
        for i, s in enumerate(spans):
            if not (_is_obj(s) and isinstance(s.get("spanId"), str)):
                continue
            if s["spanId"] in by_id:
                errors.append({"path": f"spans.{i}.spanId", "message": "duplicate spanId"})
            else:
                by_id[s["spanId"]] = s
        for i, s in enumerate(spans):
            if _is_obj(s) and s.get("parentSpanId") is not None and s["parentSpanId"] not in by_id:
                errors.append({"path": f"spans.{i}.parentSpanId", "message": "refers to a span that does not exist"})
        for i, s in enumerate(spans):
            if not (_is_obj(s) and isinstance(s.get("spanId"), str)):
                continue
            seen = {s["spanId"]}
            cur = s.get("parentSpanId")
            while cur is not None and cur in by_id:
                if cur in seen:
                    errors.append({"path": f"spans.{i}.parentSpanId", "message": "parent chain contains a cycle"})
                    break
                seen.add(cur)
                cur = by_id[cur].get("parentSpanId")
    return errors
