"""The ledger's secret scanner (src/secrets.mjs, cards P4b and P4c) for the latent gateway (W2).

Both read the rule data in rules/secret-rules.json, so a rule changes in one place, and
both test suites run the cases in rules/secret-conformance.json (the H4 pattern of
rules/latent-rules.json). This module is the same walk as src/secrets.mjs, step for step:
a short bounded pattern finds where a candidate starts, a forward scan finds where the
value really ends, and overlapping candidates merge into one span labelled with the most
specific kind. It only reports and replaces; it never stores, prints or sends a value.

JavaScript's u-flag patterns are rewritten before Python compiles them, in the spirit of
the H4 grader (runtime/tests/grade.py): \\b and \\w use JavaScript's word characters exactly
(ASCII, plus U+017F LONG S and U+212A KELVIN SIGN under i), \\s and \\S use JavaScript's
whitespace list (rules/latent-rules.json), and $ ends the text. Case-insensitive matching
is written into the pattern rather than left to Python's IGNORECASE: every ASCII letter
becomes its two cases, plus LONG S for s and KELVIN SIGN for k, which is exactly what
JavaScript's i with u folds into ASCII letters; so U+0130 and U+0131 (dotted capital and
dotless i) match no letter, as in JavaScript. Offsets count code points where JavaScript
counts UTF-16 units.

Standard library only.
"""
import bisect
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
    Canonicalize with simple case folding)."""
    word = "0-9A-Za-z_" + (chr(0x17F) + chr(0x212A) if ignore_case else "")
    w = f"[{word}]"
    return ({"d": "[0-9]", "D": "[^0-9]", "w": w, "W": f"[^{word}]",
             "s": "[" + _SPACES + "]", "S": "[^" + _SPACES + "]",
             "b": f"(?:(?<={w})(?!{w})|(?<!{w})(?={w}))", "B": f"(?:(?<={w})(?={w})|(?<!{w})(?!{w}))"},
            {"d": "0-9", "w": word, "s": _SPACES})


# Under JavaScript's iu flags a character matches a letter when both fold to the same
# character. For the ASCII letters that is the letter's other case, plus U+017F LONG S for s
# and U+212A KELVIN SIGN for k, and nothing else: so the folding is written into the pattern
# and Python compiles it without IGNORECASE (whose folding is wider: it also maps U+0130 and
# U+0131 to i).
_EXTRA = {"s": chr(0x17F), "k": chr(0x212A)}


def _variants(character):
    if not character.isascii() or not character.isalpha():
        return re.escape(character) if character in "\\]^-[" else character
    lower = character.lower()
    return lower + lower.upper() + _EXTRA.get(lower, "")


def _fold_class(body):
    """A class body with every ASCII letter, single or in a range, given its folded forms."""
    out, extra, index = [], set(), 0
    negated = body.startswith("^")
    if negated:
        index = 1
    while index < len(body):
        if body[index] == BACKSLASH and index + 1 < len(body):
            out.append(body[index:index + 2])
            index += 2
            continue
        low = body[index]
        if index + 2 < len(body) and body[index + 1] == "-" and body[index + 2] != BACKSLASH:
            high = body[index + 2]
            out.append(f"{low}-{high}")
            for code in range(ord(low), ord(high) + 1):
                letter = chr(code)
                if letter.isascii() and letter.isalpha():
                    extra.add(letter.swapcase())
                    extra.update(_EXTRA.get(letter.lower(), ""))
            index += 3
            continue
        out.append(low if not (low.isascii() and low.isalpha()) else "")
        if low.isascii() and low.isalpha():
            extra.update(_variants(low))
        index += 1
    # The folded letters go first, so none can join a "-" at the end of the class into a range.
    return ("^" if negated else "") + "".join(sorted(extra)) + "".join(out)


def _python_pattern(pattern, ignore_case=False):
    """A JavaScript u-flag pattern rewritten so Python's re reads it the same way."""
    _OUTSIDE, _INSIDE = _escapes(ignore_case)
    out, index = [], 0
    while index < len(pattern):
        character = pattern[index]
        if character == BACKSLASH and index + 1 < len(pattern):
            escaped = pattern[index + 1]
            if escaped in _OUTSIDE:
                out.append(_OUTSIDE[escaped])
            else:
                out.append(pattern[index:index + 2])
            index += 2
            continue
        if character == "[":
            close, body = index + 1, []
            while close < len(pattern) and pattern[close] != "]":
                if pattern[close] == BACKSLASH and close + 1 < len(pattern):
                    escaped = pattern[close + 1]
                    if escaped in _INSIDE:
                        body.append(_INSIDE[escaped])
                    elif escaped in "DWS":
                        raise ValueError(f"a negated class escape inside a class is not supported: {pattern!r}")
                    else:
                        body.append(pattern[close:close + 2])
                    close += 2
                    continue
                body.append(pattern[close])
                close += 1
            text = "".join(body)
            if not text or text == "^":
                raise ValueError(f"an empty or ']'-first class is not supported: {pattern!r}")
            out.append("[" + (_fold_class(text) if ignore_case else text) + "]")
            index = close + 1
            continue
        if character == "$":
            out.append(BACKSLASH + "Z")
        elif ignore_case and character.isascii() and character.isalpha():
            out.append("[" + _variants(character) + "]")
        else:
            out.append(character)
        index += 1
    return "".join(out)


