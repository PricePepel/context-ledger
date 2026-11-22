"""W3: calibrated abstention. The calibration math and the confidence score need no torch
(synthetic scores only); the guarded paths run a tiny random Qwen2 on the CPU where torch is
installed, and skip without it."""
import json
import math
import os
import random
import re
import tempfile
import unittest

from latent_team import abstain

BS = chr(92)


class BoundTest(unittest.TestCase):
    def test_clopper_pearson_upper_bound(self):
        self.assertEqual(abstain.upper_bound(0, 0), 1.0)
        self.assertAlmostEqual(abstain.upper_bound(0, 100), 1 - 0.05 ** (1 / 100), places=6)
        # Known value: 5 errors in 100, one-sided 95%: about 0.1024.
        self.assertAlmostEqual(abstain.upper_bound(5, 100), 0.1024, places=3)
        self.assertGreater(abstain.upper_bound(10, 100), 0.10)
        self.assertEqual(abstain.upper_bound(7, 7), 1.0)

    def test_wilson_interval(self):
        low, high = abstain.wilson(10, 100)
        self.assertAlmostEqual(low, 0.0552, places=3)
        self.assertAlmostEqual(high, 0.1744, places=3)


class ThresholdTest(unittest.TestCase):
    def test_a_separable_score_releases_the_confident_part(self):
        scores = list(range(100))
        wrong = [s < 20 for s in scores]           # the 20 least confident are wrong
        threshold, steps, chosen = abstain.choose_threshold(scores, scores, wrong, target=0.10)
        result = abstain.score_threshold(scores, wrong, threshold)
        self.assertEqual((threshold, result["released"], result["errors"], result["passed"]), (20, 80, 0, True))
        self.assertEqual(chosen["threshold"], 20)
        self.assertEqual([s["released"] for s in steps][:3], [5, 10, 15], "a grid of release fractions")

    def test_the_candidates_come_from_the_proposal_set_alone(self):
        # Review W3-1 finding 1: a candidate is fixed before the certification rows are seen,
        # so changing the certification scores changes which pass, never which are tested.
        proposal = [i / 10 for i in range(100)]
        _, first, _ = abstain.choose_threshold(proposal, list(range(50)), [False] * 50)
        _, second, _ = abstain.choose_threshold(proposal, [99] * 50, [True] * 50)
        self.assertEqual([s["threshold"] for s in first], [s["threshold"] for s in second])
        self.assertEqual([s["threshold"] for s in first], abstain.candidates(proposal))

    def test_always_released_errors_do_not_block_looser_thresholds(self):
        # Fallbacks (math.inf) are released whatever the threshold; a few errors among them
        # fail the strictest candidates but not the looser ones (why a grid, not a sequence).
        scores = [math.inf] * 6 + list(range(300))
        wrong = [True, True] + [False] * 4 + [s < 30 for s in range(300)]
        threshold, steps, _ = abstain.choose_threshold(scores, scores, wrong, target=0.10)
        self.assertGreater(steps[0]["upper"], 0.10)
        self.assertLess(threshold, 100)

    def test_nothing_is_certified_when_no_threshold_is_safe(self):
        # Review W3-1 finding 2: no passing candidate is not a threshold of infinity; a
        # fallback-only release is not certified and never passes.
        scores = [math.inf] * 3 + [1, 2, 3, 4]
        wrong = [True] * 7
        threshold, _, chosen = abstain.choose_threshold(scores, scores, wrong)
        self.assertEqual((threshold, chosen), (None, None))
        result = abstain.score_threshold(scores, wrong, threshold)
        self.assertEqual((result["released"], result["certified"], result["passed"]), (3, False, False))

    def test_ties_enter_together_and_none_never_releases(self):
        threshold, steps, _ = abstain.choose_threshold([5, 5, 5, None], [5, 5, 5, None], [False, False, True, False],
                                                       target=0.99)
        self.assertEqual(steps[0]["released"], 3)
        self.assertEqual(threshold, 5)
        self.assertEqual(abstain.score_threshold([5, None], [False, False], 5)["released"], 1)

    def test_the_ceiling_holds_on_held_out_data_from_the_same_source(self):
        rng = random.Random(0)

        def draw(n):
            scores = [rng.random() for _ in range(n)]
            return scores, [rng.random() > 0.5 + 0.5 * s for s in scores]   # wrong more often when unsure

        proposal, certify, test = draw(200), draw(400), draw(600)
        threshold, _, _ = abstain.choose_threshold(proposal[0], *certify, target=0.10)
        result = abstain.score_threshold(*test, threshold)
        self.assertLessEqual(result["error"], result["allowance"])

    def test_the_pass_rule_needs_half_released(self):
        scores = list(range(10))
        result = abstain.score_threshold(scores, [False] * 10, 6)
        self.assertEqual((result["released"], result["passed"]), (4, False))

    def test_auroc(self):
        self.assertEqual(abstain.auroc([0.9, 0.8, 0.1], [True, True, False]), 1.0)
        self.assertEqual(abstain.auroc([0.5, 0.5], [True, False]), 0.5)
        self.assertIsNone(abstain.auroc([0.5], [True]))
        rng = random.Random(1)
        scores = [rng.random() for _ in range(200)]
        labels = [rng.random() < 0.3 for _ in range(200)]
        brute = sum((p > n) + 0.5 * (p == n) for p, y in zip(scores, labels) if y
                    for n, z in zip(scores, labels) if not z) / (sum(labels) * (200 - sum(labels)))
        self.assertAlmostEqual(abstain.auroc(scores, labels), brute, places=9)


