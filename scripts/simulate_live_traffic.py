#!/usr/bin/env python3
"""Generate a LIVE stream of production traces, then a degradation, so you can watch Live Monitoring and alerts react.

Standard library only. Phases (all configurable):
  1. healthy   - low error rate, ~0.6 s latency, answers agree with tool output
  2. degraded  - ~40% errors, ~4x latency, some answers contradict tool output
  3. recovery  - healthy again (alerts auto-resolve after their OK checks)

Usage:
  python scripts/simulate_live_traffic.py --api http://localhost:4000/api/v1 --api-key ae_... --agent-id <24-hex agent id>
Options: --rate 3 (traces/second)  --healthy-seconds 120  --degraded-seconds 240  --recovery-seconds 180  --version 1.0.0  --seed 7
Traces are sent as environment=production and are NOT marked demo, so they count for monitoring and alerts.
"""
import argparse
import json
import random
import secrets
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

PRODUCTS = [("Acme Book 14", 47999), ("Zen Slim 13", 45999), ("Orbit Pro 15", 49999)]


def iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def make_trace(agent_id, version, rng, degraded):
    now = datetime.now(timezone.utc)
    base_ms = 600 if not degraded else 2400
    duration = int(max(80, rng.gauss(base_ms, base_ms * 0.25)))
    started = now - timedelta(milliseconds=duration)
    failed = rng.random() < (0.40 if degraded else 0.01)
    name, price = rng.choice(PRODUCTS)
    question = f"Find me the cheapest laptop under ₹{rng.choice([50000, 55000, 60000])}."
    wrong = degraded and not failed and rng.random() < 0.35
    answer = f"The {name} costs ₹{price + (7000 if wrong else 0):,}."
    root, tool = secrets.token_hex(8), secrets.token_hex(8)
    spans = [
        {"spanId": root, "parentSpanId": None, "type": "agent", "name": "shopping_agent", "status": "error" if failed else "success", "startedAt": iso(started), "endedAt": iso(now), "durationMs": duration,
         **({"error": {"type": "ToolTimeout", "message": "upstream product search timed out"}} if failed else {})},
        {"spanId": tool, "parentSpanId": root, "type": "tool", "name": "search_products", "status": "success", "startedAt": iso(started), "endedAt": iso(started + timedelta(milliseconds=duration // 2)), "durationMs": duration // 2,
         "tool": {"name": "search_products", "input": {"maxPrice": 60000}, "output": {"results": [{"name": name, "priceInr": price}]}}},
    ]
    t = {
        "schemaVersion": "1.0", "traceId": secrets.token_hex(16), "agentId": agent_id, "agentVersion": version, "environment": "production",
        "framework": {"name": "custom"}, "status": "error" if failed else "success", "input": question, "startedAt": iso(started), "endedAt": iso(now), "durationMs": duration,
        "usage": {"inputTokens": 700, "outputTokens": 120, "totalTokens": 820, "estimatedCostUsd": round(0.0020 * (3 if degraded else 1), 5)},
        "spans": spans, "metadata": {"source": "simulate_live_traffic"},
    }
    if failed:
        t["error"] = {"type": "ToolTimeout", "message": "upstream product search timed out"}
    else:
        t["output"] = answer
    return t


def post(url, key, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json", "x-api-key": key}, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api", default="http://localhost:4000/api/v1")
    ap.add_argument("--api-key", required=True)
    ap.add_argument("--agent-id", required=True)
    ap.add_argument("--version", default="1.0.0")
    ap.add_argument("--rate", type=float, default=3.0, help="traces per second")
    ap.add_argument("--healthy-seconds", type=int, default=120)
    ap.add_argument("--degraded-seconds", type=int, default=240)
    ap.add_argument("--recovery-seconds", type=int, default=180)
    ap.add_argument("--seed", type=int, default=None)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    phases = [("healthy", a.healthy_seconds, False), ("DEGRADED", a.degraded_seconds, True), ("recovery", a.recovery_seconds, False)]
    sent = failed_posts = 0
    carry = 0.0
    for name, seconds, degraded in phases:
        print(f"--- phase: {name} for {seconds}s ---", flush=True)
        for second in range(seconds):
            tick = time.time()
            carry += a.rate
            n, carry = int(carry), carry - int(carry)
            if n:
                try:
                    out = post(f"{a.api}/traces/batch", a.api_key, {"traces": [make_trace(a.agent_id, a.version, rng, degraded) for _ in range(n)]})
                    sent += out["accepted"]
                    if out["rejected"]:
                        print("rejected:", json.dumps([r for r in out["results"] if r["status"] == "rejected"][:1])[:300], flush=True)
                except (urllib.error.URLError, OSError) as e:
                    failed_posts += 1
                    print(f"send failed: {e}", file=sys.stderr, flush=True)
            if second % 15 == 14:
                print(f"  {name}: {sent} traces accepted so far", flush=True)
            time.sleep(max(0.0, 1.0 - (time.time() - tick)))
    print(f"done: {sent} traces accepted, {failed_posts} failed requests")


if __name__ == "__main__":
    main()
