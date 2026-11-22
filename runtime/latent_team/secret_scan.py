"""The ledger's secret scanner (src/secrets.mjs, cards P4b and P4c) for the latent gateway (W2).

Both read the rule data in rules/secret-rules.json, so a rule changes in one place, and
both test suites run the cases in rules/secret-conformance.json (the H4 pattern of
rules/latent-rules.json). This module is the same walk as src/secrets.mjs, step for step:
a short bounded pattern finds where a candidate starts, a forward scan finds where the
value really ends, and overlapping candidates merge into one span labelled with the most
specific kind. It only reports and replaces; it never stores, prints or sends a value.

JavaScript's u-flag patterns are rewritten before Python compiles them, as the H4 grader
(runtime/tests/grade.py) does: \\b and \\w use JavaScript's word characters exactly (ASCII,
plus U+017F LONG S and U+212A KELVIN SIGN under i), \\s and \\S use JavaScript's whitespace
list (rules/latent-rules.json), and a case-insensitive pattern folds case as Python's
Unicode IGNORECASE does, so LONG S matches s and KELVIN SIGN matches k, as JavaScript's i
does. One difference is left: inside a letter class such as [A-Za-z] under i, Python also
matches U+0130 and U+0131 (dotted capital and dotless i), JavaScript does not; no rule's
outcome in the shared cases depends on it. Offsets count code points where JavaScript
counts UTF-16 units.

Standard library only.
"""
import json
import re
from pathlib import Path

from latent_pool.rules import QUOTE_SPACE_CODE_POINTS

RULES_PATH = Path(__file__).resolve().parents[2] / "rules" / "secret-rules.json"
BACKSLASH = chr(92)
QUOTES = "\"'`"
LINE_BREAKS = "\n\r" + chr(0x2028) + chr(0x2029)


def _load(path=RULES_PATH):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        raise RuntimeError(f"Shared rule file not found: {path}. The latent runtime must run from runtime/ inside a "
                           "context-ledger checkout, which has rules/secret-rules.json.") from None


_SPACES = "".join(re.escape(chr(code)) for code in QUOTE_SPACE_CODE_POINTS)


def _escapes(ignore_case):
    """JavaScript's \\w and \\b word characters: ASCII letters, digits and _, and with the i
    flag also the two characters that fold into them, U+017F and U+212A (ECMAScript's
    Canonicalize with simple case folding). The class is read with case folding off, so
    Python's wider IGNORECASE (which also folds U+0130 and U+0131) cannot widen it."""
    word = "0-9A-Za-z_" + (chr(0x17F) + chr(0x212A) if ignore_case else "")
    w = f"(?-i:[{word}])"
    return ({"d": "[0-9]", "D": "[^0-9]", "w": w, "W": f"(?-i:[^{word}])",
             "s": "[" + _SPACES + "]", "S": "[^" + _SPACES + "]",
             "b": f"(?:(?<={w})(?!{w})|(?<!{w})(?={w}))", "B": f"(?:(?<={w})(?={w})|(?<!{w})(?!{w}))"},
            {"d": "0-9", "w": word, "s": _SPACES})


def _python_pattern(pattern, ignore_case=False):
    """A JavaScript u-flag pattern rewritten so Python's re reads it the same way."""
    _OUTSIDE, _INSIDE = _escapes(ignore_case)
    out, in_class, index = [], False, 0
    while index < len(pattern):
        character = pattern[index]
        if character == BACKSLASH and index + 1 < len(pattern):
            escaped = pattern[index + 1]
            if in_class and escaped in _INSIDE:
                out.append(_INSIDE[escaped])
            elif in_class and escaped in "DWS":
                raise ValueError(f"a negated class escape inside a class is not supported: {pattern!r}")
            elif not in_class and escaped in _OUTSIDE:
                out.append(_OUTSIDE[escaped])
            else:
                out.append(pattern[index:index + 2])
            index += 2
            continue
        if character == "[" and not in_class:
            in_class = True
        elif character == "]" and in_class:
            in_class = False
        elif character == "$" and not in_class:
            character = BACKSLASH + "Z"
        out.append(character)
        index += 1
    return "".join(out)


def _compile(pattern, flags=""):
    ignore_case = "i" in flags
    return re.compile(_python_pattern(pattern, ignore_case), re.IGNORECASE if ignore_case else 0)


class _Class:
    """One character class, tested on single characters."""

    def __init__(self, pattern):
        self.pattern = _compile(pattern if pattern is not None else "(?!)")

    def test(self, character):
        return character != "" and self.pattern.fullmatch(character) is not None


RULES = _load()
BASE64URL = _Class("[A-Za-z0-9_-]")


def _mixed(value):
    return re.search("[A-Za-z]", value) is not None and re.search("[0-9]", value) is not None


SIMPLE = []
for _rule in RULES["simple"]["rules"]:
    SIMPLE.append({"kind": _rule["kind"], "start": _compile(_rule["start"]), "cls": _Class(_rule["cls"]),
                   "prefix": _compile(_rule["prefix"]), "mixedAfter": _rule.get("mixedAfter")})
