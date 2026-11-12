"""Cycle 9: structured output limits quotes to real lines of the requested files, and the
worker and synthesizer are asked to resolve constants to their literal values."""

import tempfile
import unittest
from unittest import mock

from latent_pool import pool
from latent_pool.pool import MAX_QUOTE_CHARS, PREAMBLE, RESOLVE_RULE, findings_schema, quotable_lines
from latent_pool.prefix import prefix_id, render_prefix
from latent_pool.server import load_config
from tests.helpers import FakeVllm, Service

FILES = {
    "src/a.js": "\ufeffexport const LIMIT = 40;\r\n}\r\n\r\n  if (items.length >  LIMIT) throw new Error('too big');\r\n",
    "src/b.js": "export const LIMIT = 40;\nMAX=5;\n",
}
PATHS = ["src/a.js", "src/b.js"]
CHOICES = [
    "export const LIMIT = 40;",
    "}",
    "if (items.length > LIMIT) throw new Error('too big');",
    "MAX=5;",
]


def quote_schema(schema):
    return schema["properties"]["findings"]["items"]["properties"]["evidence"]["items"]["properties"]["quote"]


def utf16_length(text):
    return len(text.encode("utf-16-le")) // 2


class QuotableLinesTest(unittest.TestCase):
    def test_every_non_blank_line_is_a_choice_once_with_whitespace_folded(self):
        files = [("a.js", ["  const a  =  1;  ", "", "   ", "const a = 1;", "}", "MAX=5;"]),
                 ("b.js", ["const a = 1;"])]
        self.assertEqual(quotable_lines(files), ["const a = 1;", "}", "MAX=5;"])

    def test_whitespace_folds_exactly_as_the_ledgers_javascript_does(self):
        # PR #7 review (low): str.split() also split on U+001C-U+001F and U+0085, and not on
        # U+FEFF, so the enum and the ledger disagreed on which lines are one choice.
        js_space = set(pool.JS_SPACE_CODE_POINTS)
        for code in range(0x10000):
            folded = pool.fold_space("a" + chr(code) + "b")
            self.assertEqual(folded == "a b", code in js_space, hex(code))
        files = [("a.js", ["const a = 1;", "const" + chr(0x1C) + "a = 1;", "const" + chr(0x85) + "a = 1;",
                           "const" + chr(0xFEFF) + "a" + chr(0x3000) + "= 1;", chr(0x2028) + "const a = 1;" + chr(0x2029)])]
        self.assertEqual(quotable_lines(files), ["const a = 1;", "const" + chr(0x1C) + "a = 1;", "const" + chr(0x85) + "a = 1;"])

    def test_a_long_line_is_offered_as_its_first_quote_length_in_utf16_units(self):
        long_line = "x = '" + "a" * 300 + "';"
        self.assertEqual(quotable_lines([("a.js", [long_line])]), [long_line[:MAX_QUOTE_CHARS]])
        # An astral character counts as two units, as the ledger's String.length counts it.
        emoji_line = "s = '" + "\U0001F600" * 150 + "';"
        [choice] = quotable_lines([("a.js", [emoji_line])])
        self.assertLessEqual(utf16_length(choice), MAX_QUOTE_CHARS)
        self.assertTrue(emoji_line.startswith(choice))
        self.assertEqual(utf16_length(choice), MAX_QUOTE_CHARS - 1)

    def test_no_enum_without_lines_or_beyond_either_cap(self):
        self.assertIsNone(quotable_lines([("a.js", ["", "  "])]))
        many = [f"const value{index} = {index};" for index in range(5)]
        with mock.patch.object(pool, "QUOTE_ENUM_MAX_LINES", 4):
            self.assertIsNone(quotable_lines([("a.js", many)]))
        with mock.patch.object(pool, "QUOTE_ENUM_MAX_CHARS", 40):
            self.assertIsNone(quotable_lines([("a.js", many)]))
        self.assertEqual(len(quotable_lines([("a.js", many)])), 5)

    def test_the_real_caps_admit_a_thousand_ordinary_lines_and_no_more(self):
        lines = [f"export const SETTING_{index} = {index};" for index in range(1001)]
        self.assertEqual(len(quotable_lines([("a.js", lines[:1000])])), 1000)
        self.assertIsNone(quotable_lines([("a.js", lines)]))

    def test_schema_uses_the_enum_only_when_given(self):
        self.assertEqual(quote_schema(findings_schema(PATHS, 1, 2, ["const a = 1;"])),
                         {"type": "string", "enum": ["const a = 1;"]})
        self.assertEqual(quote_schema(findings_schema(PATHS, 1, 2)),
                         {"type": "string", "minLength": 1, "maxLength": MAX_QUOTE_CHARS})


