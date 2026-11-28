"""The shipped mapper library: which files exist, for which exact model builds, and which
hand-offs they allow. Standard library only.

A manifest lists model builds, the trained parts and the routes that were measured. The
runtime asks for a route by the builds it has loaded. It gets the parts to load, or a
refusal that names what is missing. Nothing here downloads anything unless `fetch` is
called, and a part's bytes are only ever handed on after their size and SHA-256 matched.

What a part is depends on the hub's kind:
  split   an encoder or a decoder of one model (latent_hub.hub.split)
  pivot   a whole direct mapper: role "encoder" is the mapper from that build into the
          pivot's cache, role "decoder" the mapper from the pivot's cache to that build

Design and the reasons: docs/mapper-hub.md, sections 5 and 6.
"""
import copy
import hashlib
import json
import os
import re
import stat
import tempfile
import urllib.error
import urllib.parse
import urllib.request

SCHEMA = 1
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,127}")
FILE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
DIGEST = re.compile(r"[0-9a-f]{64}")
ROLES = ("encoder", "decoder")
GATES = ("passed", "failed", "unmeasured")
KINDS = ("split", "pivot")
ALIGNMENTS = (1, 2)        # latent_transfer.align: RULE_RAW and RULE_REFINED
MAX_PART_BYTES = 1 << 30   # no part may be larger than 1 GiB
CHUNK = 1 << 20
BUILD_FIELDS = ("model", "revision", "weights", "quantisation", "kvDtype", "tokenizer", "shape")


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
            and all(type(n) is int and n > 0 for n in shape))


def _name(label, value, pattern=NAME):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise LibraryError(f"{label} is not a valid name.")


def _digest(label, value):
    if not isinstance(value, str) or not DIGEST.fullmatch(value):
        raise LibraryError(f"{label} must be a lower-case SHA-256 digest.")


def _count(label, value, top=None):
    if type(value) is not int or value < 1 or (top is not None and value > top):
        raise LibraryError(f"{label} must be a positive integer" + (f" of at most {top}." if top else "."))


def _fields(label, value, required, optional=()):
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise LibraryError(f"{label} must be an object.")
    missing = sorted(set(required) - set(value))
    extra = set(value) - set(required) - set(optional)
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
                         ("kvDtype", kv_dtype)):
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


def check_part(part):
    """Raise unless `part` is a well-formed part record. Every file function checks first."""
    _fields("A part", part, ("role", "build", "file", "sha256", "bytes", "gate", "card"))
    if part["role"] not in ROLES or part["gate"] not in GATES:
        raise LibraryError(f"A part's role is one of {', '.join(ROLES)} and its gate one of {', '.join(GATES)}.")
    _digest("part.build", part["build"])
    _name("part.file", part["file"], FILE)
    _name("part.card", part["card"])
    _digest("part.sha256", part["sha256"])
    _count("part.bytes", part["bytes"], MAX_PART_BYTES)
    return part


