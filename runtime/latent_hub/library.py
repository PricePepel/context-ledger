"""The shipped mapper library: which files exist, for which exact model builds, and which
hand-offs they allow. Standard library only.

A manifest lists model builds, the trained parts (one encoder and one decoder per build)
and the routes that were measured. The runtime asks for a route by the builds it has
loaded. It gets the two parts to load, or a refusal that names what is missing. Nothing
here downloads anything unless `fetch` is called, and `fetch` keeps a file only when its
size and SHA-256 match the manifest.

Design and the reasons: docs/mapper-hub.md, sections 5 and 6.
"""
import hashlib
import json
import os
import re
import tempfile
import urllib.request

SCHEMA = 1
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,127}")
FILE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
DIGEST = re.compile(r"[0-9a-f]{64}")
ROLES = ("encoder", "decoder")
GATES = ("passed", "failed", "unmeasured")
KINDS = ("split", "pivot")
MAX_PART_BYTES = 1 << 30   # no part may be larger than 1 GiB
CHUNK = 1 << 20


class LibraryError(ValueError):
    """The manifest or a file is not what the library format allows."""


class NotCovered(Exception):
    """A hand-off the library does not allow. The message names the model and the reason."""

    def __init__(self, message, reason):
        super().__init__(message)
        self.message, self.reason = message, reason


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _shape(shape):
    return (isinstance(shape, (list, tuple)) and len(shape) == 3
            and all(isinstance(n, int) and not isinstance(n, bool) and n > 0 for n in shape))


def _name(label, value, pattern=NAME):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise LibraryError(f"{label} is not a valid name.")


def _digest(label, value):
    if not isinstance(value, str) or not DIGEST.fullmatch(value):
        raise LibraryError(f"{label} must be a lower-case SHA-256 digest.")


def _count(label, value, top=None):
    if not isinstance(value, int) or isinstance(value, bool) or value < 1 or (top is not None and value > top):
        raise LibraryError(f"{label} must be a positive integer" + (f" of at most {top}." if top else "."))


def _fields(label, value, required, optional=()):
    if not isinstance(value, dict):
        raise LibraryError(f"{label} must be an object.")
    missing = sorted(set(required) - set(value))
    extra = sorted(set(value) - set(required) - set(optional))
    if missing:
        raise LibraryError(f"{label} lacks {', '.join(missing)}.")
    if extra:
        raise LibraryError(f"{label} has {len(extra)} unknown field(s).")


def build_key(model, revision, weights, quantisation, kv_dtype, tokenizer, shape):
    """The identity of one model build as the mappers see it.

    model         repository id, for example "Qwen/Qwen2.5-1.5B-Instruct"
    revision      the repository commit the files came from
    weights       {file name: SHA-256} of every weights file
    quantisation  how the weights are loaded: "bf16", "awq-int4", "fp8", ...
    kv_dtype      the type of the cache the model hands over: "bf16", "fp8", ...
    tokenizer     {file name: SHA-256} of the tokenizer files (alignment depends on them)
    shape         [layers, KV heads, head dim]

    Anything that changes the cache a model writes for a text changes the key, so a
    mapper is never used on a cache it was not trained for.
    """
    for label, value in (("model", model), ("revision", revision), ("quantisation", quantisation),
                         ("kv_dtype", kv_dtype)):
        _name(label, value)
    for label, files in (("weights", weights), ("tokenizer", tokenizer)):
        if not isinstance(files, dict) or not files:
            raise LibraryError(f"{label} must list at least one file with its SHA-256.")
        for name, digest in files.items():
            _name(f"A {label} file name", name, FILE)
            _digest(f"A {label} digest", digest)
    if not _shape(shape):
        raise LibraryError("shape must be [layers, KV heads, head dim], three positive integers.")
    body = {"model": model, "revision": revision, "weights": weights, "quantisation": quantisation,
            "kvDtype": kv_dtype, "tokenizer": tokenizer, "shape": list(shape)}
    return hashlib.sha256(canonical(body).encode("ascii")).hexdigest()


