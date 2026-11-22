"""W3: the calibration math of abstention (no torch, synthetic scores only)."""
import math
import random
import unittest

from latent_team import abstain


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
        threshold, steps = abstain.choose_threshold(scores, wrong, target=0.10)
        result = abstain.score_threshold(scores, wrong, threshold)
        self.assertEqual((threshold, result["released"], result["errors"], result["passed"]), (20, 80, 0, True))
        self.assertEqual([s["released"] for s in steps][:3], [5, 10, 15], "a grid of release fractions")

    def test_always_released_errors_do_not_block_looser_thresholds(self):
        # Fallbacks (math.inf) are released whatever the threshold; a few errors among them
        # fail the strictest candidates but not the looser ones (why a grid, not a sequence).
        scores = [math.inf] * 6 + list(range(300))
        wrong = [True, True] + [False] * 4 + [s < 30 for s in range(300)]
        threshold, steps = abstain.choose_threshold(scores, wrong, target=0.10)
        self.assertGreater(steps[0]["upper"], 0.10)
        self.assertLess(threshold, 100)

    def test_nothing_is_released_when_no_threshold_is_safe(self):
        threshold, _ = abstain.choose_threshold([1, 2, 3, 4], [True, True, True, True])
        self.assertEqual(threshold, math.inf)
        result = abstain.score_threshold([1, 2, 3, 4], [True] * 4, threshold)
        self.assertEqual((result["released"], result["passed"]), (0, False))

    def test_ties_enter_together_and_none_never_releases(self):
        threshold, steps = abstain.choose_threshold([5, 5, 5, None], [False, False, True, False], target=0.99)
        self.assertEqual(steps[0]["released"], 3)
        self.assertEqual(threshold, 5)
        self.assertEqual(abstain.score_threshold([5, None], [False, False], 5)["released"], 1)

    def test_the_ceiling_holds_on_held_out_data_from_the_same_source(self):
        rng = random.Random(0)

        def draw(n):
            scores = [rng.random() for _ in range(n)]
            return scores, [rng.random() > 0.5 + 0.5 * s for s in scores]   # wrong more often when unsure

        calib, test = draw(600), draw(600)
        threshold, _ = abstain.choose_threshold(*calib, target=0.10)
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



class ConfidenceTest(unittest.TestCase):
    def test_the_score_is_the_log_probability_of_the_final_number(self):
        from latent_team.confidence import answer_logprob, number_span
        pieces = ["Step", " 1", ": 3", "+", "4", ".", " The", " answer", " is", " 1", "8", "."]
        logprobs = [-0.1] * 9 + [-0.5, -0.25, -0.01]
        self.assertAlmostEqual(answer_logprob(pieces, logprobs), -0.75)
        self.assertEqual(number_span("so 3 then 7, not 72"), (17, 19))
        self.assertEqual(number_span("The answer is 7, not 72"), (14, 15))
        self.assertEqual(number_span("The answer is $1,200."), (15, 20))

    def test_no_number_means_no_score(self):
        from latent_team.confidence import answer_logprob
        self.assertIsNone(answer_logprob(["I", " do", " not", " know"], [-1.0] * 4))
        self.assertIsNone(answer_logprob([], []))
        self.assertIsNone(answer_logprob(["a"], [-1.0, -2.0]))

if __name__ == "__main__":
    unittest.main()
