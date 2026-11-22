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
