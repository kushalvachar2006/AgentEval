"""Fill your dashboard with realistic SAMPLE traces (every trace is marked demo=true; the website labels them "demo").

    pip install -e sdk/python
    export AGENTEVAL_API_KEY=ae_live_...        # an API key from the agent page (Windows PowerShell: $env:AGENTEVAL_API_KEY="...")
    export AGENTEVAL_AGENT_ID=<agent id>
    python sdk/python/examples/generate_demo_data.py              # 14 days x 8 traces = 112 traces
    python sdk/python/examples/generate_demo_data.py --days 30 --per-day 20

What you get: two versions of the same agent - 1.0.0 (slow, flaky, sometimes wrong) and 1.1.0 (faster and more reliable) -
with timestamps spread over the past days, plus deliberate problems for the Debug view to find:
  * laptop answers that quote ₹52,999 while the tool returned ₹47,999
  * delivery answers that say 5 days while the tool returned 3
  * tool failures ("Upstream timeout")
The data is random but repeatable (fixed seed), so everyone sees the same numbers.
"""
import argparse
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from agenteval import AgentEval, validate_trace  # noqa: E402
from agenteval.builder import _hex_id, _iso  # noqa: E402

Q_LAPTOP, Q_REFUND, Q_SHIP = "Find the cheapest laptop below ₹50,000.", "What is the refund window?", "How long does delivery take?"