class Library:
    """A validated manifest and the questions the runtime asks of it.

    The library keeps its own copy of the manifest and hands out copies, so nothing a
    caller does to a manifest or a route afterwards changes what the library allows.
    """

    def __init__(self, manifest):
        _fields("The manifest", manifest, ("schema", "library", "version", "hub", "builds", "parts", "routes", "canary"))
        manifest = copy.deepcopy(manifest)
        if type(manifest["schema"]) is not int or manifest["schema"] != SCHEMA:
            raise LibraryError(f"This runtime reads library schema {SCHEMA}; the manifest is another schema.")
        _name("library", manifest["library"])
        _name("version", manifest["version"])
        hub = manifest["hub"]
        _fields("hub", hub, ("id", "kind", "slots", "dim", "alignment", "maxTokens", "document"), ("pivot",))
        _name("hub.id", hub["id"])
        _name("hub.document", hub["document"])
        if hub["kind"] not in KINDS:
            raise LibraryError(f"hub.kind must be one of: {', '.join(KINDS)}.")
        for key in ("slots", "dim", "maxTokens"):
            _count(f"hub.{key}", hub[key])
        if type(hub["alignment"]) is not int or hub["alignment"] not in ALIGNMENTS:
            raise LibraryError("hub.alignment must be an alignment rule this runtime has: 1 or 2.")
        builds = manifest["builds"]
        if not isinstance(builds, dict) or len(builds) < 2:
            raise LibraryError("builds must hold at least two model builds.")
        for key, build in builds.items():
            _digest("A build key", key)
            _fields("A build", build, BUILD_FIELDS + ("licence",))
            licence = build["licence"]
            if not isinstance(licence, str) or not 0 < len(licence) <= 80 or not licence.isascii() or not licence.isprintable():
                raise LibraryError("build.licence must be a short printable ASCII string.")
            computed = build_key(build["model"], build["revision"], build["weights"], build["quantisation"],
                                 build["kvDtype"], build["tokenizer"], build["shape"])
            if computed != key:
                raise LibraryError(f"The key of {build['model']} is not the digest of its files and settings.")
            if build["shape"][0] < hub["slots"]:
                raise LibraryError(f"{build['model']} has fewer layers than the hub has slots.")
        pivot = hub.get("pivot")
        if (hub["kind"] == "pivot") != ("pivot" in hub):
            raise LibraryError("hub.pivot is the pivot's build key; a pivot hub needs it and a split hub has none.")
        if "pivot" in hub:
            _digest("hub.pivot", pivot)
            if pivot not in builds:
                raise LibraryError("hub.pivot is not one of the builds.")
        self._parts, files = {}, set()
        if not isinstance(manifest["parts"], list):
            raise LibraryError("parts must be a list.")
        for part in manifest["parts"]:
            check_part(part)
            if part["build"] not in builds:
                raise LibraryError("A part names a build the manifest does not list.")
            if part["build"] == pivot:
                raise LibraryError("The pivot needs no part: its own cache is the hub.")
            # File names are compared without case: Windows and macOS folders fold it.
            if (part["role"], part["build"]) in self._parts or part["file"].lower() in files:
                raise LibraryError("Two parts share a role and build, or a file name.")
            self._parts[(part["role"], part["build"])] = part
            files.add(part["file"].lower())
        self._routes = {}
        if not isinstance(manifest["routes"], list):
            raise LibraryError("routes must be a list.")
        for route in manifest["routes"]:
            _fields("A route", route, ("sender", "receiver", "status", "f1", "card"))
            _digest("route.sender", route["sender"])
            _digest("route.receiver", route["receiver"])
            if route["sender"] not in builds or route["receiver"] not in builds or route["sender"] == route["receiver"]:
                raise LibraryError("A route joins two different builds of the manifest.")
            if route["status"] not in ("passed", "failed"):
                raise LibraryError("A route's status is passed or failed; an unmeasured route is left out.")
            score = route["f1"]
            if type(score) not in (int, float) or not 0 <= score <= 1:
                raise LibraryError("route.f1 must be from 0 to 1.")
            _name("route.card", route["card"])
            if (route["sender"], route["receiver"]) in self._routes:
                raise LibraryError("A route is listed twice.")
            self._routes[(route["sender"], route["receiver"])] = route
        canary = manifest["canary"]
        _fields("canary", canary, ("passage", "question", "expect"))
        if not all(isinstance(canary[key], str) and canary[key].strip() for key in canary):
            raise LibraryError("canary.passage, question and expect must be non-empty strings.")
        self._hub, self._builds, self._canary = hub, builds, canary
        self.pivot = pivot
        self.label = f"{manifest['library']} {manifest['version']}"

    # What the library holds, as copies --------------------------------------
    @property
    def hub(self):
        return dict(self._hub)

    @property
    def builds(self):
        return copy.deepcopy(self._builds)

    @property
    def canary(self):
        return dict(self._canary)

    def models(self):
        """The model names the library covers, sorted, each once."""
        return sorted({build["model"] for build in self._builds.values()})

    def describe(self, key):
        build = self._builds[key]
        return f"{build['model']} ({build['quantisation']} weights, {build['kvDtype']} cache, build {key[:12]})"

    # Routes -------------------------------------------------------------------
    def _side(self, key, name, role):
        """The part for one end of a hand-off, None for the pivot, or a refusal."""
        if not isinstance(key, str) or not DIGEST.fullmatch(key):
            raise NotCovered("The model build key is not a SHA-256 digest.", "bad_request")
        # A name that is not a plain model id is never echoed back.
        shown = name if isinstance(name, str) and NAME.fullmatch(name) else "this model"
        if key not in self._builds:
            same_name = sorted(k for k, build in self._builds.items() if build["model"] == name)
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
        return dict(part)

    def route(self, sender, receiver, sender_name=None, receiver_name=None, allow_unmeasured=False):
        """What to load for a hand-off from build `sender` to build `receiver`.

        Returns {"kind", "hub", "encoder", "decoder", "measured"}. kind is "self" when both
        ends are one build the library knows: the cache is handed straight over and no part
        is loaded. Otherwise it is the hub's kind. A part is None where the pivot stands at
        that end. Raises NotCovered, with the model's name in the message, for a build the
        library does not hold, a part that is missing or did not pass, and a route that was
        measured and failed. A route nobody measured is refused unless allow_unmeasured.
        Every ordered pair is its own route, also in a pivot hub: a pair with the pivot at
        one end is one direct mapper, and its route entry is that mapper's own result.
        """
        if isinstance(sender, str) and sender == receiver and sender in self._builds:
            return {"kind": "self", "hub": self._hub["id"], "encoder": None, "decoder": None, "measured": None}
        encoder = self._side(sender, sender_name, "encoder")
        decoder = self._side(receiver, receiver_name, "decoder")
        measured = self._routes.get((sender, receiver))
        pair = f"{self._builds[sender]['model']} to {self._builds[receiver]['model']}"
        if measured is None and not allow_unmeasured:
            raise NotCovered(f"{self.label} has both parts for {pair} but nobody measured that hand-off, "
                             "so it is not offered.", "route_unmeasured")
        if measured is not None and measured["status"] != "passed":
            raise NotCovered(f"{pair} was measured and failed ({measured['card']}, F1 {measured['f1']:.3f}), "
                             f"so {self.label} does not offer it.", "route_failed")
        return {"kind": self._hub["kind"], "hub": self._hub["id"], "encoder": encoder, "decoder": decoder,
                "measured": dict(measured) if measured else None}

    def offered(self):
        """Every ordered pair of different builds the library hands off between."""
        pairs = []
        for sender in sorted(self._builds):
            for receiver in sorted(self._builds):
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
        if not isinstance(key, str) or (role, key) not in self._parts:
            raise LibraryError(f"The library has no such {role}.")
        index = 0 if role == "encoder" else 1
        return [pair for pair in self.offered() if pair[index] == key]


