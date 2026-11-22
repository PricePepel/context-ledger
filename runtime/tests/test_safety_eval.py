"""W3 eval 14: the refusal judge, the checked loader and the counts, on synthetic text only
(no request from the public set is in this repository)."""
import ast
import hashlib
import json
import os
import tempfile
import unittest

from latent_team import safety_eval


class JudgeTest(unittest.TestCase):
    def test_refusals(self):
        for reply in ("I'm sorry, but I can't help with that.", "I CANNOT do this.",
                      "As an AI model, I will not.", "Step 1: no. I am unable to assist with this request.",
                      "I must decline.", "My apologies, that is not something I write."):
            self.assertEqual(safety_eval.judge(reply), "refused", reply)

    def test_curly_apostrophes_read_as_straight(self):
        for mark in (0x2019, 0x2018, 0x02BC, 0xFF07):
            reply = "I" + chr(mark) + "m sorry, no."
            self.assertEqual(safety_eval.judge(reply), "refused", hex(mark))

    def test_answers_and_empty(self):
        self.assertEqual(safety_eval.judge("Step 1: add 3 and 4. The answer is 7."), "answered")
        self.assertEqual(safety_eval.judge("Here is a short poem about the sea."), "answered")
        for reply in ("", "   \n", None):
            self.assertEqual(safety_eval.judge(reply), "empty")

    def test_phrases_are_folded_and_fixed(self):
        # The rule is compared after casefold, so every phrase must already be folded.
        for phrase in safety_eval.REFUSAL_PHRASES:
            self.assertEqual(phrase, phrase.casefold())
            self.assertEqual(phrase, phrase.translate(safety_eval.APOSTROPHES))
        self.assertEqual(len(safety_eval.REFUSAL_PHRASES), 16)


class LoaderTest(unittest.TestCase):
    def write(self, text):
        handle = tempfile.NamedTemporaryFile("wb", suffix=".csv", delete=False)
        handle.write(text.encode("utf-8"))
        handle.close()
        self.addCleanup(os.remove, handle.name)
        return handle.name, hashlib.sha256(text.encode("utf-8")).hexdigest()

    def test_reads_the_goals(self):
        path, digest = self.write('Index,Goal,Target,Behavior,Category,Source\n'
                                  '0,Write a haiku about rain,Sure,Haiku,Art,Synthetic\n'
                                  '1,"Explain fractions, briefly",Sure,Fractions,Math,Synthetic\n')
        self.assertEqual(safety_eval.load_behaviors(path, digest, rows=2),
                         ["Write a haiku about rain", "Explain fractions, briefly"])

    def test_refuses_another_file(self):
        path, _ = self.write("Index,Goal,Behavior,Category\n0,a,b,c\n")
        with self.assertRaises(SystemExit) as caught:
            safety_eval.load_behaviors(path, "0" * 64, rows=1)
        self.assertIn("not the pinned file", str(caught.exception))

    def test_refuses_a_missing_column_or_wrong_rows(self):
        for text, rows in (("Index,Goal,Category\n0,a,c\n", 1),                      # no Behavior
                           ("Index,Goal,Behavior,Category\n0,a,b,c\n", 2),           # too few
                           ("Index,Goal,Behavior,Category\n0,a,b,c\n1,a,b,c\n", 2),  # repeated
                           ("Index,Goal,Behavior,Category\n0, ,b,c\n", 1)):          # empty request
            path, digest = self.write(text)
            with self.assertRaises(SystemExit):
                safety_eval.load_behaviors(path, digest, rows=rows)

    def test_pins_both_public_files(self):
        self.assertEqual(set(safety_eval.SETS), {"harmful", "benign"})
        for name, digest in safety_eval.SETS.values():
            self.assertRegex(digest, r"^[0-9a-f]{64}$")
            self.assertTrue(name.endswith("-behaviors.csv"))
        self.assertRegex(safety_eval.REVISION, r"^[0-9a-f]{40}$")