def calibration(**changes):
    data = {"id": "test-1", "task": "gsm8k-arithmetic", "model": "m", "weightsHash": "w", "thresholdSet": "t-1",
            "reference": True, "steps": 40, "maxNewTokens": 512, "score": "answer-number-logprob",
            "threshold": -0.5, "target": 0.1, "delta": 0.05, "certified": True, "heldOut": {"passed": True}}
    data.update(changes)
    return data


class LoadTest(unittest.TestCase):
    """Review W3-1 finding 2: only a certified, held-out-passed calibration with a finite
    threshold, measured with these settings, is used; one that names this task and model but
    cannot be trusted raises (the guard holds); any other is simply not this one."""

    def load(self, files, **settings):
        with tempfile.TemporaryDirectory() as folder:
            for name, text in files.items():
                with open(os.path.join(folder, name), "w", encoding="utf-8") as handle:
                    handle.write(text if isinstance(text, str) else json.dumps(text))
            wanted = dict(steps=40, max_new_tokens=512, threshold_set="t-1", reference=True)
            wanted.update(settings)
            return abstain.load_calibration("m", "w", "gsm8k-arithmetic", directory=folder, **wanted)

    def test_a_valid_calibration_for_these_settings_is_used(self):
        self.assertEqual(self.load({"a.json": calibration()})["threshold"], -0.5)

    def test_other_settings_or_tasks_are_uncalibrated(self):
        self.assertIsNone(self.load({"a.json": calibration()}, max_new_tokens=1))
        self.assertIsNone(self.load({"a.json": calibration()}, reference=False))
        self.assertIsNone(self.load({"a.json": calibration()}, threshold_set="t-2"))
        self.assertIsNone(self.load({"a.json": calibration(weightsHash="other")}))
        self.assertIsNone(self.load({"a.json": calibration(task="other-task", certified=False)}))

    def test_an_untrustworthy_calibration_for_this_task_raises(self):
        bad = [calibration(certified=False), calibration(heldOut={"passed": False}), calibration(threshold=True),
               calibration(threshold="0.5"), calibration(threshold=None), calibration(target=2),
               calibration(maxNewTokens=True)]
        for data in bad:
            with self.subTest(data), self.assertRaises(abstain.CalibrationInvalid):
                self.load({"a.json": data})
        for word in ("NaN", "-Infinity", "Infinity"):
            text = json.dumps(calibration()).replace('"threshold": -0.5', f'"threshold": {word}')
            with self.subTest(word), self.assertRaises(abstain.CalibrationInvalid):
                self.load({"a.json": text})
        with self.assertRaises(abstain.CalibrationInvalid):
            self.load({"a.json": "{not json"})


