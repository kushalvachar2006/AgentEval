"""A tiny HTTP agent for testing "AgentEval calls my endpoint" evaluations (standard library only).

    pip install -e sdk/python
    python sdk/python/examples/demo_agent_server.py        # listens on http://127.0.0.1:9100/run   (Ctrl+C to stop)

In .env set  ALLOW_PRIVATE_ENDPOINTS=true  (a private address is otherwise blocked on purpose), restart the API/worker,
then create an agent of type "HTTP endpoint" with URL  http://127.0.0.1:9100/run  (Docker users: http://host.docker.internal:9100/run).

Contract your own agent must follow:  POST {input, sessionId, traceId, metadata}  ->  {"output": "...", "trace": {optional normalized trace}}
This demo returns a full trace and answers the laptop question with a deliberately wrong price (the other sample questions correctly).
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from agenteval.builder import TraceBuilder  # noqa: E402


def answer(question) -> dict:
    q = str(question).lower()
    b = TraceBuilder("filled-in-by-agenteval", "custom", input=question, agent_version="demo-endpoint-1")
    b.begin_span("root", None, "agent", "demo_endpoint_agent", input=question)
    if "laptop" in q:
        b.begin_span("tool", "root", "tool", "search_products", tool={"name": "search_products", "input": {"query": "laptop", "maxPrice": 50000}})
        b.end_span("tool", tool={"output": {"results": [{"name": "Acme Book 14", "priceInr": 47999}]}})
        text = "The cheapest laptop under ₹50,000 is the Acme Book 14 at ₹52,999."      # <- the planted bug
    elif "refund" in q:
        text = "Refunds are available within 30 days of purchase."
    else:
        text = "Hello!"
    b.end_span("root", output=text)
    return {"output": text, "trace": b.finish(output=text)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("agent called:", self.path)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0")) or 0) or b"{}")
        data = json.dumps(answer(body.get("input"))).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print("demo agent on http://127.0.0.1:9100/run  (Ctrl+C to stop)")
    HTTPServer(("127.0.0.1", 9100), Handler).serve_forever()
