"""Background exporter: queue -> batches -> HTTPS, with retries, backoff, size caps and drop accounting.
It never raises into the instrumented application."""
from __future__ import annotations

import json
import logging
import queue
import random
import threading
import time
from typing import Any, Callable, Optional

from .http import AgentEvalHTTPError, AgentEvalNetworkError
from .trace import validate_trace

log = logging.getLogger("agenteval")
MAX_BATCH_BYTES = 4 * 1024 * 1024
MAX_TRACE_BYTES = 3 * 1024 * 1024
_RETRYABLE = {429, 500, 502, 503, 504}


class Transport:
    def __init__(self, send: Callable[[bytes], Any], *, batch_size: int = 50, flush_interval: float = 5.0, max_retries: int = 3,
                 max_queue: int = 10_000, validate: bool = True, sleep: Callable[[float], None] = time.sleep) -> None:
        self._send_raw, self.batch_size, self.flush_interval = send, batch_size, flush_interval
        self.max_retries, self.validate, self._sleep = max_retries, validate, sleep
        self._q: queue.Queue[bytes] = queue.Queue(maxsize=max_queue)
        self._carry: list[bytes] = []
        self._pending = 0
        self._cond = threading.Condition()
        self._flush_req, self._stop = threading.Event(), threading.Event()
        self.stats = {"queued": 0, "accepted": 0, "duplicates": 0, "rejected": 0, "failed": 0, "dropped_queue_full": 0, "dropped_invalid": 0, "dropped_too_large": 0}
        self._thread = threading.Thread(target=self._run, name="agenteval-exporter", daemon=True)
        self._thread.start()

    # ---- producer side ----
    def enqueue(self, trace: dict) -> bool:
        try:
            if self.validate and (errs := validate_trace(trace)):
                self.stats["dropped_invalid"] += 1
                log.warning("agenteval: dropped an invalid trace (%s at %s)", errs[0]["message"], errs[0]["path"])
                return False
            raw = json.dumps(trace, separators=(",", ":"), default=str).encode()
            if len(raw) > MAX_TRACE_BYTES:
                self.stats["dropped_too_large"] += 1
                log.warning("agenteval: dropped a trace larger than %d bytes", MAX_TRACE_BYTES)
                return False
            with self._cond:
                self._pending += 1
            try:
                self._q.put_nowait(raw)
            except queue.Full:
                with self._cond:
                    self._pending -= 1
                self.stats["dropped_queue_full"] += 1
                return False
            self.stats["queued"] += 1
            return True
        except Exception:  # noqa: BLE001
            log.exception("agenteval: enqueue failed")
            return False

    def flush(self, timeout: float = 10.0) -> bool:
        self._flush_req.set()
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._pending > 0:
                left = deadline - time.monotonic()
                if left <= 0:
                    return False
                self._cond.wait(min(left, 0.1))
        return True

    def close(self, timeout: float = 10.0) -> None:
        self.flush(timeout)
        self._stop.set()
        self._thread.join(timeout=1.0)

    # ---- worker side ----
    def _collect(self) -> list[bytes]:
        batch, size = self._carry, sum(len(b) for b in self._carry)
        self._carry = []
        if not batch:
            try:
                first = self._q.get(timeout=0.2)
            except queue.Empty:
                return []
            batch, size = [first], len(first)
        deadline = time.monotonic() + self.flush_interval
        while len(batch) < self.batch_size:
            urgent = self._flush_req.is_set() or self._stop.is_set()
            try:
                item = self._q.get_nowait() if urgent else self._q.get(timeout=max(0.0, min(deadline - time.monotonic(), 0.1)))
            except queue.Empty:
                if urgent or time.monotonic() >= deadline:
                    break
                continue
            if size + len(item) > MAX_BATCH_BYTES:
                self._carry.append(item)
                break
            batch.append(item)
            size += len(item)
        return batch

    def _run(self) -> None:
        while not (self._stop.is_set() and self._q.empty() and not self._carry):
            try:
                batch = self._collect()
                if batch:
                    self._deliver(batch)
                    with self._cond:
                        self._pending -= len(batch)
                        if self._pending <= 0:
                            self._flush_req.clear()
                        self._cond.notify_all()
            except Exception:  # noqa: BLE001
                log.exception("agenteval: exporter error")

    def _deliver(self, batch: list[bytes]) -> None:
        body = b'{"traces":[' + b",".join(batch) + b"]}"
        for attempt in range(self.max_retries + 1):
            try:
                resp = self._send_raw(body)
                for r in (resp or {}).get("results", []):
                    if r.get("status") == "rejected":
                        err = r.get("error") or {}
                        log.warning("agenteval: server rejected a trace (%s: %s)", err.get("code"), err.get("message"))
                self.stats["accepted"] += (resp or {}).get("accepted", 0)
                self.stats["duplicates"] += (resp or {}).get("duplicates", 0)
                self.stats["rejected"] += (resp or {}).get("rejected", 0)
                return
            except AgentEvalHTTPError as e:
                if e.status == 413 and len(batch) > 1:  # too big as a batch: send halves
                    mid = len(batch) // 2
                    self._deliver(batch[:mid])
                    self._deliver(batch[mid:])
                    return
                if e.status not in _RETRYABLE or attempt == self.max_retries:
                    self.stats["failed"] += len(batch)
                    log.warning("agenteval: giving up on %d trace(s): %s", len(batch), e)
                    return
                delay = e.retry_after if e.retry_after is not None else None
            except AgentEvalNetworkError as e:
                if attempt == self.max_retries:
                    self.stats["failed"] += len(batch)
                    log.warning("agenteval: giving up on %d trace(s): network error (%s)", len(batch), e)
                    return
                delay = None
            self._sleep(min(30.0, delay if delay is not None else 0.5 * 2 ** attempt) + random.uniform(0, 0.25))