def old_predicted_number(text):
    """The grader before review W3-1, kept to show the shared parser grades the same."""
    from latent_team.evaluate import to_number
    lowered = text.lower()
    if "answer is" in lowered:
        value = to_number(text[lowered.rindex("answer is"):], first=True)
        if value is not None:
            return value
    boxed = re.findall(BS + BS + r"boxed\{([^}]*)\}", text)
    if boxed:
        return to_number(boxed[-1], first=True)
    return to_number(text)


class ConfidenceTest(unittest.TestCase):
    def test_the_score_is_the_log_probability_of_the_final_number(self):
        from latent_team.confidence import answer_logprob, number_span
        pieces = ["Step", " 1", ": 3", "+", "4", ".", " The", " answer", " is", " 1", "8", "."]
        logprobs = [-0.1] * 9 + [-0.5, -0.25, -0.01]
        self.assertAlmostEqual(answer_logprob(pieces, logprobs, "".join(pieces)), -0.75)
        self.assertEqual(number_span("so 3 then 7, not 72"), (17, 19))
        self.assertEqual(number_span("The answer is 7, not 72"), (14, 15))
        self.assertEqual(number_span("The answer is $1,200."), (15, 20))

    def test_no_number_means_no_score(self):
        from latent_team.confidence import answer_logprob
        self.assertIsNone(answer_logprob(["I", " do", " not", " know"], [-1.0] * 4))
        self.assertIsNone(answer_logprob([], []))
        self.assertIsNone(answer_logprob(["a"], [-1.0, -2.0]))

    def test_the_score_is_of_the_number_the_grader_reads(self):
        # Review W3-1 finding 4: "1$2" is graded 12, and a \boxed{} without a number has no
        # graded number at all, whatever comes after it.
        from latent_team.confidence import answer_logprob
        from latent_team.evaluate import predicted_number
        pieces = ["The", " answer", " is", " 1", "$", "2"]
        self.assertEqual(predicted_number("".join(pieces)), 12)
        self.assertAlmostEqual(answer_logprob(pieces, [-0.1, -0.1, -0.1, -0.5, -0.2, -0.3], "".join(pieces)), -1.0)
        boxed = [BS + "boxed{unknown}", "; step", " 25"]
        self.assertIsNone(predicted_number("".join(boxed)))
        self.assertIsNone(answer_logprob(boxed, [-0.1, -0.1, -0.1], "".join(boxed)))

    def test_pieces_that_do_not_join_into_the_answer_have_no_score(self):
        from latent_team.confidence import answer_logprob
        pieces = ["The", " answer", " is", " 1", chr(0xFFFD)]   # a character split across tokens
        self.assertIsNone(answer_logprob(pieces, [-0.1] * 5, "The answer is 1" + chr(0x00E9)))
        self.assertIsNone(answer_logprob(["The answer is", " 1"], [-0.1, float("nan")], "The answer is 1"))
        self.assertIsNone(answer_logprob(["The answer is", " 1"], [-0.1, 0.5], "The answer is 1"))

    def test_the_shared_parser_grades_exactly_as_before(self):
        rng = random.Random(3)
        alphabet = list("0123456789,.$- abxThe answer isANSWER IS{}") + [BS + "boxed{"]
        for _ in range(20000):
            text = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 40)))
            if rng.random() < 0.3:
                text = "The answer is " + text
            from latent_team.evaluate import predicted_number
            self.assertEqual(predicted_number(text), old_predicted_number(text), repr(text))


