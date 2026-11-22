"""W2: the data gateway and output gate of a latent squad (docs/watchdog-security.md).

The gateway runs before the squad reads anything and decides what it may see and do:

- Labels by origin, not by content. Each input span carries its trust (the user's own
  request, or untrusted), its sensitivity (declared by the project or the user) and its
  owner (the project). Origin labels are exact; content scanners are not.
- Need to know. Only the run's own request enters by default; any other span enters only
  when the task names it. A path the shared secret-file rule (rules/latent-rules.json)
  marks secret is refused even when named.
- Placeholders. Declared secrets, anything the shared secret scanner finds
  (secret_scan.py, rules/secret-rules.json) in any admitted span, and every other
  occurrence of those values, are replaced by opaque tokens in one pass on the original
  text, before the model sees any of it. The gateway keeps the map and puts values back
  in code, only for an output or tool cleared to receive them. A token carries 128 random
  bits made for the run, and input that holds the reserved "[[secret-" is neutralised, so
  no input can forge or collide with one. A fragment of a value is not recognised.
- One label for the whole memory: the strictest label of anything admitted, because
  every later agent attends to everything before it.
- Permissions before data. Allowed tools, their argument rules and every budget are
  fixed before any untrusted span is read, and nothing read later can widen them.
- Rule of two. A run holds at most two of: untrusted input, sensitive data, tools with
  outside effect. With all three, the tools are switched off for that run.
- No reuse across projects. Every span and the memory belong to one project.

The tool gate checks every tool call, on the arguments as they would be sent (after
placeholders are put back for a cleared tool), against those permissions and the memory's
label; a sensitive memory may reach only cleared tools, and an uncleared tool never gets a
known value or a placeholder. A refused call has no effect. The output gate replaces every
known value an uncleared answer holds, scans the final text, puts placeholders back by the
output's clearance, and reports a broken label rule (a sensitive memory with an output not
cleared for it), which the supervisor holds on.

Today's routes have no files and no tools. /latent/team's question is the caller's own
request; the OpenAI-compatible chat route flattens system text, earlier turns and the new
message into one string, so that string is labelled untrusted as a whole.

Plain code and standard library only. Nothing here is stored.
"""
import re
import secrets
import threading
import unicodedata
from dataclasses import dataclass, field
from typing import Optional

from . import secret_scan

BACKSLASH = chr(92)

TRUST = ("user", "untrusted")
SENSITIVITY = ("public", "sensitive")
ORIGIN_TRUST = {"request": "user", "chat": "untrusted", "system": "untrusted", "history": "untrusted",
                "file": "untrusted", "tool-result": "untrusted", "web": "untrusted"}
IDENTIFIER = re.compile(r"[a-z0-9][a-z0-9._:-]{0,95}\Z")
REQUEST_ORIGINS = ("request", "chat")   # the run's own request: always admitted


