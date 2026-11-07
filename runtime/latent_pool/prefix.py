"""Path safety and byte-exact prefix rendering (docs/latent-read.md).

Every path is a relative POSIX path under LATENT_ROOT. Paths are checked in
full before any file is opened. The rendered prefix is the same bytes on every
call so vLLM's automatic prefix caching can serve it from the warm cache.
"""

import hashlib
import os
import re
import unicodedata

from . import ApiError

MAX_PATHS = 32
MAX_TOTAL_BYTES = 512 * 1024
MAX_PATH_CHARS = 512  # the ledger's limit; both sides must agree
BOM = "\ufeff"

_DRIVE = re.compile(r"^[A-Za-z]:")
# Unicode categories refused in paths: the ledger's \p{C} (Cc, Cf, Cs, Co, Cn)
# plus line and paragraph separators (Zl, Zp). U+2028, U+0085 or U+202E in a
# file name could otherwise fake a "=== FILE:" header or line numbers.
# "Cn" (unassigned) is left out on purpose: Python's Unicode tables are older than
# Node's, so a newly assigned character would pass the ledger and then fail here
# with 400, a hard 502 instead of the text fallback (Ali's review of 72ce5cb, low 1).
# Cc, Cf, Zl and Zp already block fake headers.
_BAD_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Zl", "Zp"})

# Files that commonly hold secrets. Their text would be quoted into a slice that
# leaves the machine for a closed model, so they are refused even under the root.
# The ledger (src/latent.mjs) mirrors this rule so it refuses them up front.
_SECRET_DIRS = frozenset({".git", ".ssh", ".aws", ".gnupg", ".docker", ".kube"})
_SECRET_NAMES = frozenset({".npmrc", ".pypirc", ".netrc", ".pgpass", ".git-credentials", "credentials",
                           "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"})
_SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".keystore", ".jks")
# Templates meant to be committed are not secrets.
_ENV_TEMPLATES = frozenset({".env.example", ".env.sample", ".env.template"})


def is_secret_path(segments):
    """True when a path names a typical secret file (.env*, .git/, keys)."""
    for segment in segments[:-1]:
        if segment.lower() in _SECRET_DIRS:
            return True
    name = segments[-1].lower()
    if name in _ENV_TEMPLATES:
        return False
    return (name.startswith(".env") or name in _SECRET_NAMES or name.startswith("id_rsa")
            or name.startswith("id_ed25519") or name.endswith(_SECRET_SUFFIXES))


def _has_bad_character(text):
    return any(unicodedata.category(character) in _BAD_CATEGORIES for character in text)


def check_path_syntax(path):
    """Return the path's segments, or raise ApiError(400) if it is unsafe.

    Rejects absolute paths, drive letters, backslashes, colons (NTFS alternate
    data streams), control characters, empty, "." or ".." segments, and
    segments with a leading space or a trailing dot or space (Windows strips
    those). The spelling is then canonical, so duplicates are string matches;
    resolve_paths also catches two spellings of one real file.
    """
    if not isinstance(path, str) or not path:
        raise ApiError(400, "Each path must be a non-empty string.")
    if len(path) > MAX_PATH_CHARS:
        raise ApiError(400, "A path is too long.")
    if _has_bad_character(path):
        raise ApiError(400, "Paths must not contain control, format or line separator characters.")
    if "\\" in path:
        raise ApiError(400, f"Paths must use forward slashes: {path!r}")
    if path.startswith("/"):
        raise ApiError(400, f"Paths must be relative: {path!r}")
    if _DRIVE.match(path) or ":" in path:
        raise ApiError(400, f"Paths must not contain a drive letter or colon: {path!r}")
    segments = path.split("/")
    for segment in segments:
        if segment in ("", ".", ".."):
            raise ApiError(400, f"Paths must not contain empty, '.' or '..' segments: {path!r}")
        if segment[-1] in ". " or segment[0] == " ":
            # Windows drops trailing dots and spaces, so "a.js." would read a.js
            raise ApiError(400, f"Path segments must not start with a space or end with a dot or space: {path!r}")
    if is_secret_path(segments):
        raise ApiError(400, f"Paths must not name secret files (.env, .git, keys): {path!r}")
    return segments