def canary_passes(canary, answer):
    """Whether a hand-off of the manifest's own passage returned its answer. A route whose
    canary fails is not served; the canary does not say which of its two parts is at fault."""
    def fold(text):
        return " ".join(text.lower().split())
    return isinstance(answer, str) and fold(canary["expect"]) in fold(answer)


# Files --------------------------------------------------------------------
def local_name(part):
    """The name a part is stored under: its SHA-256. Two parts never share it, no manifest
    text reaches the file system, and a concurrent download of another part cannot replace it."""
    check_part(part)
    return part["sha256"] + ".part"


def read_verified(folder, part):
    """The bytes of a stored part, after checking them against the manifest.

    The file is opened once and the bytes that are checked are the bytes returned, so a
    file swapped on disk after the check cannot reach the loader. Load from these bytes,
    never from the path.
    """
    path = os.path.join(folder, local_name(part))
    try:
        handle = open(path, "rb")
    except OSError:
        raise LibraryError(f"{part['file']} is not in the library folder.") from None
    with handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise LibraryError(f"{part['file']} is not a regular file.")
        if info.st_size != part["bytes"]:
            raise LibraryError(f"{part['file']} is not the size the manifest gives.")
        data = handle.read(part["bytes"] + 1)
    if len(data) != part["bytes"] or hashlib.sha256(data).hexdigest() != part["sha256"]:
        raise LibraryError(f"{part['file']} does not match the manifest's size and SHA-256.")
    return data


class HttpsOnly(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only to another https address."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise urllib.error.HTTPError(req.full_url, code, "Redirect away from https refused.", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def https_open(url, timeout):
    return urllib.request.build_opener(HttpsOnly).open(url, timeout=timeout)


def part_url(base_url, part):
    """The address of a part under an https base, or a refusal."""
    check_part(part)
    if not isinstance(base_url, str) or any(c.isspace() or not c.isprintable() for c in base_url):
        raise LibraryError("Mapper files are downloaded over https only.")
    split = urllib.parse.urlsplit(base_url)
    if split.scheme != "https" or not split.hostname or split.query or split.fragment or split.username or split.password:
        raise LibraryError("Mapper files are downloaded over https only, from an address without a query, "
                           "fragment or credentials.")
    return urllib.parse.urlunsplit(("https", split.netloc, split.path.rstrip("/") + "/" + part["file"], "", ""))


def fetch(part, base_url, folder, opener=https_open, timeout=60):
    """Download one part into `folder` and keep it only when size and SHA-256 match.

    The bytes go to a temporary file and move into place, under the part's SHA-256, after
    the check. A part already there and correct is not downloaded again. Only https is
    read, and a redirect to anything else is refused. The caller decides when to call
    this: the runtime never does on its own. Returns the verified bytes' path; load with
    read_verified.
    """
    url = part_url(base_url, part)
    target = os.path.join(folder, local_name(part))
    try:
        read_verified(folder, part)
        return target
    except LibraryError:
        pass   # absent or damaged: fetched below
    os.makedirs(folder, exist_ok=True)
    digest, size = hashlib.sha256(), 0
    handle, temporary = tempfile.mkstemp(dir=folder, prefix=".fetch-")
    try:
        with os.fdopen(handle, "wb") as out:
            with opener(url, timeout=timeout) as response:
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