VALUES = [{"kind": r["kind"], "lead": _compile(r["lead"], "i"), "cls": _Class(r["cls"]), "accept": _compile(r["accept"])}
          for r in RULES["values"]["rules"]]
_free = RULES["freeText"]
FREE_TEXT = [
    {"kind": "bearer-token", "lead": _compile(_free["bearerLead"], "i")},
    {"kind": "assigned-secret",
     "lead": _compile("\\b(?:[A-Za-z0-9]{1,32}[_.-])?(?:" + "|".join(_free["nameKeywords"]) + ")\\b[\"']?[ \\t]*[:=][ \\t]*",
                      "i")},
]
_holders = RULES["placeholders"]
PLACEHOLDERS = [_compile(p["pattern"], p.get("flags", "")) for p in _holders["patterns"]]
ANGLE = _compile(_holders["angleStandIn"])
STAND_IN_WORDS = frozenset(_holders["standInWords"])
_OPENS_FIELD = _compile("^[^:=]*[\"'`]\\s{0,8}[:=]")
_QUOTE_BEFORE_BEARER = _compile("([\"'])[ \\t]*Bearer", "i")


_HEADER = _compile("^[A-Za-z-]{1,32}: \\S")
_BASE64_LINE = _compile("^[A-Za-z0-9+/=]+$")


def _at(text, index):
    return text[index] if 0 <= index < len(text) else ""


def run_end(text, start, cls):
    end = start
    while end < len(text) and cls.test(text[end]):
        end += 1
    return end


def escape_at(text, i):
    """The escape at i in a quoted string, decoded: (character, length) or None."""
    if _at(text, i) != BACKSLASH or i + 1 >= len(text):
        return None
    if text[i + 1] == "u" and re.fullmatch("[0-9A-Fa-f]{4}", text[i + 2:i + 6]):
        return chr(int(text[i + 2:i + 6], 16)), 6
    named = {"n": 10, "r": 13, "t": 9, "b": 8, "f": 12}.get(text[i + 1])
    return (text[i + 1] if named is None else chr(named)), 2


def decoded(value):
    out, i = [], 0
    while i < len(value):
        escape = escape_at(value, i)
        if escape:
            out.append(escape[0])
            i += escape[1]
        else:
            out.append(value[i])
            i += 1
    return "".join(out)


def escaped_run_end(text, start, cls):
    end = start
    while end < len(text):
        escape = escape_at(text, end)
        if escape:
            if not cls.test(escape[0]):
                break
            end += escape[1]
        elif cls.test(text[end]):
            end += 1
        else:
            break
    return end


def quoted_end(text, start, quote):
    at = start
    while at < len(text):
        character = text[at]
        if character in "\n\r" or character == quote:
            return at
        if character == BACKSLASH and at + 1 < len(text) and text[at + 1] not in "\n\r":
            at += 1
        at += 1
    return len(text)


def is_angle_stand_in(value):
    if ANGLE.fullmatch(value) is None:
        return False
    return any(word.lower() in STAND_IN_WORDS for word in re.split("[ _-]", value[1:-1]))


def is_placeholder(value):
    return any(p.fullmatch(value) is not None for p in PLACEHOLDERS) or is_angle_stand_in(value)


def line_end_from(text, start):
    for at in range(start, len(text)):
        if text[at] in LINE_BREAKS:
            return at
    return len(text)


def judged_value(text, start, end, quote):
    if quote:
        close = start
        while close < end and text[close] != quote:
            close += 2 if text[close] == BACKSLASH else 1
        if close >= end:
            return text[start:end]
        after = close + 1
        while after < end and text[after] in " \t":
            after += 1
        if after < end and text[after] not in ",;)]}":
            return text[start:end]
        return text[start:close]
    stop = end
    while stop > start and text[stop - 1] in " \t,;":
        stop -= 1
    return text[start:stop]


def line_tails(text):
    found = []
    for rule in FREE_TEXT:
        line_end, position = -1, 0
        while True:
            match = rule["lead"].search(text, position)
            if match is None:
                break
            position = match.end() if match.end() > match.start() else match.end() + 1
            start = match.end()
            if _at(text, start) and _at(text, start) in QUOTES:
                quote = text[start]
            elif rule["kind"] == "bearer-token":
                lead_quote = _QUOTE_BEFORE_BEARER.search(match.group(0))
                quote = lead_quote.group(1) if lead_quote else ""
            else:
                quote = ""
            if _at(text, start) and _at(text, start) in QUOTES:
                start += 1
            if start > line_end:
                line_end = line_end_from(text, start)
            end = line_end
            value = judged_value(text, start, end, quote)
            if not value or is_placeholder(value):
                continue
            found.append({"kind": rule["kind"], "start": start, "end": end, "prefix": 0})
            position = max(position, end)
    return found