def resolve_paths(root, paths):
    """Check every path and return [(path, real_path, (dev, ino) or None)] in request order.

    Raises ApiError(413) for too many paths and ApiError(400) for anything
    unsafe, missing or duplicated. Nothing is read here.
    """
    if not isinstance(paths, list):
        raise ApiError(400, "paths must be an array of strings.")
    if not paths:
        raise ApiError(400, "paths must name at least one file.")
    if len(paths) > MAX_PATHS:
        raise ApiError(413, f"At most {MAX_PATHS} paths are allowed.")
    segments_list = [check_path_syntax(path) for path in paths]
    if len(set(paths)) != len(paths):
        raise ApiError(400, "paths must not repeat.")

    root_real = os.path.realpath(root)
    root_key = os.path.normcase(root_real)
    resolved = []
    seen = set()
    for path, segments in zip(paths, segments_list):
        real = os.path.realpath(os.path.join(root_real, *segments))
        key = os.path.normcase(real)
        try:
            inside = os.path.commonpath([root_key, key]) == root_key and key != root_key
        except ValueError:  # different drives on Windows
            inside = False
        if not inside:
            raise ApiError(400, f"Path leaves LATENT_ROOT: {path!r}")
        # A symlink with an innocent name can still point at .env or a key file.
        try:
            relative = os.path.relpath(real, root_real)
        except ValueError:  # Windows device names (NUL, CON) resolve to another "mount"
            raise ApiError(400, f"Path leaves LATENT_ROOT: {path!r}") from None
        if is_secret_path(relative.replace(os.sep, "/").split("/")):
            raise ApiError(400, f"Paths must not name secret files (.env, .git, keys): {path!r}")
        if not os.path.isfile(real):
            raise ApiError(400, f"File not found: {path!r}")
        # Case-insensitive mounts (/mnt/c under WSL) give one file several spellings
        # that realpath and normcase do not fold, so compare file identity too.
        info = os.stat(real)
        identity = (info.st_dev, info.st_ino) if info.st_ino else None
        if key in seen or (identity and identity in seen):
            raise ApiError(400, f"paths must not repeat (two names for one file): {path!r}")
        seen.add(key)
        if identity:
            seen.add(identity)
        resolved.append((path, real, identity))
    return resolved


def split_lines(text):
    """Split file text into lines: CRLF becomes LF, a final newline ends the last line.

    Only "\\n" separates lines (str.splitlines would also split on form feeds
    and Unicode separators, which other readers of the same file would not).
    """
    text = text.replace("\r\n", "\n")
    if not text:
        return []
    if text.endswith("\n"):
        text = text[:-1]
    return text.split("\n")


def load_files(root, paths):
    """Resolve, size-check and read the files. Returns [(path, lines)]."""
    resolved = resolve_paths(root, paths)
    total = 0
    for path, real, _ in resolved:
        total += os.path.getsize(real)
        if total > MAX_TOTAL_BYTES:
            raise ApiError(413, f"The files exceed {MAX_TOTAL_BYTES // 1024} KiB in total.")
    files = []
    total = 0
    for path, real, identity in resolved:
        try:
            with open(real, "rb") as handle:
                # The file checked above must be the file opened: if a component was
                # swapped for a symlink in between, its identity changes.
                info = os.fstat(handle.fileno())
                if identity and (info.st_dev, info.st_ino) != identity:
                    raise ApiError(400, f"File changed while it was being read: {path!r}")
                data = handle.read(MAX_TOTAL_BYTES - total + 1)
        except OSError:  # unreadable (permissions) or removed since the check
            raise ApiError(400, f"File cannot be read: {path!r}") from None
        total += len(data)
        if total > MAX_TOTAL_BYTES:  # the file grew after the size check
            raise ApiError(413, f"The files exceed {MAX_TOTAL_BYTES // 1024} KiB in total.")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise ApiError(400, f"File is not UTF-8 text: {path!r}") from None
        # The ledger's TextDecoder drops a leading BOM, so drop it here too, or the
        # two sides would disagree about line 1.
        if text.startswith(BOM):
            text = text[1:]
        files.append((path, split_lines(text)))
    return files


def render_prefix(files):
    """Render [(path, lines)] exactly as the contract shows.

    === FILE: src/app.js ===
    1| import x from 'y';
    """
    parts = []
    for path, lines in files:
        parts.append(f"=== FILE: {path} ===\n")
        for number, line in enumerate(lines, 1):
            parts.append(f"{number}| {line}\n")
    return "".join(parts)


def prefix_id(prefix):
    return hashlib.sha256(prefix.encode("utf-8")).hexdigest()