def _compile(pattern, flags=""):
    return re.compile(_python_pattern(pattern, "i" in flags))


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
     "lead": _compile(_free["assignedLead"].replace("{keywords}", "|".join(_free["nameKeywords"])), "i")},
]
_holders = RULES["placeholders"]
PLACEHOLDERS = [_compile(p["pattern"], p.get("flags", "")) for p in _holders["patterns"]]
ANGLE = _compile(_holders["angleStandIn"])
STAND_IN_WORDS = frozenset(_holders["standInWords"])
_OPENS_FIELD = _compile("^[^:=]*[\"'`]\\s{0,8}[:=]")
_QUOTE_BEFORE_BEARER = _compile("([\"'])[ \\t]*Bearer", "i")


JWT = RULES["jwt"]
KEY = RULES["privateKey"]
_JWT_START = _compile(JWT["start"])
_KEY_BEGIN = _compile(KEY["begin"])
_HEADER = _compile(KEY["header"])
_BASE64_LINE = _compile(KEY["body"])


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


JUDGED_MAX = RULES["placeholders"]["maxJudged"]


def judged_end(text, start, end, quote, trimmed):
    """Where the value judged for a placeholder ends: inside a quote, at the closing quote
    when only spaces and tabs come before a delimiter or the line end, else at the line end;
    a bare value, at the line's end without trailing spaces, tabs, commas and semicolons
    (trimmed, found once a line)."""
    if quote:
        close = start
        while close < end and text[close] != quote:
            close += 2 if text[close] == BACKSLASH else 1
        if close >= end:
            return end
        after = close + 1
        while after < end and text[after] in " \t":
            after += 1
        if after < end and text[after] not in ",;)]}":
            return end
        return close
    return max(start, trimmed)


def quoted_close(text, start, end, quote):
    """Where the quote that opened at start closes on its line (past escaped quotes), or None."""
    close = start
    while close < end and text[close] != quote:
        close += 2 if text[close] == BACKSLASH else 1
    return close if close < end else None


def judged_value(text, start, end, quote, trimmed=None):
    return text[start:judged_end(text, start, end, quote, _trimmed_end(text, end) if trimmed is None else trimmed)]


def _trimmed_end(text, end):
    while end > 0 and text[end - 1] in " \t,;":
        end -= 1
    return end


def _placeholder_at(text, start, stop):
    """Is text[start:stop] only a stand-in, for a value collected from a finding? One longer
    than maxJudged is not judged here (it is kept as a value); a candidate's own judged value
    of that length is judged once its line's leads are known (line_tails)."""
    return stop - start <= JUDGED_MAX and is_placeholder(text[start:stop])


def line_tails(text, other_leads=()):
    """Card P4c: one span per free-text lead, from the value's start to the end of its line.
    Every lead is read, in source order across all free-text rules, so every assignment on a
    line has its own value (review W2-11 to W2-13). A candidate keeps offsets, never a copy:
    value_end, where its judged value ends, and core_end, where its own assignment ends (the
    next lead of any kind on the line, free-text or a structured value rule's, other_leads,
    for a value that is not a closed quote). The spans all end at the line end, so the merged
    spans do not change."""
    found, leads = [], list(other_leads)
    for rule in FREE_TEXT:
        line_end, trimmed, position = -1, -1, 0
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
                trimmed = _trimmed_end(text, line_end)
            end = line_end
            leads.append(match.start())
            value_end = judged_end(text, start, end, quote, trimmed)
            if value_end <= start:
                continue
            # A value up to maxJudged is judged now; a longer one once every lead is known,
            # below, so a line of many assignments is still read in linear time.
            long = value_end - start > JUDGED_MAX
            if not long and is_placeholder(text[start:value_end]):
                continue
            closed = bool(quote) and value_end < end
            candidate = {"kind": rule["kind"], "start": start, "end": end, "prefix": 0, "value_end": value_end,
                         "closed": closed, "long": long}
            if quote and not closed:
                # The judged value runs to the line end ("x". is not a stand-in), but what the
                # quotes hold is a value of its own (review W2-14).
                close = quoted_close(text, start, end, quote)
                if close is not None and close > start:
                    candidate["quoted_end"] = close
            found.append(candidate)
            # After a closed quote, the next lead is looked for after it; otherwise right after
            # this lead.
            position = max(position, value_end + 1 if closed else start)
    leads.sort()
    kept = []
    for candidate in found:
        stop = candidate["value_end"]
        at = bisect.bisect_right(leads, candidate["start"])
        later = leads[at] if at < len(leads) and leads[at] < stop else None
        # A long value is a stand-in as P4c judged it (review W2-17), judged once: a value that
        # holds another assignment never is one, so only the last on its line, or a quoted
        # one, is read by the stand-in rules.
        if candidate.pop("long") and later is None and is_placeholder(text[candidate["start"]:stop]):
            continue
        candidate["core_end"] = later if later is not None and not candidate["closed"] else stop
        kept.append(candidate)
    return kept


