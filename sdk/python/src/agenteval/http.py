"""Tiny standard-library HTTP client. Redirects are refused so the API key is never forwarded to another host."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional



class AgentEvalHTTPError(Exception):
    def __init__(self, status: int, code: str, message: str, retry_after: Optional[float] = None) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message, self.retry_after = status, code, message, retry_after


class AgentEvalNetworkError(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        return None


class HttpClient:
    def __init__(self, base_url: str, api_key: str, timeout: float, user_agent: str) -> None:
        self._base, self._key, self._timeout, self._ua = base_url.rstrip("/"), api_key, timeout, user_agent
        self._opener = urllib.request.build_opener(_NoRedirect)

    def request(self, method: str, path: str, *, body: Any = None, raw_body: Optional[bytes] = None, query: Optional[dict] = None) -> Any:
        url = self._base + path + (("?" + urllib.parse.urlencode(query)) if query else "")
        data = raw_body if raw_body is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self._key}", "User-Agent": self._ua, "Accept": "application/json",
            **({"Content-Type": "application/json"} if data is not None else {}),
        })
        try:
            with self._opener.open(req, timeout=self._timeout) as resp:
                text = resp.read().decode("utf-8", "replace")
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode("utf-8", "replace")).get("error", {})
            except Exception:  # noqa: BLE001
                err = {}
            ra = e.headers.get("Retry-After") if e.headers else None
            raise AgentEvalHTTPError(e.code, err.get("code", "HTTP_ERROR"), err.get("message", e.reason), float(ra) if ra and ra.isdigit() else None) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            raise AgentEvalNetworkError(str(getattr(e, "reason", e))) from None