class StrictConfigTest(unittest.TestCase):
    def test_strict_citations_is_off_unless_set_to_1(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertFalse(load_config({"LATENT_ROOT": root}).strict_citations)
            self.assertFalse(load_config({"LATENT_ROOT": root, "LATENT_STRICT_CITATIONS": "0"}).strict_citations)
            self.assertTrue(load_config({"LATENT_ROOT": root, "LATENT_STRICT_CITATIONS": "1"}).strict_citations)
            with self.assertRaises(SystemExit):
                load_config({"LATENT_ROOT": root, "LATENT_STRICT_CITATIONS": "yes"})


class DefaultServiceTest(unittest.TestCase):
    """Without strict citations the requests are exactly as before cycle 9."""

    def setUp(self):
        self.fake = FakeVllm()
        self.service = Service(self.fake.url, files=FILES)

    def tearDown(self):
        self.service.close()
        self.fake.close()

    def test_no_enum_and_no_rule_by_default(self):
        status, payload = self.service.request("POST", "/latent/read", {
            "paths": PATHS, "question": "What is the limit?", "workers": 2})
        self.assertEqual(status, 200, payload)
        for body in self.fake.requests:
            self.assertNotIn(RESOLVE_RULE, body["messages"][1]["content"])
            schema = body.get("response_format", {}).get("json_schema", {}).get("schema")
            if schema and "findings" in schema["properties"]:
                self.assertNotIn("enum", quote_schema(schema))


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeVllm()
        self.service = Service(self.fake.url, files=FILES, strict_citations=True)

    def tearDown(self):
        self.service.close()
        self.fake.close()

    def calls(self, role):
        return [body for body in self.fake.requests if body["messages"][1]["content"].startswith(f"ROLE: {role}")]

    def test_workers_and_synthesizer_get_the_enum_and_the_constant_rule(self):
        status, payload = self.service.request("POST", "/latent/read", {
            "paths": PATHS, "question": "What is the limit?", "workers": 2})
        self.assertEqual(status, 200, payload)
        for role in ("worker", "synthesizer"):
            calls = self.calls(role)
            self.assertTrue(calls, role)
            for body in calls:
                self.assertEqual(quote_schema(body["response_format"]["json_schema"]["schema"])["enum"], CHOICES)
                self.assertIn(RESOLVE_RULE, body["messages"][1]["content"])
        for role in ("reader", "planner"):
            for body in self.calls(role):
                self.assertNotIn(RESOLVE_RULE, body["messages"][1]["content"])

    def test_the_rule_leaves_the_system_message_and_prefix_id_unchanged(self):
        status, payload = self.service.request("POST", "/latent/read", {
            "paths": PATHS, "question": "What is the limit?", "workers": 1})
        self.assertEqual(status, 200, payload)
        systems = {body["messages"][0]["content"] for body in self.fake.requests}
        self.assertEqual(len(systems), 1, "every call shares one cached system message")
        [system] = systems
        self.assertTrue(system.startswith(PREAMBLE + "\n\n"))
        self.assertNotIn(RESOLVE_RULE, system)
        files = [(path, text.lstrip("\ufeff").replace("\r\n", "\n").rstrip("\n").split("\n"))
                 for path, text in FILES.items()]
        self.assertEqual(payload["receipt"]["prefixId"], prefix_id(render_prefix(files)))

    def test_warm_still_works(self):
        status, payload = self.service.request("POST", "/latent/warm", {"paths": PATHS})
        self.assertEqual(status, 200, payload)
        self.assertEqual(len(payload["prefixId"]), 64)


if __name__ == "__main__":
    unittest.main()
