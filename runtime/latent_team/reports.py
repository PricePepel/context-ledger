"""W1: watchdog reports, their schema and their signatures (docs/watchdog-security.md).

A watchdog writes one report per squad per run. A report has a fixed shape, and every
field is a boolean, an integer from 0 to 9, a count, an identifier or one word from a
fixed list. There are no free numbers, vectors, logits, per-step values or text: a
report says how the data moved, never what it said, so it can be kept or shown without
holding any of the transcript.

Reports are signed with HMAC-SHA256 under a key made for the run (`secrets`), and the
supervisor refuses anything that does not verify. `seal_memory` and `MemoryReceiver` sign
a working memory that leaves the process; W1 keeps memory in one process, so nothing
calls them yet, and how the key reaches a receiver is for the card that moves memory.

Standard library only: no torch and no model, so these checks run anywhere.
"""
import hashlib
import hmac
import json
import re
import secrets
import time

SCHEMA = "w1-report-1"
EXACT_CHECKS = ("turnStructure", "configuration", "legibility", "spanLedger", "memoryChecksum", "numbers", "budgets")
COUNTS = ("agents", "latentSteps", "textTokens", "handOffs", "toolCalls")
SCORES = ("degenerate", "distance")
STATISTICAL = ("measured", "not-run")
AUDITS = {
    "replay": ("not-run", "match", "mismatch"),
    "mismatchedMemory": ("not-run", "changed", "unchanged"),
    "solverAlone": ("not-run", "agree", "disagree", "not-comparable"),
}
MAX_COUNT = 10 ** 6
IDENTIFIER = re.compile(r"[a-z0-9][a-z0-9._:-]{0,95}\Z")
MAC = re.compile(r"[0-9a-f]{64}\Z")


class ReportError(ValueError):
    """A report or envelope that must be refused. `reason` is one listed word."""

    def __init__(self, reason, detail=""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason


def _word(*words):
    return ("word", tuple(words))


def schema():
    """The report's shape: each leaf is "bool", "digit" (0 to 9), "count", "id" or a word list."""
    return {
        "schema": _word(SCHEMA),
        "runId": "id",
        "squadId": "id",
        "seq": "count",
        "thresholdSet": "id",
        "weightsHash": "id",
        "checks": {name: "bool" for name in EXACT_CHECKS},
        "counts": {name: "count" for name in COUNTS},
        "statistical": {name: _word(*STATISTICAL) for name in SCORES},
        "scores": {name: "digit" for name in SCORES},
        "flags": {name: "bool" for name in SCORES},
        "audits": {name: _word(*words) for name, words in AUDITS.items()},
    }


def _check(value, kind, path):
    if isinstance(kind, dict):
        if type(value) is not dict:
            raise ReportError("report-malformed", f"{path} must be an object")
        if set(value) != set(kind):
            raise ReportError("report-malformed", f"{path} has fields {sorted(value)}, expected {sorted(kind)}")
        for name, sub in kind.items():
            _check(value[name], sub, f"{path}.{name}")
        return
    if kind == "bool":
        ok = type(value) is bool
    elif kind == "digit":
        ok = type(value) is int and 0 <= value <= 9
    elif kind == "count":
        ok = type(value) is int and 0 <= value <= MAX_COUNT
    elif kind == "id":
        ok = type(value) is str and IDENTIFIER.match(value) is not None
    else:
        ok = type(value) is str and value in kind[1]
    if not ok:
        raise ReportError("report-malformed", f"{path} is not a valid {kind if isinstance(kind, str) else 'word'}")


def validate(report):
    """Raise ReportError unless `report` has exactly the schema's shape and value kinds."""
    _check(report, schema(), "report")
    return report


def canonical(value):
    """The bytes that are signed: sorted keys, no spaces, ASCII only."""
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
                          allow_nan=False).encode("ascii")
    except (TypeError, ValueError) as exc:
        raise ReportError("report-malformed", f"not plain JSON ({type(exc).__name__})") from exc