class Library:
    """A validated manifest and the questions the runtime asks of it."""

    def __init__(self, manifest):
        _fields("The manifest", manifest, ("schema", "library", "version", "hub", "builds", "parts", "routes"),
                ("canary",))
        if manifest["schema"] != SCHEMA or isinstance(manifest["schema"], bool):
            raise LibraryError(f"This runtime reads library schema {SCHEMA}; the manifest is another schema.")
        _name("library", manifest["library"])
        _name("version", manifest["version"])
        hub = manifest["hub"]
        _fields("hub", hub, ("id", "kind", "slots", "dim", "alignment", "maxTokens", "document"), ("pivot",))
        _name("hub.id", hub["id"])
        _name("hub.document", hub["document"])
        if hub["kind"] not in KINDS:
            raise LibraryError(f"hub.kind must be one of: {', '.join(KINDS)}.")
        for key in ("slots", "dim", "alignment", "maxTokens"):
            _count(f"hub.{key}", hub[key])
        builds = manifest["builds"]
        if not isinstance(builds, dict) or len(builds) < 2:
            raise LibraryError("builds must hold at least two model builds.")
        for key, build in builds.items():
            _digest("A build key", key)
            _fields("A build", build, ("model", "revision", "quantisation", "kvDtype", "shape", "licence"))
            for field in ("model", "revision", "quantisation", "kvDtype"):
                _name(f"build.{field}", build[field])
            licence = build["licence"]
            if not isinstance(licence, str) or not 0 < len(licence) <= 80 or not licence.isascii() or not licence.isprintable():
                raise LibraryError("build.licence must be a short printable ASCII string.")
            if not _shape(build["shape"]):
                raise LibraryError("build.shape must be [layers, KV heads, head dim], three positive integers.")
            if build["shape"][0] < hub["slots"]:
                raise LibraryError(f"{build['model']} has fewer layers than the hub has slots.")
        pivot = hub.get("pivot")
        if (hub["kind"] == "pivot") != (pivot is not None):
            raise LibraryError("hub.pivot is the pivot's build key; a pivot hub needs it and a split hub has none.")
        if pivot is not None and pivot not in builds:
            raise LibraryError("hub.pivot is not one of the builds.")
        self._parts, files = {}, set()
        if not isinstance(manifest["parts"], list):
            raise LibraryError("parts must be a list.")
        for part in manifest["parts"]:
            _fields("A part", part, ("role", "build", "file", "sha256", "bytes", "gate", "card"))
            if part["role"] not in ROLES or part["gate"] not in GATES:
                raise LibraryError(f"A part's role is one of {', '.join(ROLES)} and its gate one of {', '.join(GATES)}.")
            if part["build"] not in builds:
                raise LibraryError("A part names a build the manifest does not list.")
            if part["build"] == pivot:
                raise LibraryError("The pivot needs no part: its own cache is the hub.")
            _name("part.file", part["file"], FILE)
            _name("part.card", part["card"])
            _digest("part.sha256", part["sha256"])
            _count("part.bytes", part["bytes"], MAX_PART_BYTES)
            if (part["role"], part["build"]) in self._parts or part["file"] in files:
                raise LibraryError("Two parts share a role and build, or a file name.")
            self._parts[(part["role"], part["build"])] = dict(part)
            files.add(part["file"])
        self._routes = {}
        if not isinstance(manifest["routes"], list):
            raise LibraryError("routes must be a list.")
        for route in manifest["routes"]:
            _fields("A route", route, ("sender", "receiver", "status", "f1", "card"))
            if route["sender"] not in builds or route["receiver"] not in builds or route["sender"] == route["receiver"]:
                raise LibraryError("A route joins two different builds of the manifest.")
            if route["status"] not in ("passed", "failed"):
                raise LibraryError("A route's status is passed or failed; an unmeasured route is left out.")
            score = route["f1"]
            if not isinstance(score, (int, float)) or isinstance(score, bool) or not 0 <= score <= 1:
                raise LibraryError("route.f1 must be from 0 to 1.")
            _name("route.card", route["card"])
            if (route["sender"], route["receiver"]) in self._routes:
                raise LibraryError("A route is listed twice.")
            self._routes[(route["sender"], route["receiver"])] = dict(route)
        canary = manifest.get("canary")
        if canary is not None:
            _fields("canary", canary, ("passage", "question", "expect"))
            if not all(isinstance(canary[key], str) and canary[key].strip() for key in canary):
                raise LibraryError("canary.passage, question and expect must be non-empty strings.")
        self.manifest = manifest
        self.hub, self.builds, self.pivot, self.canary = hub, builds, pivot, canary
        self.label = f"{manifest['library']} {manifest['version']}"

    # Questions ------------------------------------------------------------
    def models(self):
        """The model names the library covers, sorted, each once."""
        return sorted({build["model"] for build in self.builds.values()})

    def describe(self, key):
        build = self.builds[key]
        return f"{build['model']} ({build['quantisation']} weights, {build['kvDtype']} cache, build {key[:12]})"

    def _side(self, key, name, role):
        """The part for one end of a hand-off, None for the pivot, or a refusal."""
        if not isinstance(key, str) or not DIGEST.fullmatch(key):
            raise NotCovered("The model build key is not a SHA-256 digest.", "bad_request")
        # A name that is not a plain model id is never echoed back.
        shown = name if isinstance(name, str) and NAME.fullmatch(name) else "this model"
        if key not in self.builds:
            same_name = sorted(k for k, build in self.builds.items() if build["model"] == name)
            if same_name:
                raise NotCovered(
                    f"{self.label} has no mapper for this build of {shown} ({key[:12]}). It covers "
                    f"{'; '.join(self.describe(k) for k in same_name)}. A mapper only fits the exact weights, "
                    "quantisation and tokenizer it was trained with.", "other_build")
            raise NotCovered(f"{self.label} has no mapper for {shown}. It covers: {', '.join(self.models())}.",
                             "unknown_model")
        if key == self.pivot:
            return None
        part = self._parts.get((role, key))
        direction = "send from" if role == "encoder" else "hand off to"
        if part is None:
            raise NotCovered(f"{self.label} has no {role} for {self.describe(key)}, so it cannot {direction} it.",
                             f"no_{role}")
        if part["gate"] != "passed":
            why = "failed its own test" if part["gate"] == "failed" else "has not been tested"
            raise NotCovered(f"The {role} for {self.describe(key)} {why} ({part['card']}), so {self.label} "
                             f"does not {direction} it.", f"{role}_{part['gate']}")
        return part

    def route(self, sender, receiver, sender_name=None, receiver_name=None, allow_unmeasured=False):
        """What to load for a hand-off from build `sender` to build `receiver`.

        Returns {"kind", "hub", "encoder", "decoder", "measured"}. kind is "self" when both
        ends are one build the library knows: the cache is handed straight over and no part
        is loaded. Otherwise it is the hub's kind. A part is None where the pivot stands at
        that end. Raises NotCovered, with the model's name in the message, for a build the
        library does not hold, a part that is missing or did not pass, and a route that was
        measured and failed. A route nobody measured is refused unless allow_unmeasured.
        """
        if sender == receiver and sender in self.builds:
            return {"kind": "self", "hub": self.hub["id"], "encoder": None, "decoder": None, "measured": None}
        encoder = self._side(sender, sender_name, "encoder")
        decoder = self._side(receiver, receiver_name, "decoder")
        measured = self._routes.get((sender, receiver))
        pair = f"{self.builds[sender]['model']} to {self.builds[receiver]['model']}"
        if measured is None and not allow_unmeasured:
            raise NotCovered(f"{self.label} has both parts for {pair} but nobody measured that hand-off, "
                             "so it is not offered.", "route_unmeasured")
        if measured is not None and measured["status"] != "passed":
            raise NotCovered(f"{pair} was measured and failed ({measured['card']}, F1 {measured['f1']:.3f}), "
                             f"so {self.label} does not offer it.", "route_failed")
        return {"kind": self.hub["kind"], "hub": self.hub["id"], "encoder": encoder, "decoder": decoder,
                "measured": measured}

    def offered(self):
        """Every ordered pair of different builds the library hands off between."""
        pairs = []
        for sender in sorted(self.builds):
            for receiver in sorted(self.builds):
                if sender == receiver:
                    continue
                try:
                    self.route(sender, receiver)
                except NotCovered:
                    continue
                pairs.append((sender, receiver))
        return pairs

    def through(self, role, key):
        """The offered routes that use one part: what stops if that part is withdrawn."""
        if role not in ROLES:
            raise LibraryError(f"role is one of {', '.join(ROLES)}.")
        index = 0 if role == "encoder" else 1
        return [pair for pair in self.offered() if pair[index] == key]