def jwts(text):
    found, position = [], 0
    pattern = _JWT_START
    while True:
        match = pattern.search(text, position)
        if match is None:
            break
        position = match.end()
        end = run_end(text, match.start(), BASE64URL)
        if _at(text, end) == "." and text.startswith(JWT["segment"], end + 1):
            payload_end = run_end(text, end + 1, BASE64URL)
            if payload_end - (end + 1) >= JWT["payloadMin"] and _at(text, payload_end) == ".":
                end = run_end(text, payload_end + 1, BASE64URL)
                found.append({"kind": "jwt", "start": match.start(), "end": end, "prefix": JWT["prefix"]})
        position = max(position, end)
    return found


def private_keys(text):
    found, position = [], 0
    begin = _KEY_BEGIN
    while True:
        match = begin.search(text, position)
        if match is None:
            break
        position = match.end()
        end_line = KEY["end"].replace("{label}", match.group(1))
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
    value_leads = []   # where each named assignment begins, to cut free-text values (review W2-18)
    for index, rule in enumerate(VALUES):
        position, cached = 0, None
        while True:
            match = rule["lead"].search(text, position)
            if match is None:
                break
            value_leads.append(match.start())
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
                              "rank": 2 + len(SIMPLE) + index, "prefix": 0, "value": value})
                position = max(position, end)
    found += [dict(c, rank=2 + len(SIMPLE) + len(VALUES)) for c in line_tails(text, value_leads)]
    return found


# Where a value's head ends in shell syntax (rules: freeText.valueHeadEnd): "x; export ..."
# and "x && ..." name the value x (review W2-19).
_HEAD_END = _compile(RULES["freeText"]["valueHeadEnd"])


def _span_values(text, members):
    """The values a merged span's candidates identified, each bounded: a free-text
    candidate's own assignment, the first one's whole judged tail, and any other candidate's
    value or text."""
    out, tail = set(), True
    for candidate in members:
        if "core_end" in candidate:
            if "quoted_end" in candidate:
                out.add(text[candidate["start"]:candidate["quoted_end"]])
            core = text[candidate["start"]:candidate["core_end"]].rstrip(" \t,;")
            if core and not _placeholder_at(text, candidate["start"], candidate["start"] + len(core)):
                out.add(core)
                cut = _HEAD_END.search(core)
                head = core[:cut.start()].rstrip(" \t,;") if cut else ""
                if head and not is_placeholder(head):
                    out.add(head)
            if tail:
                out.add(text[candidate["start"]:candidate["value_end"]])
                tail = False
        else:
            out.add(candidate.get("value", text[candidate["start"]:candidate["end"]]))
    return {v for v in out if v}


def find_secrets(text, values=False):
    """Every span in text that looks like a credential, in text order: [{kind, start, end,
    prefix}], the same spans as src/secrets.mjs. With values=True each span also lists the
    values its candidates identified ("values"): a free-text span runs to the end of the line,
    but its value is the judged part, so the gateway can find bare copies of it."""
    if not isinstance(text, str) or not text:
        return []
    spans = []
    for candidate in sorted(candidates(text), key=lambda c: (c["start"], c["rank"])):
        if spans and candidate["start"] < spans[-1]["end"]:
            last = spans[-1]
            last["end"] = max(last["end"], candidate["end"])
            last["members"].append(candidate)
            if candidate["rank"] < last["best"]["rank"]:
                last["best"] = candidate
        else:
            spans.append({"start": candidate["start"], "end": candidate["end"], "best": candidate,
                          "members": [candidate]})
    out = []
    for span in spans:
        best = span["best"]
        finding = {"kind": best["kind"], "start": span["start"], "end": span["end"],
                   "prefix": best["prefix"] if best["start"] == span["start"] and best["end"] == span["end"] else 0}
        if values:   # built only when asked for (review W2-13)
            finding["values"] = sorted(_span_values(text, span["members"]))
        out.append(finding)
    return out


def redact_text(text, findings=None):
    findings = find_secrets(text) if findings is None else findings
    out, at = [], 0
    for finding in findings:
        out.append(text[at:finding["start"]] + f"[REDACTED {finding['kind']}]")
        at = finding["end"]
    return "".join(out) + text[at:]
