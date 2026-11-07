import hashlib
import os
import tempfile
import unittest

from latent_pool import ApiError
from latent_pool.prefix import (
    MAX_PATHS,
    MAX_TOTAL_BYTES,
    check_path_syntax,
    load_files,
    prefix_id,
    render_prefix,
    resolve_paths,
    split_lines,
)
from tests.helpers import write


class PathSyntaxTest(unittest.TestCase):
    def assert_rejected(self, path):
        with self.assertRaises(ApiError) as caught:
            check_path_syntax(path)
        self.assertEqual(caught.exception.status, 400, path)

    def test_rejects_unsafe_spellings(self):
        for path in [
            "", "/etc/passwd", "../secret", "src/../../x", "src/..", "..",
            "src\\app.js", "C:/Windows/win.ini", "c:secret", "src/a.js:stream",
            "src//a.js", "src/", "./src/a.js", "src/./a.js", "src/\x00a.js", "src/a\n.js",
            "src/a.js.", "src/a.js ", " src/a.js", "src./a.js", " ", "//server/share/x",
            None, 3, ["a"],
        ]:
            self.assert_rejected(path)

    def test_accepts_plain_relative_paths(self):
        self.assertEqual(check_path_syntax("src/app.js"), ["src", "app.js"])
        self.assertEqual(check_path_syntax("a..b/c...js"), ["a..b", "c...js"])
        self.assertEqual(check_path_syntax("dír/файл.js"), ["dír", "файл.js"])


class ResolveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "root")
        os.makedirs(self.root)
        write(self.root, "src/a.js", "one\ntwo\n")
        write(self.tmp.name, "outside.txt", "secret\n")

    def tearDown(self):
        self.tmp.cleanup()

    def status(self, paths):
        with self.assertRaises(ApiError) as caught:
            load_files(self.root, paths)
        return caught.exception.status

    def test_limits(self):
        self.assertEqual(self.status([f"f{index}.js" for index in range(MAX_PATHS + 1)]), 413)
        self.assertEqual(self.status([]), 400)
        self.assertEqual(self.status("src/a.js"), 400)
        write(self.root, "big1.txt", "x" * (MAX_TOTAL_BYTES // 2))
        write(self.root, "big2.txt", "y" * (MAX_TOTAL_BYTES // 2 + 1))
        self.assertEqual(self.status(["big1.txt", "big2.txt"]), 413)
        self.assertEqual(len(load_files(self.root, ["big1.txt"])), 1)

    def test_duplicates_missing_and_directories(self):
        self.assertEqual(self.status(["src/a.js", "src/a.js"]), 400)
        self.assertEqual(self.status(["src/missing.js"]), 400)
        self.assertEqual(self.status(["src"]), 400)

    def test_syntax_is_checked_before_any_lookup(self):
        # one bad path refuses the whole request, even after a good one
        self.assertEqual(self.status(["src/a.js", "../outside.txt"]), 400)

    def test_symlink_escape_is_refused(self):
        link = os.path.join(self.root, "escape.txt")
        dir_link = os.path.join(self.root, "up")
        try:
            os.symlink(os.path.join(self.tmp.name, "outside.txt"), link)
            os.symlink(self.tmp.name, dir_link, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("this OS user cannot create symlinks")
        self.assertEqual(self.status(["escape.txt"]), 400)
        self.assertEqual(self.status(["up/outside.txt"]), 400)

    def test_symlink_inside_root_counts_as_the_same_file(self):
        try:
            os.symlink(os.path.join(self.root, "src", "a.js"), os.path.join(self.root, "alias.js"))
        except (OSError, NotImplementedError):
            self.skipTest("this OS user cannot create symlinks")
        self.assertEqual(len(load_files(self.root, ["alias.js"])), 1)
        self.assertEqual(self.status(["src/a.js", "alias.js"]), 400)

    def test_non_utf8_is_refused(self):
        write(self.root, "latin1.txt", "caf\xe9\n".encode("latin-1"))
        self.assertEqual(self.status(["latin1.txt"]), 400)

    def test_resolve_returns_request_order(self):
        write(self.root, "b.js", "b\n")
        resolved = resolve_paths(self.root, ["b.js", "src/a.js"])
        self.assertEqual([path for path, _ in resolved], ["b.js", "src/a.js"])


class RenderTest(unittest.TestCase):
    def test_split_lines(self):
        self.assertEqual(split_lines(""), [])
        self.assertEqual(split_lines("\n"), [""])
        self.assertEqual(split_lines("a"), ["a"])
        self.assertEqual(split_lines("a\n"), ["a"])
        self.assertEqual(split_lines("a\r\nb\r\n"), ["a", "b"])
        self.assertEqual(split_lines("a\n\nb"), ["a", "", "b"])
        # only LF splits: form feeds and Unicode separators stay inside a line
        self.assertEqual(split_lines("a\x0cb\u2028c\n"), ["a\x0cb\u2028c"])

    def test_render_matches_the_contract_bytes(self):
        prefix = render_prefix([("src/app.js", ["import x from 'y';", "..."]), ("src/empty.js", [])])
        self.assertEqual(
            prefix,
            "=== FILE: src/app.js ===\n1| import x from 'y';\n2| ...\n=== FILE: src/empty.js ===\n",
        )
        self.assertEqual(prefix_id(prefix), hashlib.sha256(prefix.encode("utf-8")).hexdigest())

    def test_crlf_and_lf_files_render_identically(self):
        with tempfile.TemporaryDirectory() as root:
            write(root, "lf.js", "a\nb\n")
            write(root, "crlf.js", "a\r\nb\r\n")
            lf = load_files(root, ["lf.js"])[0][1]
            crlf = load_files(root, ["crlf.js"])[0][1]
        self.assertEqual(lf, crlf)


if __name__ == "__main__":
    unittest.main()