def new_run_key():
    return secrets.token_bytes(32)


def new_run_id():
    return "run-" + secrets.token_hex(12)


def _mac(key, label, payload):
    return hmac.new(key, label + b"|" + payload, hashlib.sha256).hexdigest()


def sign(report, key):
    """A signed envelope {"report", "mac"}. The report is validated first: a watchdog
    cannot sign a report the supervisor would refuse."""
    validate(report)
    return {"report": report, "mac": _mac(key, b"w1-report", canonical(report))}


def verify(envelope, key):
    """The report inside a signed envelope, or ReportError. The signature is checked before
    the schema, so a forged report is refused as unsigned whatever it holds."""
    if type(envelope) is not dict or set(envelope) - {"report", "mac"} or "report" not in envelope:
        raise ReportError("report-malformed", "an envelope is exactly {report, mac}")
    mac = envelope.get("mac")
    if type(mac) is not str or MAC.match(mac) is None:
        raise ReportError("report-unsigned", "no signature")
    expected = _mac(key, b"w1-report", canonical(envelope["report"]))
    if not hmac.compare_digest(mac, expected):
        raise ReportError("report-unsigned", "the signature does not verify")
    return validate(envelope["report"])


# ---------------------------------------------------------------- memory that leaves the process
MANIFEST = {"run": "id", "seq": "count", "sender": "id", "receiver": "id", "expires": "int", "sha256": "hex"}


def _check_manifest(manifest):
    if type(manifest) is not dict or set(manifest) != set(MANIFEST):
        raise ReportError("manifest-malformed", f"a manifest has exactly {sorted(MANIFEST)}")
    for name, kind in MANIFEST.items():
        value = manifest[name]
        if kind == "hex":
            ok = type(value) is str and MAC.match(value) is not None
        elif kind == "int":
            ok = type(value) is int and value >= 0
        else:
            _check(value, kind, f"manifest.{name}")
            ok = True
        if not ok:
            raise ReportError("manifest-malformed", f"manifest.{name}")


def seal_memory(blob, *, key, run, seq, sender, receiver, expires):
    """Sign a serialized working memory for one receiver: an HMAC over a manifest that names
    the run, sequence number, sender, receiver, expiry and the blob's SHA-256."""
    manifest = {"run": run, "seq": seq, "sender": sender, "receiver": receiver, "expires": int(expires),
                "sha256": hashlib.sha256(blob).hexdigest()}
    _check_manifest(manifest)
    return {"manifest": manifest, "mac": _mac(key, b"w1-memory", canonical(manifest))}


class MemoryReceiver:
    """The receiving end of `seal_memory`. Refuses a wrong signature, another receiver, an
    expired or altered blob, and any (run, sender, seq) it has opened before."""

    def __init__(self, key, me, clock=time.time):
        self.key, self.me, self.clock = key, me, clock
        self.seen = set()

    def open(self, envelope, blob):
        if type(envelope) is not dict or set(envelope) != {"manifest", "mac"}:
            raise ReportError("manifest-malformed", "an envelope is exactly {manifest, mac}")
        manifest, mac = envelope["manifest"], envelope["mac"]
        _check_manifest(manifest)
        if type(mac) is not str or not hmac.compare_digest(mac, _mac(self.key, b"w1-memory", canonical(manifest))):
            raise ReportError("memory-unsigned", "the signature does not verify")
        if manifest["receiver"] != self.me:
            raise ReportError("memory-wrong-receiver", manifest["receiver"])
        if self.clock() > manifest["expires"]:
            raise ReportError("memory-expired")
        if not hmac.compare_digest(hashlib.sha256(blob).hexdigest(), manifest["sha256"]):
            raise ReportError("memory-altered", "the blob does not match its manifest")
        seen = (manifest["run"], manifest["sender"], manifest["seq"])
        if seen in self.seen:
            raise ReportError("memory-replayed")
        self.seen.add(seen)
        return blob
