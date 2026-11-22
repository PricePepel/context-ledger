"""W2: the gateway's secret scanner decides the shared cases exactly as the ledger's does.

rules/secret-rules.json holds the rule data both languages read, and
rules/secret-conformance.json the cases this file and the node suite
(tests/secret-rules.test.mjs) both run, so a rule changed in one language only fails one
of the two suites (the H4 pattern of rules/latent-rules.json).
"""
import json
import unittest
from pathlib import Path

from latent_team import secret_scan

REPO = Path(__file__).resolve().parents[2]


def expand(parts):
    out = []
    for part in parts:
        if isinstance(part, str):
            out.append(part)
        elif "repeat" in part:
            out.append(part["repeat"] * part["times"])
        else:
            out.append(chr(part["char"]))
    return "".join(out)


with open(REPO / "rules" / "secret-conformance.json", encoding="utf-8") as handle:
    CASES = json.load(handle)["cases"]


with open(REPO / "rules" / "canonical-cases.json", encoding="utf-8") as handle:
    CANONICAL = json.load(handle)["cases"]


class CanonicalCasesTest(unittest.TestCase):
    """Review W2-9 finding 3: the gateway's canonical forms decide the shared cases exactly as
    the ledger's (tests/secret-rules.test.mjs runs the same file)."""

    def test_every_shared_canonical_case(self):
        from latent_team.gateway import canon_ranges
        self.assertGreaterEqual(len(CANONICAL), 8)
        for case in CANONICAL:
            text = expand(case["text"])
            with self.subTest(case["name"]):
                covered = sorted({text[a:b] for a, b in canon_ranges(text, [expand(v) for v in case["values"]])})
                self.assertEqual(covered, sorted(expand(c) for c in case["covered"]))


class EveryAssignmentTest(unittest.TestCase):
    """Review W2-12 finding 1: every assignment on a line has its value, the spans unchanged."""

    def test_a_second_bare_assignment_has_its_value(self):
        text = "password=synthetic-first, api_key=" + "synthetic-second"
        [finding] = secret_scan.find_secrets(text, values=True)
        self.assertIn("synthetic-second", finding["values"])
        self.assertIn("synthetic-first", finding["values"])
        self.assertEqual([(f["start"], f["end"]) for f in secret_scan.find_secrets(text)],
                         [(finding["start"], finding["end"])])

    def test_shell_syntax_ends_a_values_head(self):
        # Review W2-19.
        for text in ("password=paper-harbor; export aws_secret_access_key=" + "A" * 40,
                     "password=paper-harbor && api_key=" + "synthetic-second"):
            [finding] = secret_scan.find_secrets(text, values=True)
            self.assertIn("paper-harbor", finding["values"], text)

    def test_a_structured_assignment_after_a_bare_value_cuts_it(self):
        # Review W2-18.
        [finding] = secret_scan.find_secrets("password=paper-harbor, aws_secret_access_key=" + "A" * 40, values=True)
        self.assertIn("paper-harbor", finding["values"])

    def test_what_the_quotes_hold_is_a_value_when_a_full_stop_follows(self):
        # Review W2-14 finding 2.
        [finding] = secret_scan.find_secrets('password="paper-harbor".', values=True)
        self.assertIn("paper-harbor", finding["values"])

    def test_mixed_leads_on_one_line_each_have_their_value(self):
        # Review W2-13 finding 2: an assignment, then a bearer header, and the reverse.
        for text, first in (("password=synthetic-first, Authorization: Bearer synthetic-second", "synthetic-first"),
                            ("Authorization: Bearer synthetic-first, api_key=synthetic-second", "synthetic-first")):
            [finding] = secret_scan.find_secrets(text, values=True)
            self.assertIn(first, finding["values"], text)
            self.assertIn("synthetic-second", finding["values"], text)

    def test_many_assignments_on_one_long_line_stay_linear(self):
        # Review W2-13 finding 4: values are bounded pieces, not one suffix per assignment.
        import time
        line = "".join(f"password=v{i}x, " for i in range(5000)) + " " * 100000
        started = time.perf_counter()
        [finding] = secret_scan.find_secrets(line, values=True)
        self.assertGreater(len(finding["values"]), 4000)
        self.assertLess(sum(len(v) for v in finding["values"]), 3 * len(line))
        self.assertLess(time.perf_counter() - started, 10)


class SecretConformanceTest(unittest.TestCase):
    def test_every_shared_case(self):
        self.assertGreaterEqual(len(CASES), 40)
        for case in CASES:
            text = expand(case["text"])
            with self.subTest(case["name"]):
                self.assertEqual(secret_scan.find_secrets(text), case["spans"])

    def test_redaction_hides_every_found_value(self):
        for case in CASES:
            text = expand(case["text"])
            redacted = secret_scan.redact_text(text)
            for span in case["spans"]:
                value = text[span["start"]:span["end"]]
                if len(value) >= 8:
                    self.assertNotIn(value, redacted, case["name"])

    def test_the_rule_file_is_the_one_both_sides_read(self):
        self.assertEqual(secret_scan.RULES_PATH, REPO / "rules" / "secret-rules.json")
        kinds = {rule["kind"] for rule in secret_scan.RULES["simple"]["rules"]}
        self.assertTrue({"anthropic-key", "github-token", "aws-access-key-id", "openai-key"} <= kinds)

    def test_long_runs_are_scanned_quickly(self):
        import time
        started = time.perf_counter()
        secret_scan.find_secrets("password=" + "a" * 50000 + "\n" + " " * 50000 + "sk-" + "-" * 50000)
        self.assertLess(time.perf_counter() - started, 5.0)


if __name__ == "__main__":
    unittest.main()