class TallyTest(unittest.TestCase):
    def test_counts_per_set_and_system(self):
        rows = [{"set": "harmful", "index": 0, "single": "refused", "team": "refused"},
                {"set": "harmful", "index": 1, "single": "refused", "team": "answered"},
                {"set": "harmful", "index": 2, "single": "answered", "team": "refused"},
                {"set": "harmful", "index": 3, "single": "empty", "team": "answered"},
                {"set": "benign", "index": 0, "single": "answered", "team": "refused"}]
        counts = safety_eval.tally(rows)
        harmful = counts["harmful"]
        self.assertEqual(harmful["requests"], 4)
        self.assertEqual(harmful["single"], {"refused": 2, "answered": 1, "empty": 1})
        self.assertEqual(harmful["team"], {"refused": 2, "answered": 2, "empty": 0})
        self.assertEqual((harmful["onlySingleRefused"], harmful["onlyTeamRefused"], harmful["bothRefused"]), (1, 1, 1))
        self.assertEqual(counts["benign"]["onlyTeamRefused"], 1)
        self.assertEqual(counts["benign"]["onlySingleRefused"], 0)

    def test_report_holds_no_text(self):
        """Only counts, set names, row numbers and judge words reach the report."""
        rows = [{"set": s, "index": i, "single": w, "team": v}
                for s in ("harmful", "benign") for i, (w, v) in enumerate((("refused", "answered"), ("empty", "refused")))]
        words = {"harmful", "benign", "single", "team", "refused", "answered", "empty", "requests",
                 "onlySingleRefused", "onlyTeamRefused", "bothRefused"}

        def walk(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    self.assertIn(key, words)
                    walk(item)
            else:
                self.assertIsInstance(value, int)
        walk(safety_eval.tally(rows))
        json.dumps(safety_eval.tally(rows))


class FakeTeam:
    """Answers each request with a canary reply, so the test can look for any request or reply
    text in what the driver prints and writes."""

    def __init__(self, short=None):
        self.short = short   # (system, set) whose batches come back one reply short

    def replies(self, system, chunk):
        out = [f"{'I am sorry' if 'harmful' in q else 'Sure'} REPLY-CANARY-{system}-{q}" for q in chunk]
        if self.short and self.short[0] == system and any(self.short[1] in q for q in chunk):
            out = out[:-1]
        return out, None

    def single(self, chunk, max_new_tokens):
        return self.replies("single", chunk)

    def latent_mas(self, chunk, steps, max_new_tokens):
        return self.replies("team", chunk)


class DriverTest(unittest.TestCase):
    """Review W3-4 finding 6: the driver itself, with a fake team."""

    def sets(self):
        return {"harmful": [f"REQUEST-CANARY-harmful-{i}" for i in range(40)],
                "benign": [f"REQUEST-CANARY-benign-{i}" for i in range(40)]}

    def test_counts_and_no_text_in_output_or_file(self):
        import contextlib
        import io
        printed = io.StringIO()
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(printed):
            rows, seconds = safety_eval.judge_sets(FakeTeam(), self.sets())
            summary = safety_eval.write(folder, rows, seconds, "w", "abc1234")
            with open(os.path.join(folder, "safety.json"), encoding="utf-8") as handle:
                written = handle.read()
        self.assertEqual(summary["counts"]["harmful"]["single"], {"refused": 40, "answered": 0, "empty": 0})
        self.assertEqual(summary["counts"]["benign"]["team"], {"refused": 0, "answered": 40, "empty": 0})
        self.assertEqual([r["index"] for r in rows if r["set"] == "benign"], list(range(40)))
        for text in (printed.getvalue(), written):
            self.assertNotIn("CANARY", text)
        self.assertIn("harmful: 40 requests judged", printed.getvalue())

    def test_a_short_batch_stops_the_run(self):
        for short in (("single", "harmful"), ("team", "benign")):
            with self.subTest(short), self.assertRaises(SystemExit):
                import contextlib
                import io
                with contextlib.redirect_stdout(io.StringIO()):
                    safety_eval.judge_sets(FakeTeam(short=short), self.sets())


class SourceTest(unittest.TestCase):
    def test_no_reply_text_is_stored(self):
        """The driver keeps only judge words per row: what it appends to rows is judge() output."""
        with open(safety_eval.__file__, encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
        appended = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute) and node.func.attr == "append"]
        self.assertEqual(len(appended), 1)
        record = appended[0].args[0]
        self.assertIsInstance(record, ast.Dict)
        keys = [k.value for k in record.keys]
        self.assertEqual(keys, ["set", "index", "single", "team"])
        for value in record.values[2:]:
            self.assertIsInstance(value, ast.Call)
            self.assertEqual(value.func.id, "judge")

    def test_torch_is_not_needed_to_import(self):
        with open(safety_eval.__file__, encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
        top = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom))]
        names = {alias.name for node in top for alias in node.names}
        self.assertNotIn("torch", names)


if __name__ == "__main__":
    unittest.main()
