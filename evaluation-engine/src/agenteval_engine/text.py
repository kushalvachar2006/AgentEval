"""Text and number utilities shared by the evaluators. Standard library only."""
from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from math import isclose
from typing import Any

STOPWORDS = frozenset(
    "a an the is are was were be been being of to in on at for by with and or but if then than that this these those it its as from into "
    "about over under again further do does did doing have has had having i you he she we they them his her their our your my me not no nor "
    "so too very can will just should would could may might must shall also there here what which who whom whose when where why how all any "
    "both each few more most other some such only own same s t up out off".split()
)
_WORD = re.compile(r"[^\W_]+", re.UNICODE)
_SENT = re.compile(r"(?<=[.!?])\s+(?=[\"'“(\[]?[A-Z0-9₹$€£])|\n+")
_NUM = re.compile(r"(?<![\w.])([-+]?\d+(?:,\d+)*(?:\.\d+)?)(?:\s*(%|k|lakhs?|lacs?|crores?|cr|million|mn|billion|bn|thousand)(?![a-z]))?", re.I)
_MULT = {"k": 1e3, "thousand": 1e3, "lakh": 1e5, "lakhs": 1e5, "lac": 1e5, "lacs": 1e5, "crore": 1e7, "crores": 1e7, "cr": 1e7,
         "million": 1e6, "mn": 1e6, "billion": 1e9, "bn": 1e9}
_CUR = "₹$€£¥"
_MONEY_SUBSTR = ("price", "cost", "inr", "usd", "eur", "gbp", "rupee", "dollar", "euro", "fee", "salary", "revenue", "mrp", "amount")
_UNIT_AFTER = re.compile(r"[ \t]+([^\W\d_]+)")
_LABEL_BEFORE = re.compile(r"([^\W\d_]+)[ \t]*[:=]?[ \t]*$")
_NEG = re.compile(r"\b(?:not|no|never|none|cannot|without|neither)\b|n't\b", re.I)


def normalize(text: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(text)).lower()).strip()


def words(text: Any) -> list[str]:
    return _WORD.findall(normalize(text))


def stem(w: str) -> str:
    for suf in ("ing", "ed", "es", "s"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def content_tokens(text: Any) -> list[str]:
    return [stem(w) for w in words(text) if w not in STOPWORDS and not w.isdigit() and len(w) > 1]


def containment(a: list[str], b: list[str]) -> float:
    """Share of the distinct tokens in `a` that also occur in `b`."""
    sa = set(a)
    return len(sa & set(b)) / len(sa) if sa else 0.0


def f1(pred: list[str], ref: list[str]) -> float:
    if not pred or not ref:
        return 0.0
    common = sum((Counter(pred) & Counter(ref)).values())
    if common == 0:
        return 0.0
    p, r = common / len(pred), common / len(ref)
    return 2 * p * r / (p + r)


def sentences(text: Any) -> list[str]:
    parts = (p.strip(" \t-*•#>") for p in _SENT.split(str(text)))
    return [p for p in parts if p]


def has_negation(text: Any) -> bool:
    return bool(_NEG.search(str(text)))


@dataclass(frozen=True)
class NumInfo:
    value: float
    kind: str   # money | percent | year | quantity
    unit: str = ""     # the word right AFTER the number ("3 days" -> "day")
    label: str = ""    # the word right BEFORE it ("days: 3" -> "day"); lets key/value tool output be compared with prose


def _unit(w: str) -> str:
    return w[:-1] if w.endswith("s") and len(w) > 3 else w


def number_infos(text: Any) -> list[NumInfo]:
    s = str(text)
    out: list[NumInfo] = []
    for m in _NUM.finditer(s):
        raw, suf = m.group(1), (m.group(2) or "").lower()
        try:
            value = float(raw.replace(",", ""))
        except ValueError:
            continue
        value *= _MULT.get(suf, 1.0)
        start, end = m.start(), m.end()
        prev_chars = s[max(0, start - 3):start]
        prev_words = _WORD.findall(s[max(0, start - 40):start].lower())[-3:]
        next_words = _WORD.findall(s[end:end + 40].lower())[:2]
        if suf == "%":
            kind = "percent"
        elif any(c in prev_chars for c in _CUR) or any(sub in w for w in prev_words + next_words for sub in _MONEY_SUBSTR):
            kind = "money"
        elif 1900 <= value <= 2100 and value == int(value) and "," not in raw:
            kind = "year"
        else:
            kind = "quantity"
        # A unit must FOLLOW the number directly ("3 days"); a word after a comma belongs to the next field ("560001, days: 3").
        m_unit = _UNIT_AFTER.match(s[end:end + 40])
        unit = _unit(m_unit.group(1).lower()) if kind == "quantity" and m_unit and m_unit.group(1).lower() not in STOPWORDS else ""
        m_label = _LABEL_BEFORE.search(s[max(0, start - 40):start])
        label = _unit(m_label.group(1).lower()) if m_label and m_label.group(1).lower() not in STOPWORDS and len(m_label.group(1)) > 1 else ""
        out.append(NumInfo(value, kind, unit, label))
    return out


def numbers(text: Any) -> list[float]:
    return [n.value for n in number_infos(text)]


def close(a: float, b: float, rel: float = 1e-6) -> bool:
    return isclose(a, b, rel_tol=rel, abs_tol=1e-9)


def comparable(a: NumInfo, b: NumInfo) -> bool:
    if a.kind != b.kind:
        return False
    if a.kind != "quantity":
        return True
    return a.unit == b.unit or (bool(a.unit) and a.unit == b.label) or (bool(b.unit) and b.unit == a.label)


def unit_anchored(a: NumInfo, b: NumInfo) -> bool:
    """Both are counts of the SAME named thing (e.g. 'days'), so they can be compared even if the surrounding words differ."""
    return a.kind == b.kind == "quantity" and bool(a.unit) and (a.unit == b.unit or a.unit == b.label or b.unit == a.label and bool(b.unit))


def flatten_sentences(value: Any, depth: int = 0) -> list[str]:
    """Turn strings / dicts / lists (tool outputs, retrieved docs) into checkable sentences.
    A dict of scalars becomes ONE sentence so a price stays next to the product it belongs to."""
    if depth > 8 or value is None:
        return []
    if isinstance(value, str):
        return sentences(value)
    if isinstance(value, (int, float, bool)):
        return [str(value)]
    if isinstance(value, dict):
        if all(not isinstance(v, (dict, list)) for v in value.values()):
            return [", ".join(f"{k}: {v}" for k, v in value.items())]
        out: list[str] = []
        for v in value.values():
            out.extend(flatten_sentences(v, depth + 1))
        return out
    if isinstance(value, (list, tuple)):
        return [s for v in value for s in flatten_sentences(v, depth + 1)]
    return [str(value)]


def as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)