def make_trace(agent_id: str, version: str, start: datetime, rng: random.Random) -> dict:
    new = version == "1.1.0"
    err_rate, wrong_rate = (0.05, 0.04) if new else (0.16, 0.22)
    lat_lo, lat_hi = (1500, 3000) if new else (3000, 6000)
    question = rng.choice([Q_LAPTOP, Q_LAPTOP, Q_REFUND, Q_SHIP])
    total_ms = rng.randint(lat_lo, lat_hi)
    tokens_in, tokens_out = rng.randint(250, 500) * (2 if not new else 1), rng.randint(40, 120)
    failed = rng.random() < err_rate
    wrong = rng.random() < wrong_rate

    t = lambda ms: _iso(start + timedelta(milliseconds=ms))  # noqa: E731
    root, chain = _hex_id(8), _hex_id(8)
    spans = [
        {"spanId": root, "parentSpanId": None, "type": "agent", "name": "support_agent", "status": "success", "startedAt": t(0), "endedAt": t(total_ms), "durationMs": total_ms, "input": question},
        {"spanId": chain, "parentSpanId": root, "type": "chain", "name": "react_loop", "status": "success", "startedAt": t(20), "endedAt": t(total_ms - 20), "durationMs": total_ms - 40},
    ]
    plan_ms = int(total_ms * 0.25)
    spans.append({"spanId": _hex_id(8), "parentSpanId": chain, "type": "llm", "name": "planner", "status": "success", "startedAt": t(40), "endedAt": t(40 + plan_ms), "durationMs": plan_ms, "input": question,
                  "llm": {"provider": "demo", "model": "demo-model", "usage": {"inputTokens": tokens_in // 2, "outputTokens": tokens_out // 2, "totalTokens": tokens_in // 2 + tokens_out // 2}}})
    tool_start, tool_ms = 40 + plan_ms, int(total_ms * 0.4)
    answer, tool_sid = None, _hex_id(8)
    if question == Q_REFUND:
        spans.append({"spanId": tool_sid, "parentSpanId": chain, "type": "retriever", "name": "policy_search", "status": "success", "startedAt": t(tool_start), "endedAt": t(tool_start + tool_ms), "durationMs": tool_ms,
                      "retriever": {"query": "refund window", "documents": [{"pageContent": "The refund window is 30 days from the date of purchase."}]}})
        answer = "Refunds are available within 30 days of purchase."
    else:
        name, args = ("search_products", {"query": "laptop", "maxPrice": 50000}) if question == Q_LAPTOP else ("get_shipping_info", {"zip": "560001"})
        out = {"results": [{"name": "Acme Book 14", "priceInr": 47999}]} if question == Q_LAPTOP else {"zip": "560001", "days": 3}
        span = {"spanId": tool_sid, "parentSpanId": chain, "type": "tool", "name": name, "status": "success", "startedAt": t(tool_start), "endedAt": t(tool_start + tool_ms), "durationMs": tool_ms, "tool": {"name": name, "input": args, "output": out}}
        if failed:
            span.update(status="error", error={"message": "Upstream timeout after 30s"})
            span["tool"] = {"name": name, "input": args}
        spans.append(span)
        if question == Q_LAPTOP:
            answer = f"The cheapest laptop under ₹50,000 is the Acme Book 14 at ₹{'52,999' if wrong else '47,999'}."
        else:
            answer = f"Delivery takes {5 if wrong else 3} days."
    resp_start = tool_start + tool_ms
    spans.append({"spanId": _hex_id(8), "parentSpanId": chain, "type": "llm", "name": "responder", "status": "success", "startedAt": t(resp_start), "endedAt": t(total_ms - 40), "durationMs": total_ms - 40 - resp_start,
                  "llm": {"provider": "demo", "model": "demo-model", "usage": {"inputTokens": tokens_in // 2, "outputTokens": tokens_out - tokens_out // 2, "totalTokens": tokens_in // 2 + tokens_out - tokens_out // 2}}})
    total_tokens = tokens_in + tokens_out
    trace = {
        "schemaVersion": "1.0", "traceId": _hex_id(16), "agentId": agent_id, "agentVersion": version, "environment": "production" if rng.random() < 0.85 else "test",
        "framework": {"name": "custom"}, "status": "error" if failed else "success", "input": question, "output": None if failed else answer,
        "startedAt": t(0), "endedAt": t(total_ms), "durationMs": total_ms, "spans": spans, "metadata": {"demo": True},
        "usage": {"inputTokens": tokens_in, "outputTokens": tokens_out, "totalTokens": total_tokens, "estimatedCostUsd": round(total_tokens * 2e-6, 6)},
    }
    if failed:
        trace["error"] = {"type": "ToolError", "message": "Upstream timeout after 30s"}
        spans[0]["status"] = "error"; spans[0]["error"] = trace["error"]; spans[1]["status"] = "error"; spans[1]["error"] = trace["error"]
    return trace


def generate(agent_id: str, days: int = 14, per_day: int = 8, seed: int = 42, now: datetime | None = None) -> list[dict]:
    rng, now, out = random.Random(seed), now or datetime.now(timezone.utc), []
    for d in range(days, 0, -1):
        version = "1.1.0" if d <= days // 2 else "1.0.0"       # recent half runs the improved version
        for i in range(per_day):
            start = (now - timedelta(days=d)).replace(hour=8 + (i * 9) // max(per_day, 1), minute=rng.randint(0, 59), second=rng.randint(0, 59), microsecond=0)
            out.append(make_trace(agent_id, version, start, rng))
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--per-day", type=int, default=8)
    args = ap.parse_args()
    key, agent_id = os.getenv("AGENTEVAL_API_KEY"), os.getenv("AGENTEVAL_AGENT_ID")
    if not key or not agent_id:
        sys.exit("Set AGENTEVAL_API_KEY and AGENTEVAL_AGENT_ID first (see the top of this file).")
    if not (1 <= args.days <= 90 and 1 <= args.per_day <= 100):
        sys.exit("--days must be 1-90 and --per-day 1-100.")
    traces = generate(agent_id, args.days, args.per_day)
    bad = [e for t in traces for e in validate_trace(t)]
    if bad:
        sys.exit(f"internal error: generated an invalid trace: {bad[0]}")
    with AgentEval(api_key=key, endpoint=os.getenv("AGENTEVAL_ENDPOINT", "http://localhost:4000"), sampling_rate=1.0) as client:
        for t in traces:
            client.capture(t)
        client.flush(60)
        print(f"Sent {len(traces)} demo traces over {args.days} days. Export stats: {client.stats}")
    print("Open the Dashboard (tick nothing - demo data is labelled), then try the Trace explorer.")
