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
from dataclasses import dataclass, field
from typing import Optional

from . import secret_scan

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
        self.admission = None

    # ------------------------------------------------------------ before the squad reads
    def fix_permissions(self, permissions):
        if self.permissions is not None:
            raise GatewayError("permissions-fixed", "permissions are fixed once per run")
        if self.admission is not None:
            raise GatewayError("permissions-after-data", "permissions must be fixed before any span is read")
        if not isinstance(permissions, Permissions) or permissions.clearance not in SENSITIVITY:
            raise GatewayError("malformed", "permissions")
        self.permissions = permissions
        return permissions

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

    def _hide_all(self, texts):
        """Every span's declared secrets and scanner findings, then every other occurrence of
        any value found anywhere, replaced in one pass per span on the original text, with
        overlapping ranges merged. Returns (texts, count of ranges replaced)."""
        texts = [t.replace(self.RESERVED, self.NEUTRAL) for t in texts]
        known = set(self.declared)
        for text in texts:   # the scanner reads each original text before anything is replaced
            known.update(text[f["start"]:f["end"]] for f in self.scanner(text))
        known = sorted((v for v in known if v), key=len, reverse=True)
        out, count = [], 0
        for text in texts:
            ranges = self._merge([(f["start"], f["end"]) for f in self.scanner(text)] +
                                 self._occurrences(text, known))
            pieces, at = [], 0
            for start, end in ranges:
                pieces.append(text[at:start] + self._placeholder(text[start:end]))
                at = end
            out.append("".join(pieces) + text[at:])
            count += len(ranges)
        return out, count

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
        texts, placeholders = self._hide_all(chosen)
        tools = tuple(self.permissions.tools)
        outside = any(t.outside_effect for t in tools)
        off = label.trust == "untrusted" and label.sensitivity == "sensitive" and outside
        if off:
            tools = ()
        self.admission = Admission("\n\n".join(texts), label, tools, tuple(kept), left_out, refused, placeholders, off)
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
        self.admission.text = text[:head] + marker + text[tail:]
        return self.admission.text

    # ------------------------------------------------------------ after the squad
    def restore(self, text):
        """Placeholders put back, in one pass. Only for an output or tool cleared to receive
        them: declared values and scanner findings alike."""
        if not self._values:
            return text
        pattern = re.compile("|".join(re.escape(token) for token in self._values))
        return pattern.sub(lambda match: self._values[match.group(0)], text)

    def holds_placeholder(self, text):
        return any(token in text for token in self._values)

    def holds_value(self, text):
        """Does text hold any known secret value itself (declared or found)?"""
        return any(value in text for value in self._tokens)

    def hide_values(self, text):
        """Every known value in text replaced by its placeholder (longest first)."""
        for value in sorted(self._tokens, key=len, reverse=True):
            text = text.replace(value, self._tokens[value])
        return text

    def masked(self, text):
        """text with every placeholder token turned into x's of the same length, so a scan
        neither flags a token nor lets one hide a real secret next to it."""
        for token in self._values:
            text = text.replace(token, "x" * len(token))
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
        name = call.get("name") if isinstance(call, dict) else None
        tool = self.permissions.tool(name) if isinstance(name, str) else None
        if tool is not None and tool not in self.admission.tools:
            return "tools-off"
        if tool is None:
            return "not-allowed"
        final = self._final(tool, call.get("arguments", {}))
        if not self._arguments(tool, final):   # the rules apply to what is sent, after restoring
            return "argument-rule"
        if self.calls >= self.permissions.max_tool_calls:
            return "budget"
        if self.admission.label.sensitivity == "sensitive" and not tool.cleared:
            return "label"   # read-only or not: a call can carry what the memory holds
        strings = [v for v in final.values() if isinstance(v, str)]
        if not tool.cleared and any(self.gateway.holds_placeholder(v) or self.gateway.holds_value(v) for v in strings):
            return "placeholder"
        return "allowed"

    def submit(self, call, send):
        reason = self.check(call)
        if reason != "allowed":
            self.refused += 1
            return ToolResult(False, reason)
        self.calls += 1
        tool = self.permissions.tool(call["name"])
        return ToolResult(True, "sent", send(call["name"], self._final(tool, call.get("arguments", {}))))


@dataclass
class Release:
    text: str
    marks: tuple = ()
    redactions: int = 0
    restored: bool = False


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
        """For an output not cleared: every known value (declared or found) the text holds
        itself is replaced by its placeholder, then the scanner redacts what else it finds.
        For a cleared output: the scan runs on the text as the model wrote it, then the
        placeholders are put back, so a cleared value is never redacted by its own scan."""
        gateway, redactions, marks = self.gateway, 0, ()
        if self.clearance != "sensitive" and gateway.holds_value(text):
            text, redactions, marks = gateway.hide_values(text), 1, ("redacted",)
        findings = gateway.scanner(gateway.masked(text))
        if findings:
            text = secret_scan.redact_text(text, findings)
            redactions += len(findings)
            marks = ("redacted",)
        restored = False
        if self.clearance == "sensitive" and gateway.holds_placeholder(text):
            text, restored = gateway.restore(text), True
        return Release(text, marks, redactions, restored)