def jwts(text):
    found, position = [], 0
    pattern = _compile("\\beyJ[A-Za-z0-9_-]{8}")
    while True:
        match = pattern.search(text, position)
        if match is None:
            break
        position = match.end()
        end = run_end(text, match.start(), BASE64URL)
        if _at(text, end) == "." and text.startswith("eyJ", end + 1):
            payload_end = run_end(text, end + 1, BASE64URL)
            if payload_end - (end + 1) >= 11 and _at(text, payload_end) == ".":
                end = run_end(text, payload_end + 1, BASE64URL)
                found.append({"kind": "jwt", "start": match.start(), "end": end, "prefix": 3})
        position = max(position, end)
    return found


def private_keys(text):
    found, position = [], 0
    begin = _compile("-----BEGIN ((?:[A-Z0-9]{1,16} ){0,3})PRIVATE KEY-----")
    while True:
        match = begin.search(text, position)
        if match is None:
            break
        position = match.end()
        end_line = f"-----END {match.group(1)}PRIVATE KEY-----"
        marker_end = match.end()
        padded = run_end(text, marker_end, _Class("[ \\t]"))
        end = padded if _at(text, padded) == "\n" or (_at(text, padded) == "\r" and _at(text, padded + 1) == "\n") \
            else marker_end
        blank_allowed = False
        while end < len(text):
            if _at(text, end) == "\r" and _at(text, end + 1) == "\n":
                line_start = end + 2
            elif _at(text, end) == "\n":
                line_start = end + 1
            else:
                break
            newline = text.find("\n", line_start)
            line_end = len(text) if newline == -1 else (newline - 1 if _at(text, newline - 1) == "\r" else newline)
            trimmed = line_end
            while trimmed > line_start and text[trimmed - 1] in " \t":
                trimmed -= 1
            line = text[line_start:trimmed]
            if line == end_line:
                end = trimmed
                break
            if _HEADER.match(line) is not None:
                blank_allowed = True
            elif line == "" and blank_allowed:
                blank_allowed = False
            elif _BASE64_LINE.match(line):
                blank_allowed = False
            else:
                break
            end = line_end
        found.append({"kind": "private-key", "start": match.start(), "end": end, "prefix": 0})
        position = max(position, end)
    return found


def candidates(text):
    found = [dict(c, rank=0) for c in private_keys(text)] + [dict(c, rank=1) for c in jwts(text)]
    for index, rule in enumerate(SIMPLE):
        position = 0
        while True:
            match = rule["start"].search(text, position)
            if match is None:
                break
            start = match.start()
            end = run_end(text, match.end(), rule["cls"])
            value = text[start:end]
            if rule["mixedAfter"] is None or _mixed(value[rule["mixedAfter"]:]):
                prefix = rule["prefix"].match(value)
                found.append({"kind": rule["kind"], "start": start, "end": end, "rank": 2 + index,
                              "prefix": min(len(prefix.group(0)) if prefix else 0, len(value))})
            position = max(match.end(), end)
    for index, rule in enumerate(VALUES):
        position, cached = 0, None
        while True:
            match = rule["lead"].search(text, position)
            if match is None:
                break
            position = match.end() if match.end() > match.start() else match.end() + 1
            start = match.end()
            quote = _at(text, start)
            if quote and quote in QUOTES:
                start += 1
                end = quoted_end(text, start, quote)
                in_string = True
            else:
                cls = rule["cls"]
                before = _at(text, match.start() - 1)
                in_string = bool(before) and before in QUOTES and _OPENS_FIELD.search(match.group(0)) is None
                if cached and cached[0] is cls and cached[3] == in_string and cached[1] <= start < cached[2]:
                    end = cached[2]
                else:
                    end = escaped_run_end(text, start, cls) if in_string else run_end(text, start, cls)
                    cached = (cls, start, end, in_string)
            value = text[start:end]
            if value and rule["accept"].fullmatch(decoded(value) if in_string else value):
                found.append({"kind": rule["kind"], "start": start, "end": end,
                              "rank": 2 + len(SIMPLE) + index, "prefix": 0})
                position = max(position, end)
    found += [dict(c, rank=2 + len(SIMPLE) + len(VALUES)) for c in line_tails(text)]
    return found


def find_secrets(text):
    """Every span in text that looks like a credential, in text order: [{kind, start, end, prefix}]."""
    if not isinstance(text, str) or not text:
        return []
    spans = []
    for candidate in sorted(candidates(text), key=lambda c: (c["start"], c["rank"])):
        if spans and candidate["start"] < spans[-1]["end"]:
            last = spans[-1]
            last["end"] = max(last["end"], candidate["end"])
            if candidate["rank"] < last["best"]["rank"]:
                last["best"] = candidate
        else:
            spans.append({"start": candidate["start"], "end": candidate["end"], "best": candidate})
    return [{"kind": s["best"]["kind"], "start": s["start"], "end": s["end"],
             "prefix": s["best"]["prefix"] if s["best"]["start"] == s["start"] and s["best"]["end"] == s["end"] else 0}
            for s in spans]


def redact_text(text, findings=None):
    findings = find_secrets(text) if findings is None else findings
    out, at = [], 0
    for finding in findings:
        out.append(text[at:finding["start"]] + f"[REDACTED {finding['kind']}]")
        at = finding["end"]
    return "".join(out) + text[at:]
