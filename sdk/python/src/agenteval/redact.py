"""Client-side redaction: secrets never leave the process if we can help it (the server redacts again)."""
from __future__ import annotations

import re
from typing import Any

_SENSITIVE = {
    "password", "passwd", "secret", "token", "apikey", "authorization", "cookie", "setcookie", "privatekey",
    "credential", "credentials", "accesstoken", "refreshtoken", "idtoken", "authtoken", "bearertoken",
    "sessiontoken", "clientsecret", "secretkey", "xapikey", "openaiapikey", "anthropicapikey",
}
_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}", re.I),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bghp_[A-Za-z0-9]{30,}"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{30,}"),
    re.compile(r"\bae_live_[A-Za-z0-9_-]{20,}"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
]
_SUFFIX = re.compile(r"(password|secret|apikey|privatekey)$")


def is_sensitive_key(key: Any) -> bool:
    n = re.sub(r"[^a-z0-9]", "", str(key).lower())
    return n in _SENSITIVE or bool(_SUFFIX.search(n))


def sanitize(value: Any, max_string_len: int = 32768, max_depth: int = 32) -> tuple[Any, int]:
    """Return (clean_copy, redaction_count). Also truncates oversized strings and caps depth."""
    count = 0

    def clean_str(s: str) -> str:
        nonlocal count
        for p in _PATTERNS:
            s, n = p.subn("[REDACTED]", s)
            count += n
        if len(s) > max_string_len:
            s = f"{s[:max_string_len]}…[truncated {len(s) - max_string_len} chars]"
        return s

    def walk(v: Any, depth: int) -> Any:
        nonlocal count
        if isinstance(v, str):
            return clean_str(v)
        if isinstance(v, dict):
            if depth >= max_depth:
                return "[DEPTH_LIMIT]"
            out = {}
            for k, val in v.items():
                if is_sensitive_key(k):
                    count += 1
                    out[str(k)] = "[REDACTED]"
                else:
                    out[str(k)] = walk(val, depth + 1)
            return out
        if isinstance(v, list):
            if depth >= max_depth:
                return "[DEPTH_LIMIT]"
            return [walk(x, depth + 1) for x in v]
        return v

    return walk(value, 0), count