class GatewayError(ValueError):
    def __init__(self, reason, detail=""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason


def _identifier(value, what):
    if not isinstance(value, str) or IDENTIFIER.match(value) is None:
        raise GatewayError("malformed", f"{what} must be an identifier")
    return value


@dataclass(frozen=True)
class Label:
    trust: str
    sensitivity: str
    owner: str

    def join(self, other):
        """The stricter of two labels. Two projects never share a memory."""
        if self.owner != other.owner:
            raise GatewayError("cross-project", f"{self.owner} and {other.owner}")
        return Label("untrusted" if "untrusted" in (self.trust, other.trust) else "user",
                     "sensitive" if "sensitive" in (self.sensitivity, other.sensitivity) else "public", self.owner)

    def as_dict(self):
        return {"trust": self.trust, "sensitivity": self.sensitivity}


@dataclass(frozen=True)
class Span:
    id: str
    origin: str
    text: str
    owner: Optional[str] = None     # the project the span came from; None: the run's project
    path: Optional[str] = None      # for files
    sensitive: bool = False         # declared sensitive by the project's settings or the user


@dataclass(frozen=True)
class Argument:
    name: str
    kind: str = "string"            # "string" or "integer"
    required: bool = True
    max_length: int = 256
    pattern: Optional[str] = None   # a string must fullmatch it
    low: int = 0
    high: int = 10 ** 9


@dataclass(frozen=True)
class Tool:
    name: str
    outside_effect: bool
    arguments: tuple = ()
    cleared: bool = False           # may receive sensitive data and placeholder values


@dataclass(frozen=True)
class Permissions:
    """Fixed from the user's request before any untrusted span is read; frozen."""
    tools: tuple = ()
    max_tool_calls: int = 0
    max_steps: int = 80
    max_new_tokens: int = 1024
    max_seconds: float = 180.0
    clearance: str = "public"       # what the answer may receive: "public" or "sensitive"

    def tool(self, name):
        for tool in self.tools:
            if tool.name == name:
                return tool
        return None


@dataclass
class Admission:
    """What the squad may read: the text with placeholders, the memory's one label, and the
    tools left after the rule of two. Counts only; the placeholder map stays in the gateway."""
    text: str
    label: Label
    tools: tuple
    spans: tuple
    left_out: int = 0
    refused: int = 0
    placeholders: int = 0
    rule_of_two: bool = False       # True when the tools were switched off by it

    def receipt(self):
        return {"label": self.label.as_dict(), "spans": len(self.spans), "leftOut": self.left_out,
                "refused": self.refused, "placeholders": self.placeholders, "toolsOff": self.rule_of_two}


# Tab and the line breaks: read as a space in both canonical forms, never dropped. Every other
# control character, and every format character, is invisible. The same policy, by Unicode
# category and code point only, is in src/secrets.mjs; rules/canonical-cases.json holds the
# cases both suites run.
_LINE_CONTROLS = frozenset((9, 10, 11, 12, 13))


def _character_at(text, i, decode=True):
    """The character at i, with an escape decoded unless decode is False, and the index after
    it. A high surrogate, escaped or not, joins the low surrogate right after it, escaped or not."""
    escape = secret_scan.escape_at(text, i) if decode and text[i] == BACKSLASH else None
    character, i = (escape[0], i + escape[1]) if escape else (text[i], i + 1)
    if 0xD800 <= ord(character) <= 0xDBFF and i < len(text):
        low = secret_scan.escape_at(text, i) if decode and text[i] == BACKSLASH else (text[i], 1)
        if low and 0xDC00 <= ord(low[0]) <= 0xDFFF:
            character = chr(0x10000 + ((ord(character) - 0xD800) << 10) + (ord(low[0]) - 0xDC00))
            i += low[1]
    return character, i


def _blank_or_invisible(character):
    category = unicodedata.category(character)
    if category in ("Zl", "Zp", "Zs") or ord(character) in _LINE_CONTROLS:
        return "blank"
    if category in ("Cc", "Cf"):
        return "invisible"
    return None


def _view(text, decode=True, invisible="keep", fold=False):
    """(a view of text, the original (start, end) of each of its characters). decode: quoted-
    string escapes decoded. invisible: each control or format character other than tab and
    the line breaks kept ("keep"), read as nothing ("drop") or read as a blank ("space").
    fold: every blank, and any run of them, read as one space."""
    chars, spans, i = [], [], 0
    while i < len(text):
        start = i
        character, i = _character_at(text, i, decode)
        kind = _blank_or_invisible(character)
        if kind == "invisible":
            if invisible == "drop":
                continue
            kind = "blank" if invisible == "space" else None
        if kind == "blank" and fold:
            if chars and chars[-1] == " ":
                spans[-1] = (spans[-1][0], i)
                continue
            character = " "
        chars.append(character)
        spans.append((start, i))
    return "".join(chars), spans


def decoded_view(text):
    """text with its quoted-string escapes decoded and nothing else changed: the view in which
    a line-oriented rule sees a value written with escaped line breaks, such as a private key
    in a JSON string."""
    return _view(text)


def cleaned_view(text):
    """text with its escapes decoded and its invisible characters dropped, line breaks and
    spaces kept: the view in which a line-oriented rule sees a value both escaped and split by
    an invisible character, such as a private key's line with a zero-width space in it."""
    return _view(text, invisible="drop")


def canon(text, drop=False, decode=True):
    """(canonical text, the original (start, end) of each canonical character).

    The canonical forms are how a copy of a value can look after the transformations a
    secret passes through between here and a reader: quoted-string escapes decoded
    (surrogate pairs joined), every space or separator character, tab or line break, and any
    run of them, read as one space, and each other control or format character read either
    as a space too (drop False: what the ledger's one-line printing does) or as nothing
    (drop True: what a display shows). Matching known values in both forms, with offsets
    mapped back, finds an escaped, spaced or invisibly split copy of a value. decode=False
    reads a value's own backslashes as written (for values that hold one)."""
    return _view(text, decode, "drop" if drop else "space", fold=True)


def canon_ranges(text, values):
    """Original ranges of text where either canonical form holds the same form of a value: of
    the value with its escapes decoded, and of the value as written, so a value holding a
    backslash is found in a JSON-quoted copy too; the text is read both ways as well."""
    out = []
    for drop in (False, True):
        targets = {t for value in values
                   for t in (canon(value, drop)[0].strip(), canon(value, drop, decode=False)[0].strip()) if t}
        # The text is read with its escapes decoded and as written too, so a backslash split
        # from what follows it by an invisible character is not taken for an escape.
        for decode in (True, False):
            canonical, spans = canon(text, drop, decode)
            for target in targets:
                at = canonical.find(target)
                while at != -1:
                    out.append((spans[at][0], spans[at + len(target) - 1][1]))
                    at = canonical.find(target, at + 1)
    return out


def fold(text):
    """Runs of whitespace as one space, ends trimmed."""
    return " ".join(text.split())


def _combined(text):
    """Escaped surrogate pairs (as JSON writes an emoji) joined into one character, as a
    literal copy of the value is written."""
    try:
        return text.encode("utf-16", "surrogatepass").decode("utf-16")
    except UnicodeError:
        return text


def spellings(value):
    """The spellings of one secret: as written, as its quoted-string escapes decode (surrogate
    pairs combined), trimmed, and with its whitespace folded, as text around it may carry it."""
    forms = {value, _combined(secret_scan.decoded(value))}
    forms |= {form.strip() for form in forms} | {fold(form) for form in forms}
    return {form for form in forms if form}


class Gateway:
    # A placeholder is [[secret-<n>-<32 hex>]]: 128 random bits made for the run. Input text
    # that already holds the reserved opening "[[secret-" is neutralised before anything
    # else, so no input can carry, forge or collide with a token.
    RESERVED = "[[secret-"
    NEUTRAL = "[(secret-"

    def __init__(self, project, declared_secrets=(), scanner=secret_scan.find_secrets, secret_path=None):
        self.project = _identifier(project, "project")
        self.declared = tuple(sorted({s for s in declared_secrets if isinstance(s, str) and s}, key=len,
                                     reverse=True))
        self.scanner = scanner
        if secret_path is None:
            from latent_pool.prefix import is_secret_path

            def secret_path(path):
                return is_secret_path([part for part in path.replace(chr(92), "/").split("/") if part])
        self.secret_path = secret_path
        self.permissions = None
        self.nonce = secrets.token_hex(16)
        self._values = {}           # placeholder token -> value; never stored, never returned
        self._tokens = {}           # value -> placeholder token
        self._egress = set()        # every declared value and original finding: never out uncleared
        self.tool_calls = 0         # the run's tool budget is counted here, whatever gate sends
        self.tool_lock = threading.Lock()
        self.admission = None

    # ------------------------------------------------------------ before the squad reads
    def fix_permissions(self, permissions):
        if self.permissions is not None:
            raise GatewayError("permissions-fixed", "permissions are fixed once per run")
        if self.admission is not None:
            raise GatewayError("permissions-after-data", "permissions must be fixed before any span is read")
        if not isinstance(permissions, Permissions) or permissions.clearance not in SENSITIVITY:
            raise GatewayError("malformed", "permissions")
        # A snapshot of every rule, in tuples of frozen values: nothing the caller still holds
        # can widen them later.
        tools = []
        for tool in tuple(permissions.tools):
            if not isinstance(tool, Tool) or not isinstance(tool.name, str) or \
                    type(tool.outside_effect) is not bool or type(tool.cleared) is not bool:
                raise GatewayError("malformed", "tools")
            rules = tuple(tool.arguments)   # read once: an iterator is not consumed by the check
            for a in rules:
                if not isinstance(a, Argument) or not isinstance(a.name, str) or a.kind not in ("string", "integer") \
                        or type(a.required) is not bool or type(a.max_length) is not int \
                        or (a.pattern is not None and not isinstance(a.pattern, str)) \
                        or type(a.low) is not int or type(a.high) is not int:
                    raise GatewayError("malformed", "argument rule")
            arguments = tuple(Argument(a.name, a.kind, a.required, a.max_length, a.pattern, a.low, a.high)
                              for a in rules)
            tools.append(Tool(tool.name, tool.outside_effect, arguments, tool.cleared))
        self.permissions = Permissions(tuple(tools), int(permissions.max_tool_calls), int(permissions.max_steps),
                                       int(permissions.max_new_tokens), float(permissions.max_seconds),
                                       permissions.clearance)
        return self.permissions

    def _scan(self, text):
        """Findings with the values they identified, whatever scanner the gateway was given."""
        try:
            return self.scanner(text, values=True)
        except TypeError:
            return self.scanner(text)

    def _scan_all(self, text):
        """The scanner's findings on text as written, with its escapes decoded and with its
        invisible characters dropped too (line breaks kept in both, for line-oriented rules
        such as a private key's), and in both canonical forms,
        each mapped back to its original range, with the view's spelling among its values:
        a credential that only a reader of one of those views would see (a name and its
        value split by an invisible character, or an escaped one) is found too."""
        findings = list(self._scan(text))
        for canonical, spans in (decoded_view(text), cleaned_view(text), canon(text, False), canon(text, True)):
            if canonical == text:
                continue
            for finding in self._scan(canonical):
                start, end = finding["start"], finding["end"]
                if end <= start:
                    continue
                values = set(finding.get("values", ())) | {canonical[start:end]}
                findings.append(dict(finding, start=spans[start][0], end=spans[end - 1][1], values=sorted(values)))
        return findings

    def _placeholder(self, value):
        if value not in self._tokens:
            token = f"[[secret-{len(self._tokens) + 1}-{self.nonce}]]"
            self._tokens[value] = token
            self._values[token] = value
        return self._tokens[value]

    @staticmethod
    def _merge(ranges):
        merged = []
        for start, end in sorted(r for r in ranges if r[1] > r[0]):
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        return merged

    def _occurrences(self, text, values):
        ranges = []
        for value in values:
            at = text.find(value)
            while at != -1:
                ranges.append((at, at + len(value)))
                at = text.find(value, at + 1)
        return ranges

    def _hide_all(self, texts, separator):
        """The memory's text, assembled first: every span's own scanner findings (in its own
        context), the findings of a scan of the assembled text (a credential can form across
        two spans), the declared values, and every other occurrence of any of those values,
        all found on the original text, merged where they overlap and replaced in one pass.
        Returns (text, count of ranges replaced). Every declared value and original finding
        also joins the egress set the output and tool gates check, placeholder or not."""
        joined, offsets, at = separator.join(texts), [], 0
        for text in texts:
            offsets.append(at)
            at += len(text) + len(separator)
        findings = self._scan_all(joined)
        ranges = [(f["start"], f["end"]) for f in findings]
        for text, offset in zip(texts, offsets):   # each span read alone, as the ledger would read it
            alone = self._scan_all(text)
            findings += alone
            ranges += [(offset + f["start"], offset + f["end"]) for f in alone]
        for value in self.declared:
            self._egress.update(spellings(value))
        for start, end in ranges:   # the spelling in the text, and the value its escapes decode to
            self._egress.update(spellings(joined[start:end]))
        for finding in findings:    # the value each finding identified (a free-text span runs on)
            for value in finding.get("values", ()):
                self._egress.update(spellings(value))
        known = sorted((v for v in self._egress if v), key=len, reverse=True)
        merged = self._merge(ranges + self._occurrences(joined, known) + canon_ranges(joined, known))
        pieces, at = [], 0
        for start, end in merged:   # the reserved opening is neutralised in literal text only
            pieces.append(joined[at:start].replace(self.RESERVED, self.NEUTRAL) + self._placeholder(joined[start:end]))
            at = end
        rendered = "".join(pieces) + joined[at:].replace(self.RESERVED, self.NEUTRAL)
        # Verify what the model will read: no known value may survive, not even inside a
        # placeholder or the neutralised text the gateway wrote itself.
        if self.holds_value(self.masked_out(rendered)) or self.holds_value(rendered):
            raise GatewayError("unsafe-render", "a known value is still in the text the model would read")
        # A placeholder's closing brackets can give a neighbouring credential the word boundary
        # its rule needs (review W2-12): the rendered text is scanned again, and a finding
        # outside the placeholders holds the run.
        if self.unauthorised(rendered, self._token_ranges(rendered)):
            raise GatewayError("unsafe-render", "a credential is exposed next to a placeholder")
        return rendered, len(merged)

    def _token_ranges(self, text):
        ranges = []
        for token in self._values:
            at = text.find(token)
            while at != -1:
                ranges.append((at, at + len(token)))
                at = text.find(token, at + 1)
        return ranges

    def masked_out(self, text):
        """text without its placeholder tokens (for checking what else it holds)."""
        for token in self._values:
            text = text.replace(token, "")
        return text

    def admit(self, spans, named=()):
        """Admit the run's own request and the spans the task names, label them and build the
        memory's text. named: the ids of the other spans the task names; a span that is not
        named never enters (need to know)."""
        if self.permissions is None:
            raise GatewayError("permissions-not-fixed", "fix the permissions before reading any span")
        if self.admission is not None:
            raise GatewayError("admitted", "one admission per run")
        label, kept, chosen = None, [], []
        left_out = refused = 0
        named = set(named or ())
        ids = [span.id for span in spans]
        if len(ids) != len(set(ids)):   # need to know is by id: an id must name one span
            raise GatewayError("duplicate-span", "span ids must be unique")
        for span in spans:
            _identifier(span.id, "span id")
            if span.origin not in ORIGIN_TRUST:
                raise GatewayError("malformed", f"unknown origin {span.origin!r}")
            owner = span.owner if span.owner is not None else self.project
            if owner != self.project:
                raise GatewayError("cross-project", f"span {span.id} belongs to {owner}")
            if span.origin not in REQUEST_ORIGINS and span.id not in named:
                left_out += 1
                continue
            if span.path is not None and self.secret_path(span.path):
                refused += 1
                continue
            own = Label(ORIGIN_TRUST[span.origin], "sensitive" if span.sensitive else "public", owner)
            label = own if label is None else label.join(own)
            kept.append(span.id)
            chosen.append(span.text)
        if label is None:
            raise GatewayError("empty", "nothing was admitted")
        text, placeholders = self._hide_all(chosen, "\n\n")
        tools = tuple(self.permissions.tools)
        outside = any(t.outside_effect for t in tools)
        # Values held for restoration are sensitive data of the run even though the memory
        # holds only their placeholders: a cleared tool could receive them.
        sensitive_data = label.sensitivity == "sensitive" or bool(self._values) or bool(self._egress)
        off = label.trust == "untrusted" and sensitive_data and outside
        if off:
            tools = ()
        self.admission = Admission(text, label, tools, tuple(kept), left_out, refused, placeholders, off)
        return self.admission

    def fit(self, limit, marker):
        """Cut the admitted text to `limit` characters, keeping its head and tail, never inside
        a placeholder. Runs after admission, so no secret can straddle the cut."""
        text = self.admission.text
        if len(text) <= limit:
            return text
        head = (limit - len(marker)) // 4
        tail = len(text) - (limit - len(marker) - head)
        for token in self._values:
            at = text.find(token)
            while at != -1:
                if at < head < at + len(token):
                    head = at
                if at < tail < at + len(token):
                    tail = at + len(token)
                at = text.find(token, at + 1)
        fitted = text[:head] + marker + text[tail:]
        if self.holds_value(self.masked_out(fitted)):   # the marker must not bring a known value in
            raise GatewayError("unsafe-render", "the cut would put a known value in the text")
        # The cut can give a credential the word boundary its rule needs (review W2-13).
        if self.unauthorised(fitted, self._token_ranges(fitted)):
            raise GatewayError("unsafe-render", "the cut exposes a credential")
        self.admission.text = fitted
        return self.admission.text

    # ------------------------------------------------------------ after the squad
    def restore(self, text):
        """Placeholders put back, in one pass. Only for an output or tool cleared to receive
        them: declared values and scanner findings alike."""
        return self.restore_tracked(text)[0]

    def restore_tracked(self, text, keep=()):
        """restore(), with the (start, end) of every value put back, in the restored text, and
        the ranges in keep (which hold no placeholder) moved to where they now are."""
        if not self._values:
            return text, [], list(keep)
        pattern = re.compile("|".join(re.escape(token) for token in self._values))
        pieces, put_back, at, length, shifts = [], [], 0, 0, []
        for match in pattern.finditer(text):
            before, value = text[at:match.start()], self._values[match.group(0)]
            pieces += [before, value]
            put_back.append((length + len(before), length + len(before) + len(value)))
            shifts.append((match.end(), length + len(before) + len(value) - match.end()))
            length += len(before) + len(value)
            at = match.end()
        pieces.append(text[at:])

        def moved(position):
            delta = 0
            for end, shift in shifts:
                if end <= position:
                    delta = shift
            return position + delta

        return "".join(pieces), put_back, [(moved(a), moved(b)) for a, b in keep]

    def unauthorised(self, text, allowed=(), put_back=(), values=None):
        """The ranges of text's scanner findings (every view, placeholders masked) that no
        marker, placeholder or restoration authorised (review W2-11, W2-12). A finding is
        judged by the values it identified, where they lie in the text (the whole finding
        where a value cannot be placed): a value inside the allowed ranges is authorised; a
        value that overlaps a value put back is authorised except where it reaches outside
        it with a word character (a sentence's full stop is not a credential, more text is);
        any other value is not, whatever its characters (a value of only punctuation too).
        values: a set that receives the text of each part not authorised (review W2-14)."""
        out = []
        for finding in self._scan_all(self.masked(text)):
            start, end = finding["start"], finding["end"]
            span = text[start:end]
            places = []
            for value in finding.get("values") or [span]:
                at = span.find(value) if value else -1
                places.append((start + at, start + at + len(value)) if at != -1 else (start, end))
            for a, b in places:
                outside = _subtract((a, b), allowed)
                if any(x < b and a < y for x, y in put_back):
                    outside = [(x, y) for x, y in outside if re.search(r"\w", text[x:y])]
                out += outside
                if values is not None:
                    values.update(text[x:y] for x, y in outside if text[x:y].strip())
        return self._merge(out)

    def holds_placeholder(self, text):
        return any(token in text for token in self._values)

    def holds_value(self, text, collapsed=False):
        """Does text hold a known secret value itself: a declared one or an original finding,
        whether or not it has a placeholder of its own? collapsed=True also compares with runs
        of whitespace folded to one space, as a client printing the answer on one line does."""
        values = [v for v in self._egress if v] + [s for v in self.declared for s in spellings(v)]
        if any(value in text for value in values):
            return True
        if collapsed:   # escaped, spaced or invisibly split copies, as a reader may see them
            return bool(canon_ranges(text, values))
        return False

    def known_values(self):
        """Every value the gates check: declared ones in all their spellings, and the egress set."""
        return {v for v in self._egress if v} | {s for v in self.declared for s in spellings(v) if s}

    def value_ranges(self, text):
        values = sorted((v for v in set(self._egress) | {s for v in self.declared for s in spellings(v)} if v),
                        key=len, reverse=True)
        return self._occurrences(text, values) + canon_ranges(text, values)

    def check_rendered(self, text):
        """Raise GatewayError if a known value, or a credential outside the placeholders, is in
        text the model would read (a role template around the admitted text could complete or
        expose one, review W2-13)."""
        if self.holds_value(text, collapsed=True) or self.holds_value(self.masked_out(text), collapsed=True):
            raise GatewayError("unsafe-render", "a known value is in the text as the model would read it")
        if self.unauthorised(text, self._token_ranges(text)):
            raise GatewayError("unsafe-render", "a credential is exposed in the text as the model would read it")

    def masked(self, text):
        """text with every placeholder token turned into #'s of the same length: a stand-in to
        the scanner, and not a word character, so a credential right after a token keeps its
        word boundary."""
        for token in self._values:
            text = text.replace(token, "#" * len(token))
        return text


@dataclass
class ToolResult:
    sent: bool
    reason: str
    result: object = None


class ToolGate:
    """Every tool call is checked before it is sent, on the arguments that would be sent; a
    refused call never reaches `send`."""

    def __init__(self, gateway):
        if gateway.admission is None:
            raise GatewayError("not-admitted", "the tool gate needs the run's admission")
        self.gateway, self.admission = gateway, gateway.admission
        self.permissions = gateway.permissions
        self.calls = 0
        self.refused = 0

    def _arguments(self, tool, arguments):
        if not isinstance(arguments, dict):
            return False
        rules = {a.name: a for a in tool.arguments}
        if set(arguments) - set(rules):
            return False
        for name, rule in rules.items():
            if name not in arguments:
                if rule.required:
                    return False
                continue
            value = arguments[name]
            if rule.kind == "integer":
                if type(value) is not int or not rule.low <= value <= rule.high:
                    return False
            elif type(value) is not str or len(value) > rule.max_length or \
                    (rule.pattern is not None and re.fullmatch(rule.pattern, value) is None):
                return False
        return True

    def _final(self, tool, arguments):
        """The arguments as they would be sent: placeholders put back only for a cleared tool."""
        if not isinstance(arguments, dict):
            return arguments
        if not tool.cleared:
            return dict(arguments)
        return {k: self.gateway.restore(v) if isinstance(v, str) else v for k, v in arguments.items()}

    def check(self, call):
        """The reason word a call would be refused for, or "allowed"."""
        return self._check(call)[0]

    def _check(self, call):
        """(reason, tool, the outbound arguments): every rule is checked on exactly what would
        be sent."""
        name = call.get("name") if isinstance(call, dict) else None
        tool = self.permissions.tool(name) if isinstance(name, str) else None
        if tool is not None and tool not in self.admission.tools:
            return "tools-off", None, None
        if tool is None:
            return "not-allowed", None, None
        final = self._final(tool, call.get("arguments", {}))
        reason = self._judge(tool, final)
        return reason, tool, final

    def _judge(self, tool, final):
        if not self._arguments(tool, final):   # the rules apply to what is sent, after restoring
            return "argument-rule"
        if self.gateway.tool_calls >= self.permissions.max_tool_calls:
            return "budget"
        if self.admission.label.sensitivity == "sensitive" and not tool.cleared:
            return "label"   # read-only or not: a call can carry what the memory holds
        # names travel too, and an integer is sent as text
        outbound = [tool.name] + [str(k) for k in final] + [v if isinstance(v, str) else str(v) for v in final.values()]
        if not tool.cleared and any(self.gateway.holds_placeholder(v) or self.gateway.holds_value(v, collapsed=True)
                                    for v in outbound):
            return "placeholder"
        return "allowed"

    def submit(self, call, send):
        import copy
        snapshot = copy.deepcopy(call)   # one read of the call: what is checked is what is sent
        with self.gateway.tool_lock:     # the check and the budget reservation are one step
            reason, tool, final = self._check(snapshot)
            if reason == "allowed":
                self.gateway.tool_calls += 1
        if reason != "allowed":
            self.refused += 1
            return ToolResult(False, reason)
        self.calls += 1
        return ToolResult(True, "sent", send(tool.name, final))


def _subtract(span, ranges):
    """The parts of span outside every range."""
    at, end = span
    out = []
    for a, b in sorted(ranges):
        if b <= at or a >= end:
            continue
        if a > at:
            out.append((at, a))
        at = max(at, b)
    if at < end:
        out.append((at, end))
    return out


def _replace(text, ranges, marker, keeps):
    """text with each of the (sorted, disjoint) ranges replaced by marker; returns the new
    text, the marker ranges in it, and each list of ranges in keeps (disjoint from those
    replaced) moved to where it now is."""
    pieces, markers, at, length = [], [], 0, 0
    shifts = []
    for start, end in ranges:
        before = text[at:start]
        pieces += [before, marker]
        markers.append((length + len(before), length + len(before) + len(marker)))
        shifts.append((end, length + len(before) + len(marker) - end))
        length += len(before) + len(marker)
        at = end
    pieces.append(text[at:])

    def moved(position):
        delta = 0
        for end, shift in shifts:
            if end <= position:
                delta = shift
        return position + delta

    return "".join(pieces), markers, [[(moved(a), moved(b)) for a, b in keep] for keep in keeps]


def redaction_marker(kind, values):
    """The text that replaces a redacted range: [REDACTED kind] unless that holds one of the
    values it is replacing or checking in any canonical form (a found value ACT is inside
    REDACTED), else a stand-in the scanner also reads as none. src/latent.mjs chooses the same."""
    for marker in (f"[REDACTED {kind}]", "***", "###", "---"):
        if not canon_ranges(marker, values):
            return marker
    return "***"   # every marker holds a value: the verification that follows refuses the release


@dataclass
class Release:
    text: str
    marks: tuple = ()
    redactions: int = 0
    restored: bool = False
    safe: bool = True             # False: a known value is still in an uncleared output


class OutputGate:
    """Between the solver's text and the world, on both routes."""

    def __init__(self, gateway):
        if gateway.admission is None:
            raise GatewayError("not-admitted", "the output gate needs the run's admission")
        self.gateway, self.admission = gateway, gateway.admission
        self.clearance = gateway.permissions.clearance

    def label_broken(self):
        """A sensitive memory may only answer an output cleared for sensitive data."""
        return self.admission.label.sensitivity == "sensitive" and self.clearance != "sensitive"

    def release(self, text):
        """The scanner reads the answer as the model wrote it (placeholders masked), and for an
        output not cleared every known value the answer holds itself is found too; all the
        ranges are merged and redacted in one pass, so no substitution can hide a finding.
        Then, for a cleared output only, the placeholders are put back."""
        gateway = self.gateway
        kinds, found = {}, set()
        for finding in gateway._scan_all(gateway.masked(text)):
            kinds[(finding["start"], finding["end"])] = finding["kind"]
            found |= spellings(text[finding["start"]:finding["end"]])
            for value in finding.get("values", ()):
                found |= spellings(value)
        found.discard("")
        uncleared = self.clearance != "sensitive"
        ranges = list(kinds)
        # Every occurrence of a value this scan found, and (uncleared) of every known value.
        ranges += gateway._occurrences(text, sorted(found, key=len, reverse=True)) + canon_ranges(text, found)
        if uncleared:
            ranges += gateway.value_ranges(text)
        merged = gateway._merge(ranges)
        checked = found | (gateway.known_values() if uncleared else set())
        markers = []
        if merged:
            pieces, at, length = [], 0, 0
            for start, end in merged:
                kind = next((k for (a, b), k in kinds.items() if start <= a and b <= end), "secret")
                marker = redaction_marker(kind, checked)
                before = text[at:start]
                pieces += [before, marker]
                markers.append((length + len(before), length + len(before) + len(marker)))
                length += len(before) + len(marker)
                at = end
            text = "".join(pieces) + text[at:]
        # Verify the text that would leave, before any value is put back: no value the scan
        # found, whatever its length, may be in it in any form, and for an output not cleared
        # no known value either, not even one a marker and its neighbours spell. Such a
        # release is refused (safe = False) and the guard holds the run.
        safe = not any(value in text for value in found) and not canon_ranges(text, found) and \
            not (uncleared and gateway.holds_value(text, collapsed=True))
        restored, count, put_back = False, len(merged), []
        if not uncleared and gateway.holds_placeholder(text):
            text, put_back, markers = gateway.restore_tracked(text, markers)
            restored = True
        # What substitution exposes is checked too (review W2-11, W2-12): a marker's brackets
        # can give a neighbouring credential its word boundary, and a value put back can form
        # one with the model's own text. The parts no marker, placeholder or restoration
        # authorised are redacted, and the result is checked again; what still remains holds.
        allowed = markers + put_back + gateway._token_ranges(text)
        exposed = set()
        extra = gateway.unauthorised(text, allowed, put_back, exposed)
        if extra:
            # A value this rescan found has other copies too (review W2-14): every copy outside
            # what was authorised is redacted with it, and it joins the final check.
            for value in list(exposed):
                exposed |= spellings(value)
            exposed.discard("")
            copies = gateway._occurrences(text, sorted(exposed, key=len, reverse=True)) + canon_ranges(text, exposed)
            extra = gateway._merge([tuple(r) for r in extra] +
                                   [piece for copy in copies for piece in _subtract(copy, allowed)])
            found |= exposed
            marker = redaction_marker("secret", checked | exposed | set(gateway._values.values()))
            text, new_markers, (put_back, markers) = _replace(text, [tuple(r) for r in extra], marker,
                                                              [put_back, markers])
            count += len(extra)
            allowed = markers + new_markers + put_back + gateway._token_ranges(text)
            safe = safe and not gateway.unauthorised(text, allowed, put_back)
        # The last check is of the text that leaves, after every substitution (review W2-13):
        # no value the scan found, outside the values put back, in any form; and for an output
        # not cleared, no known value in any form, not even one a marker and its neighbours
        # spell.
        if any(not any(a <= s and e <= b for a, b in put_back)
               for s, e in gateway._occurrences(text, sorted(found, key=len, reverse=True)) + canon_ranges(text, found)):
            safe = False
        if uncleared and gateway.holds_value(text, collapsed=True):
            safe = False
        return Release(text, ("redacted",) if count else (), count, restored, safe)
