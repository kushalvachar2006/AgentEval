"""LangGraph integration.

LangGraph runs every node as a LangChain runnable and honours `callbacks` in the run config, so instrumentation is:

    graph.invoke(state, config=client.langgraph_config("<agent id>", thread_id="user-42"))

`merge_config` keeps any config the caller already has.
"""
from __future__ import annotations

from typing import Any, Optional


def merge_config(handler: Any, *, thread_id: Optional[str] = None, session_id: Optional[str] = None, config: Optional[dict] = None) -> dict:
    cfg = dict(config or {})
    existing = cfg.get("callbacks")
    cfg["callbacks"] = [*(existing if isinstance(existing, list) else []), handler]
    if thread_id:
        cfg["configurable"] = {**cfg.get("configurable", {}), "thread_id": thread_id}
    if session_id or thread_id:
        cfg["metadata"] = {**cfg.get("metadata", {}), "session_id": session_id or thread_id}
    return cfg