def canary_passes(canary, answer):
    """A part is used only if a hand-off of the manifest's own passage returns its answer."""
    def fold(text):
        return " ".join(text.lower().split())
    return isinstance(answer, str) and fold(canary["expect"]) in fold(answer)


# Files --------------------------------------------------------------------
def file_digest(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(path, part):
    """Raise unless the file at `path` is the part the manifest describes. Run before every load."""
    if os.path.islink(path) or not os.path.isfile(path):
        raise LibraryError(f"{part['file']} is not in the library folder.")
    if os.path.getsize(path) != part["bytes"]:
        raise LibraryError(f"{part['file']} is not the size the manifest gives.")
    if file_digest(path) != part["sha256"]:
        raise LibraryError(f"{part['file']} does not match the manifest's SHA-256.")
    return path


def fetch(part, base_url, folder, opener=urllib.request.urlopen, timeout=60):
    """Download one part into `folder` and keep it only when size and SHA-256 match.

    The bytes go to a temporary file beside the final name and move into place after the
    check. A file already there and correct is not downloaded again. Only https addresses
    are read. The caller decides when to call this: the runtime never does on its own.
    """
    if not isinstance(base_url, str) or not base_url.startswith("https://") or any(c.isspace() for c in base_url):
        raise LibraryError("Mapper files are downloaded over https only.")
    target = os.path.join(folder, part["file"])
    if os.path.isfile(target) and not os.path.islink(target):
        try:
            return verify(target, part)
        except LibraryError:
            pass   # replaced below by a fresh download
    os.makedirs(folder, exist_ok=True)
    digest, size = hashlib.sha256(), 0
    handle, temporary = tempfile.mkstemp(dir=folder, prefix=".part-")
    try:
        with os.fdopen(handle, "wb") as out:
            with opener(base_url.rstrip("/") + "/" + part["file"], timeout=timeout) as response:
                while True:
                    chunk = response.read(CHUNK)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > part["bytes"]:
                        raise LibraryError(f"{part['file']} is larger than the manifest says; the download was stopped.")
                    digest.update(chunk)
                    out.write(chunk)
        if size != part["bytes"] or digest.hexdigest() != part["sha256"]:
            raise LibraryError(f"{part['file']} does not match the manifest's size and SHA-256; it was not kept.")
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    return target
