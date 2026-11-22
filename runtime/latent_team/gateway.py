"""W2: the data gateway and output gate of a latent squad (docs/watchdog-security.md).

The gateway runs before the squad reads anything and decides what it may see and do:

- Labels by origin, not by content. Each input span carries its trust (the user's own
  request, or untrusted), its sensitivity (declared by the project or the user) and its
  owner (the project). Origin labels are exact; content scanners are not.
- Need to know. Spans the task does not name never enter the memory. A path the shared
  secret-file rule (rules/latent-rules.json) marks secret is refused even when named.
- Placeholders. Declared secrets, and anything the shared secret scanner finds
  (secret_scan.py, rules/secret-rules.json), are replaced by opaque tokens before the
  model sees any text. The gateway keeps the map and puts values back in code, only for
  an output or tool cleared to receive them. A token carries a random part made for the
  run, so input text cannot forge one.
- One label for the whole memory: the strictest label of anything admitted, because
  every later agent attends to everything before it.
- Permissions before data. Allowed tools, their argument rules and every budget are
  fixed before any untrusted span is read, and nothing read later can widen them.
- Rule of two. A run holds at most two of: untrusted input, sensitive data, tools with
  outside effect. With all three, the tools are switched off for that run.
- No reuse across projects. Every span and the memory belong to one project.

The tool gate checks every tool call against those permissions and the memory's label
before it is sent; a refused call has no effect. The output gate scans the final text,
puts placeholders back by the output's clearance, and reports a broken label rule (a
sensitive memory with an output not cleared for it), which the supervisor holds on.

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
        self.nonce = secrets.token_hex(4)
        self._values = {}           # placeholder token -> value; never stored, never returned
        self._count = 0
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
        for token, known in self._values.items():
            if known == value:
                return token
        self._count += 1
        token = f"[[secret-{self._count}-{self.nonce}]]"
        self._values[token] = value
        return token

    def _hide(self, text):
        """Declared secrets, then scanner findings, replaced by placeholders. Returns (text, count)."""
        count = 0
        for value in self.declared:
            if value in text:
                count += text.count(value)
                text = text.replace(value, self._placeholder(value))
        findings = self.scanner(self.masked(text))
        if findings:
            out, at = [], 0
            for finding in findings:
                out.append(text[at:finding["start"]] + self._placeholder(text[finding["start"]:finding["end"]]))
                at = finding["end"]
                count += 1
            text = "".join(out) + text[at:]
        return text, count

    def masked(self, text):
        """text with every placeholder token turned into x's of the same length, so a scan
        neither flags a token nor lets one hide a real secret next to it."""
        for token in self._values:
            text = text.replace(token, "x" * len(token))
        return text

    def admit(self, spans, named=None):
        """Admit the spans the task names (the request always), label them and build the
        memory's text. named: the ids of the spans the task names; None names every span."""
        if self.permissions is None:
            raise GatewayError("permissions-not-fixed", "fix the permissions before reading any span")
        if self.admission is not None:
            raise GatewayError("admitted", "one admission per run")
        label, kept, texts = None, [], []
        left_out = refused = placeholders = 0
        for span in spans:
            _identifier(span.id, "span id")
            if span.origin not in ORIGIN_TRUST:
                raise GatewayError("malformed", f"unknown origin {span.origin!r}")
            owner = span.owner if span.owner is not None else self.project
            if owner != self.project:
                raise GatewayError("cross-project", f"span {span.id} belongs to {owner}")
            if span.origin != "request" and named is not None and span.id not in named:
                left_out += 1
                continue
            if span.path is not None and self.secret_path(span.path):
                refused += 1
                continue
            text, hidden = self._hide(span.text)
            placeholders += hidden
            own = Label(ORIGIN_TRUST[span.origin], "sensitive" if span.sensitive else "public", owner)
            label = own if label is None else label.join(own)
            kept.append(span.id)
            texts.append(text)
        if label is None:
            raise GatewayError("empty", "nothing was admitted")
        tools = tuple(self.permissions.tools)
        outside = any(t.outside_effect for t in tools)
        off = label.trust == "untrusted" and label.sensitivity == "sensitive" and outside
        if off:
            tools = ()
        self.admission = Admission("\n\n".join(texts), label, tools, tuple(kept), left_out, refused, placeholders, off)
        return self.admission

    # ------------------------------------------------------------ after the squad
    def restore(self, text):
        """Placeholders put back. Only for an output or tool cleared to receive them. Newest
        first: a later placeholder's value can hold an earlier token."""
        for token, value in reversed(list(self._values.items())):
            text = text.replace(token, value)
        return text

    def holds_placeholder(self, text):
        return any(token in text for token in self._values)


@dataclass
class ToolResult:
    sent: bool
    reason: str
    result: object = None


class ToolGate:
    """Every tool call is checked before it is sent; a refused call never reaches `send`."""

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

    def check(self, call):
        """The reason word a call would be refused for, or "allowed"."""
        name = call.get("name") if isinstance(call, dict) else None
        tool = self.permissions.tool(name) if isinstance(name, str) else None
        if tool is not None and tool not in self.admission.tools:
            return "tools-off"
        if tool is None:
            return "not-allowed"
        arguments = call.get("arguments", {})
        if not self._arguments(tool, arguments):
            return "argument-rule"
        if self.calls >= self.permissions.max_tool_calls:
            return "budget"
        if self.admission.label.sensitivity == "sensitive" and tool.outside_effect and not tool.cleared:
            return "label"
        if not tool.cleared and any(isinstance(v, str) and self.gateway.holds_placeholder(v)
                                    for v in arguments.values()):
            return "placeholder"
        return "allowed"

    def submit(self, call, send):
        reason = self.check(call)
        if reason != "allowed":
            self.refused += 1
            return ToolResult(False, reason)
        self.calls += 1
        tool = self.permissions.tool(call["name"])
        arguments = dict(call.get("arguments", {}))
        if tool.cleared:
            arguments = {k: self.gateway.restore(v) if isinstance(v, str) else v for k, v in arguments.items()}
        return ToolResult(True, "sent", send(call["name"], arguments))


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
        """Scan first (on the text as the model wrote it), then put placeholders back only
        for a cleared output, so a cleared value is never redacted by its own scan."""
        findings = self.gateway.scanner(self.gateway.masked(text))
        marks = ()
        if findings:
            text = secret_scan.redact_text(text, findings)
            marks += ("redacted",)
        restored = False
        if self.clearance == "sensitive" and self.gateway.holds_placeholder(text):
            text, restored = self.gateway.restore(text), True
        return Release(text, marks, len(findings), restored)