try:
    import torch  # noqa: F401
    HAVE_TORCH = True
except ImportError:
    HAVE_TORCH = False


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for the squad")
class GuardedPathTest(unittest.TestCase):
    """The guarded paths with a real (tiny) team and real decode scores."""

    def test_an_untrustworthy_calibration_holds_before_any_model_call(self):
        from latent_team.guard import Guard
        from tests.test_gateway_squad import STEPS, TOKENS, Seen, text_team
        team = text_team()
        with tempfile.TemporaryDirectory() as folder:
            with open(os.path.join(folder, "a.json"), "w", encoding="utf-8") as handle:
                json.dump(calibration(model=team.model_name, certified=False), handle)
            guard = Guard(team, thresholds=None, sample=lambda: False, calibration_dir=folder)
            with Seen(team.tokenizer) as seen:
                [outcome] = guard.run(["2+2?"], steps=STEPS, max_new_tokens=TOKENS, task="gsm8k-arithmetic")
        self.assertEqual((outcome.decision["action"], outcome.decision["reason"], outcome.answer),
                         ("hold", "calibration-invalid", None))
        self.assertEqual(seen.prompts, [], "the model never ran")

    def test_a_calibrated_route_abstains_on_both_routes(self):
        # Review W3-1 finding 5: the chat route takes "task" too; with a threshold no answer
        # can reach, both routes decline and carry no model text.
        from latent_pool.team_service import ABSTAINED, MODEL_ID
        from tests.test_gateway_squad import STEPS, TOKENS, quiet_service, text_team
        team = text_team()
        service = quiet_service(team)
        service.guard.calibration = lambda task, *args, **kwargs: {"threshold": 1e9} if task else None
        body = service({"question": "The answer is 4?", "latentSteps": STEPS, "maxNewTokens": TOKENS,
                        "task": "gsm8k-arithmetic"})
        self.assertEqual((body["mode"], body["answer"]), ("abstained", None))
        chat = service.chat({"model": MODEL_ID, "max_tokens": TOKENS, "task": "gsm8k-arithmetic",
                             "messages": [{"role": "user", "content": "2+2?"}]})
        self.assertEqual(chat["choices"][0]["message"]["content"], ABSTAINED)
        # Without a task the same request is released, marked uncalibrated.
        released = service({"question": "The answer is 4?", "latentSteps": STEPS, "maxNewTokens": TOKENS})
        self.assertEqual(released["mode"], "latent-team")

    def test_the_eval_scores_through_the_guarded_path_without_abstaining(self):
        # Review W3-1 finding 3: the eval's decisions come from Guard.run itself; its scoring
        # calibration never abstains, and the run's exploratory scores and solver state are
        # kept in memory only in the eval's measuring mode.
        from latent_team.abstain_eval import PROBE_SCORE
        from latent_team.guard import Guard
        from tests.test_gateway_squad import STEPS, TOKENS, text_team
        team = text_team()
        guard = Guard(team, thresholds=None, sample=lambda: False, measure=True, keep_solver_state=True)
        outcomes = guard.run(["2+2?", "3+3?"], steps=STEPS, max_new_tokens=TOKENS, calibration_override=PROBE_SCORE)
        for outcome in outcomes:
            self.assertEqual(outcome.decision["action"], "release")
            self.assertTrue(outcome.confidence is None or math.isfinite(outcome.confidence))
            self.assertIn("meanLogprob", outcome.extra)
            self.assertEqual(tuple(outcome.extra["solverState"].shape)[:1], (32,))
        plain = Guard(team, thresholds=None, sample=lambda: False).run(["2+2?"], steps=STEPS, max_new_tokens=TOKENS,
                                                                        calibration_override=PROBE_SCORE)
        self.assertEqual(plain[0].extra, {}, "nothing extra is kept outside the eval")


if __name__ == "__main__":
    unittest.main()
