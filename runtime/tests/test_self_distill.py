"""C14 self-distillation (distill.py and train.py --targets) on the CPU with the tiny model of
test_latent_training. No download, no GPU."""
import json
import os
import tempfile
import unittest

from test_latent_training import HAVE_TORCH, QUESTION, SOLUTION, tiny_team, train_args

SHORT = "What is 2 + 3?"


def targets_file(directory, records, model="tiny-llama", budget=64, fmt=None):
    from latent_team.distill import FORMAT
    path = os.path.join(directory, "targets.json")
    with open(path, "w") as handle:
        json.dump({"format": fmt or FORMAT, "model": model, "maxNewTokens": budget, "records": records}, handle)
    return path


def record(question, answer, correct=True, tokens=10):
    return {"question": question, "gold": 0.0, "answer": answer, "correct": correct, "tokens": tokens}


class KeepTest(unittest.TestCase):
    def test_only_right_answers_that_stopped_inside_the_budget_are_kept(self):
        from latent_team.distill import keep
        self.assertTrue(keep(record(SHORT, "The answer is 5."), 64))
        self.assertFalse(keep(record(SHORT, "The answer is 6.", correct=False), 64))
        # At the budget the answer was cut: it never shows the model how to stop.
        self.assertFalse(keep(record(SHORT, "The answer is 5.", tokens=64), 64))
        self.assertTrue(keep(record(SHORT, "The answer is 5.", tokens=63), 64))


class LoadTargetsTest(unittest.TestCase):
    def test_a_file_from_another_model_or_format_is_refused(self):
        from latent_team.distill import load_targets
        with tempfile.TemporaryDirectory() as out:
            path = targets_file(out, [record(SHORT, "The answer is 5."), record(QUESTION, "72", correct=False)])
            self.assertEqual(load_targets(path, "tiny-llama"), {SHORT: "The answer is 5."})
            with self.assertRaisesRegex(ValueError, "not 'other'"):
                load_targets(path, "other")
            bad = targets_file(out, [], fmt="something-else")
            with self.assertRaisesRegex(ValueError, "not a distill.py targets file"):
                load_targets(bad, "tiny-llama")


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class DistillRunTest(unittest.TestCase):
    def test_the_cli_scores_greedy_single_answers_and_writes_the_file(self):
        from latent_team import distill
        from latent_team.distill import FORMAT, load_targets
        team = tiny_team()
        items = [{"question": SHORT, "solution": "#### 5", "gold": 5.0},
                 {"question": QUESTION, "solution": SOLUTION, "gold": 72.0},
                 {"question": "What is 4 * 2?", "solution": "#### 8", "gold": 8.0}]
        with tempfile.TemporaryDirectory() as out:
            path = os.path.join(out, "t.json")
            data = distill.main(["--train-count", "3", "--batch", "2", "--max-new-tokens", "6", "--device", "cpu",
                                 "--out", path], team=team, items=items, log=lambda line: None)
            with open(path) as handle:
                saved = json.load(handle)
            self.assertEqual(saved["format"], FORMAT)
            self.assertEqual((saved["model"], saved["split"], saved["items"]), ("tiny-llama", "train", 3))
            self.assertEqual([r["question"] for r in saved["records"]], [i["question"] for i in items])
            # The answers are the single system's, greedy: the same call gives the same text.
            self.assertEqual([r["answer"] for r in saved["records"]][:2], team.single([SHORT, QUESTION], 6)[0])
            # The random tiny model gets nothing right, so nothing is kept.
            self.assertEqual(data["kept"], 0)
            self.assertEqual(load_targets(path, "tiny-llama"), {})


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class SelfTargetTrainingTest(unittest.TestCase):
    def test_targets_are_the_kept_self_answers_and_the_rest_are_skipped(self):
        from latent_team.train import build_targets, target_text, train
        team = tiny_team()
        items = [{"question": SHORT, "solution": "2 + 3 = <<2+3=5>>5\n#### 5", "gold": 5.0},
                 {"question": QUESTION, "solution": SOLUTION, "gold": 72.0}]
        own = "2 plus 3 makes 5.\nThe answer is 5."
        with tempfile.TemporaryDirectory() as out:
            path = targets_file(out, [record(SHORT, "  " + own + "\n"), record(QUESTION, "72", correct=False)])
            args = train_args("--level", "lora", "--steps", "1", "--grad-accum", "1", "--lora-rank", "2",
                              "--targets", path, "--out", out)
            targets, kept, counts = build_targets(team, items, args)
            self.assertEqual(targets, [own + team.close_turn()])
            self.assertNotEqual(targets[0], target_text(items[0]["solution"], team.close_turn()))
            self.assertEqual([i["question"] for i in kept], [SHORT])
            self.assertEqual(counts, {"tooLong": 0, "longPrompts": 0, "noTarget": 1})
            record_ = train(team, items, args, log=lambda line: None)
            self.assertEqual((record_["targetSource"], record_["examples"], record_["noTarget"]), ("self", 1, 1))
            # Without --targets the same items train on the gold solutions, as in cycle 13.
            gold = train(tiny_team(), items, train_args("--level", "lora", "--steps", "1", "--grad-accum", "1",
                                                        "--lora-rank", "2", "--out", out), log=lambda line: None)
            self.assertEqual((gold["targetSource"], gold["examples"], gold["noTarget"]), ("gold", 2, 0))

    def test_targets_made_with_another_model_are_refused(self):
        from latent_team.train import build_targets
        with tempfile.TemporaryDirectory() as out:
            path = targets_file(out, [record(SHORT, "The answer is 5.")], model="microsoft/Phi-3.5-mini-instruct")
            args = train_args("--level", "lora", "--targets", path, "--out", out)
            with self.assertRaisesRegex(ValueError, "not 'tiny-llama'"):
                build_targets(tiny_team(), [{"question": SHORT, "solution": "#### 5", "gold": 5.0}], args)

    def test_no_kept_self_answer_at_all_stops_the_run(self):
        from latent_team.train import build_targets
        with tempfile.TemporaryDirectory() as out:
            path = targets_file(out, [record(SHORT, "The answer is 6.", correct=False)])
            args = train_args("--level", "lora", "--targets", path, "--out", out)
            with self.assertRaisesRegex(ValueError, "no self target"):
                build_targets(tiny_team(), [{"question": SHORT, "solution": "#### 5", "gold": 5.0}], args)


if __name__ == "__main__":
    unittest.main()
