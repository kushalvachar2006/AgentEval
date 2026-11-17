"""Turn arbitrary framework objects into plain JSON-safe data without ever raising."""
from __future__ import annotations

import dataclasses
import math
from datetime import date, datetime
from typing import Any
from uuid import UUID


def to_jsonable(obj: Any, _depth: int = 0, max_depth: int = 20) -> Any:
    if _depth > max_depth:
        return "[DEPTH_LIMIT]"
    nxt = _depth + 1
    if obj is None or isinstance(obj, (bool, int, str)):
        return obj
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else str(obj)
    if isinstance(obj, (bytes, bytearray)):
        return f"<{len(obj)} bytes>"
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v, nxt) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set, frozenset)):
        return [to_jsonable(v, nxt) for v in obj]
    if isinstance(obj, UUID):
        return str(obj)
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    # LangChain documents
    if hasattr(obj, "page_content"):
        return {"pageContent": to_jsonable(getattr(obj, "page_content", ""), nxt), "metadata": to_jsonable(getattr(obj, "metadata", {}), nxt)}
    # LangChain messages: {role, content}
    if hasattr(obj, "content") and hasattr(obj, "type") and isinstance(getattr(obj, "type", None), str):
        out = {"role": obj.type, "content": to_jsonable(obj.content, nxt)}
        tool_calls = getattr(obj, "tool_calls", None)
        if tool_calls:
            out["toolCalls"] = to_jsonable(tool_calls, nxt)
        return out
    try:
        if hasattr(obj, "model_dump"):
            return to_jsonable(obj.model_dump(), nxt)
        if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
            return to_jsonable(dataclasses.asdict(obj), nxt)
        if hasattr(obj, "dict") and callable(obj.dict):
            return to_jsonable(obj.dict(), nxt)
    except Exception:  # noqa: BLE001 - serialisation must never break the user's agent
        pass
    return repr(obj)[:500]
