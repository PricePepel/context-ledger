"""Path safety and byte-exact prefix rendering (docs/latent-read.md).

Every path is a relative POSIX path under LATENT_ROOT. Paths are checked in
full before any file is opened. The rendered prefix is the same bytes on every
call so vLLM's automatic prefix caching can serve it from the warm cache.
"""

import hashlib
import os
import re

from . import ApiError

MAX_PATHS = 32
MAX_TOTAL_BYTES = 512 * 1024
MAX_PATH_CHARS = 1024

_DRIVE = re.compile(r"^[A-Za-z]:")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


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
    if _CONTROL.search(path):
        raise ApiError(400, "Paths must not contain control characters.")
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
    return segments


def resolve_paths(root, paths):
    """Check every path and return [(path, real_path)] in request order.

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
        if not os.path.isfile(real):
            raise ApiError(400, f"File not found: {path!r}")
        if key in seen:
            raise ApiError(400, f"paths must not repeat (two names for one file): {path!r}")
        seen.add(key)
        resolved.append((path, real))
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
    for path, real in resolved:
        total += os.path.getsize(real)
        if total > MAX_TOTAL_BYTES:
            raise ApiError(413, f"The files exceed {MAX_TOTAL_BYTES // 1024} KiB in total.")
    files = []
    total = 0
    for path, real in resolved:
        with open(real, "rb") as handle:
            data = handle.read(MAX_TOTAL_BYTES - total + 1)
        total += len(data)
        if total > MAX_TOTAL_BYTES:  # the file grew after the size check
            raise ApiError(413, f"The files exceed {MAX_TOTAL_BYTES // 1024} KiB in total.")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise ApiError(400, f"File is not UTF-8 text: {path!r}") from None
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
