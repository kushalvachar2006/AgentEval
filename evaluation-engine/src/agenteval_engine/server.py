"""Internal HTTP service used by the AgentEval worker. Standard library only (no web framework to install).

    POST /v1/evaluate   header X-Engine-Token   body: {trace, testCase, evaluators[], judge?, limits?}
    POST /v1/debug      header X-Engine-Token   body: {trace, results?[]}  -> findings explaining why the run went wrong
    GET  /v1/evaluators                         metric catalogue
    GET  /healthz

Meant to be reachable ONLY from the worker (private network). The shared token is mandatory.
Judge credentials arrive per request, are used for that request only, and are never logged or stored."""
from __future__ import annotations

import hmac
import json
import logging
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .debug import analyze_trace
from .engine import catalog, evaluate

MAX_BODY = 5 * 1024 * 1024
log = logging.getLogger("agenteval.engine")


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):  # a client hanging up mid-request is routine, not a stack trace
        log.debug("connection error from %s", client_address[0])


def make_handler(token: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "agenteval-engine"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # never log request lines with bodies/headers
            log.info("%s %s", self.command, self.path.split("?")[0])

        def _send(self, status, obj):
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authed(self):
            given = self.headers.get("X-Engine-Token", "")
            return hmac.compare_digest(given.encode(), token.encode())

        def do_GET(self):
            if self.path == "/healthz":
                return self._send(200, {"status": "ok"})
            if self.path == "/v1/evaluators":
                return self._send(200, {"evaluators": catalog()}) if self._authed() else self._send(401, {"error": "unauthorized"})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path not in ("/v1/evaluate", "/v1/debug"):
                return self._send(404, {"error": "not found"})
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                return self._send(411, {"error": "Content-Length required"})
            if length > MAX_BODY:
                self.close_connection = True
                return self._send(413, {"error": "payload too large"})
            try:
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise ValueError("body must be a JSON object")
                out = analyze_trace(payload.get("trace"), payload.get("results")) if self.path == "/v1/debug" else evaluate(payload)
            except (ValueError, json.JSONDecodeError) as e:
                return self._send(400, {"error": str(e)[:300]})
            except Exception:  # noqa: BLE001
                log.exception("evaluation failed")
                return self._send(500, {"error": "internal error"})
            self._send(200, out)

    return Handler


def serve(host: str = "0.0.0.0", port: int = 8000, token: str | None = None) -> Server:
    token = token if token is not None else os.environ.get("ENGINE_TOKEN", "")
    if not token or len(token) < 16:
        raise SystemExit("ENGINE_TOKEN (at least 16 characters) is required. Run `npm run init:env`.")
    return Server((host, port), make_handler(token))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    srv = serve(os.environ.get("ENGINE_HOST", "0.0.0.0"), int(os.environ.get("ENGINE_PORT", "8000")))
    print(json.dumps({"level": "info", "msg": "engine listening", "port": srv.server_address[1]}), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
