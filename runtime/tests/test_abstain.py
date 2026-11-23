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
            "reference": True, "steps": 40, "maxNewTokens": 512, "batch": 1, "gated": True, "grid": 20,
            "score": "answer-number-logprob", "threshold": -0.5, "target": 0.1, "delta": 0.05, "certified": True,
            "certification": {"threshold": -0.5, "released": 300, "errors": 6, "heldCountedWrong": 0},
            "heldOut": {"questions": 519, "released": 400, "errors": 30, "passed": True, "heldCountedWrong": 0},
            "profile": "request-public",
            "provenance": {"run": "run-1", "commit": "abc1234",
                           "dataset": {"revision": "r", "fingerprint": "f", "labels": "l"}},
            "measuredOn": {"plan": "full"}}
    data.update(changes)
    return data


class LoadTest(unittest.TestCase):
    """Review W3-1 finding 2: only a certified, held-out-passed calibration with a finite
    threshold, measured with these settings, is used; one that names this task and model but
    cannot be trusted raises (the guard holds); any other is simply not this one."""

    def load(self, files, **settings):
        with tempfile.TemporaryDirectory() as folder:
            for name, text in files.items():
                name = abstain.artifact_name("gsm8k-arithmetic", "m") if name == "a.json" else name
                with open(os.path.join(folder, name), "w", encoding="utf-8") as handle:
                    handle.write(text if isinstance(text, str) else json.dumps(text))
            wanted = dict(steps=40, max_new_tokens=512, threshold_set="t-1", reference=True, batch=1, gated=True,
                          profile="request-public")
            wanted.update(settings)
            return abstain.load_calibration("m", "w", "gsm8k-arithmetic", directory=folder, **wanted)

    def test_a_valid_calibration_for_these_settings_is_used(self):
        self.assertEqual(self.load({"a.json": calibration()})["threshold"], -0.5)

    def test_other_settings_or_tasks_are_uncalibrated(self):
        self.assertIsNone(self.load({"a.json": calibration()}, max_new_tokens=1))
        self.assertIsNone(self.load({"a.json": calibration()}, reference=False))
        self.assertIsNone(self.load({"a.json": calibration()}, threshold_set="t-2"))
        self.assertIsNone(self.load({"a.json": calibration(weightsHash="other")}))
        # Review W3-2 finding 2: the policy is part of the binding (one question per call,
        # the gateway in front, as the service runs).
        self.assertIsNone(self.load({"a.json": calibration()}, batch=32))
        self.assertIsNone(self.load({"a.json": calibration()}, gated=False))
        # A file of any other name is not this task's calibration.
        self.assertIsNone(self.load({"other.json": calibration(certified=False)}))

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
        # Review W3-2 finding 3: the file is found by its name, so an empty or foreign
        # payload holds instead of being skipped, and the evidence's counts must pass again.
        weak = [[], calibration(task="other-task"), calibration(model="other-model"),
                calibration(certification={"threshold": -0.5}),
                calibration(certification={"threshold": -0.4, "released": 300, "errors": 6}),
                calibration(certification={"threshold": -0.5, "released": 300, "errors": 40}),
                calibration(heldOut={"passed": True}),
                calibration(heldOut={"questions": 519, "released": 100, "errors": 0, "passed": True}),
                calibration(heldOut={"questions": 519, "released": 400, "errors": 80, "passed": True}),
                calibration(threshold=-1e9)]
        for data in weak:
            with self.subTest(data), self.assertRaises(abstain.CalibrationInvalid):
                self.load({"a.json": data})
        # Review W3-3 finding 3: the file cannot bring its own policy; counts that pass only at
        # a 20% target, another score, grid or delta are refused.
        loose = [calibration(target=0.2, certification={"threshold": -0.5, "released": 400, "errors": 40},
                             heldOut={"questions": 519, "released": 400, "errors": 80, "passed": True}),
                 calibration(score="mean-logprob"), calibration(grid=40), calibration(delta=0.1)]
        for data in loose:
            with self.subTest(data), self.assertRaises(abstain.CalibrationInvalid):
                self.load({"a.json": data})

    def test_a_calibration_applies_to_its_service_profile_only(self):
        # Review W3-4 finding 2: chat input, sensitive clearance and declared secrets change
        # what the model reads or what the gate releases; none of them was measured.
        for profile in ("chat-public", "request-sensitive", "request-public-declared", "chat-sensitive-declared",
                        None):
            with self.subTest(profile):
                self.assertIsNone(self.load({"a.json": calibration()}, profile=profile))
        self.assertEqual(abstain.service_profile("request", "public", False), "request-public")
        self.assertEqual(abstain.service_profile("chat", "sensitive", True), "chat-sensitive-declared")
        for word in ("", "public", "request-public-", "request-private", True, None):
            with self.subTest(word), self.assertRaises(abstain.CalibrationInvalid):
                self.load({"a.json": calibration(profile=word)})

    def test_provenance_and_counts_must_fit_the_plan(self):
        # Review W3-4 finding 4: the run, commit and labelled dataset are carried, and the
        # counts must be possible under the plan the file names.
        dataset = {"revision": "r", "fingerprint": "f", "labels": "l"}
        bad = [calibration(provenance=None), calibration(provenance={"run": "run-1", "commit": "abc1234"}),
               calibration(provenance={"run": "", "commit": "abc1234", "dataset": dataset}),
               calibration(provenance={"run": "run-1", "commit": "abc1234",
                                       "dataset": {"revision": "r", "fingerprint": "f"}}),
               calibration(measuredOn=None), calibration(measuredOn={"plan": "tomorrow"}),
               calibration(measuredOn={"plan": "today"}),   # 519 held-out questions, 300 certification answers
               calibration(measuredOn={"plan": "today"}, heldOut={"questions": 150, "released": 100, "errors": 8,
                                                                  "passed": True}),   # 300 > 200 certify
               calibration(certification={"threshold": -0.5, "released": 401, "errors": 6})]
        for data in bad:
            with self.subTest(data), self.assertRaises(abstain.CalibrationInvalid):
                self.load({"a.json": data})
        fits = calibration(measuredOn={"plan": "today"},
                           certification={"threshold": -0.5, "released": 150, "errors": 2, "heldCountedWrong": 0},
                           heldOut={"questions": 150, "released": 100, "errors": 8, "passed": True,
                                    "heldCountedWrong": 0})
        self.assertEqual(self.load({"a.json": fits})["threshold"], -0.5)

    def test_holds_are_in_the_counts(self):
        # Review W3-5: each hold is counted as a released wrong answer, and not as a release
        # for the coverage rule; a file without that count, or covering half only with its
        # holds, is refused.
        held_out = {"questions": 519, "released": 400, "errors": 30, "passed": True}
        for data in (calibration(certification={"threshold": -0.5, "released": 300, "errors": 6}),
                     calibration(heldOut=held_out),
                     calibration(certification={"threshold": -0.5, "released": 300, "errors": 6, "heldCountedWrong": 7}),
                     calibration(heldOut=dict(held_out, heldCountedWrong=True)),
                     calibration(heldOut=dict(held_out, errors=30, heldCountedWrong=30, released=280))):
            with self.subTest(data), self.assertRaises(abstain.CalibrationInvalid):
                self.load({"a.json": data})
        self.assertIsNotNone(self.load({"a.json": calibration(heldOut=dict(held_out, heldCountedWrong=20))}))

    def test_plan_sizes_match_the_driver(self):
        from latent_team import abstain_eval
        for plan, sizes in abstain.PLAN_SIZES.items():
            self.assertEqual(tuple(len(abstain_eval.plan_keys(plan, part)) for part in ("propose", "certify", "score")),
                             sizes, plan)
        self.assertEqual(set(abstain.PLAN_SIZES), set(abstain_eval.PLANS))


def shard_rows(keys, correct=True):
    return [{"kind": k, "block": b, "position": p, "action": "release", "reason": "ok", "fallback": False,
             "confidence": -0.1 - 0.001 * (n % 30), "teamAnswer": True, "releasedCorrect": correct, "seconds": 1.0}
            for n, (k, b, p) in enumerate(keys)]


class RunProvenanceTest(unittest.TestCase):
    """Review W3-4 finding 1: shards are analysed only as one named run of one commit, each
    request in the shard that owns it; a resumed shard keeps only its own requests."""

    def manifest(self, shard, **changes):
        data = {"run": "run-1", "plan": "today", "weightsHash": "w", "thresholdSet": "t-1", "reference": True,
                "fittedByW1": [0, 2], "dataset": {"revision": "r", "fingerprint": "f", "labels": "l"},
                "shard": shard, "shards": 2, "commit": "abc1234", "phases": "separated"}
        data.update(changes)
        return data

    def analyse(self, shards, calibration_dir=None, run="run-1"):
        import argparse
        from latent_team import abstain_eval
        with tempfile.TemporaryDirectory() as folder:
            for shard, (manifest, rows) in enumerate(shards):   # distinct files even for repeated shards
                with open(os.path.join(folder, f"certify-{shard}-of-{manifest.get('shards')}.json"), "w") as handle:
                    json.dump(dict(manifest, rows=rows, complete=True), handle)
            out = calibration_dir if calibration_dir is not None else None
            args = argparse.Namespace(out=folder, calibration_dir=out, run=run)
            import contextlib
            import io
            with contextlib.redirect_stdout(io.StringIO()):
                abstain_eval.part_analyze(args)
            with open(os.path.join(folder, "summary.json")) as handle:
                return json.load(handle)

    def split(self, keys):
        return [k for n, k in enumerate(keys) if n % 2 == 0], [k for n, k in enumerate(keys) if n % 2 == 1]

    def test_one_run_is_analysed(self):
        from latent_team import abstain_eval
        even, odd = self.split(abstain_eval.work_keys("today"))
        summary = self.analyse([(self.manifest(0), shard_rows(even)), (self.manifest(1), shard_rows(odd))])
        self.assertEqual((summary["plan"], summary["certificationQuestions"], summary["scoredQuestions"]),
                         ("today", 200, 150))
        self.assertIn("holdsByReason", summary)
        self.assertEqual(summary["execution"], "two shards sharing one GPU")

    def test_one_job_is_recorded_as_one_job(self):
        # w3-run10 ran as one job; its summary said "two shards sharing one GPU" (fixed after it).
        from latent_team import abstain_eval
        keys = abstain_eval.work_keys("today")
        rows = shard_rows(keys)
        self.assertIn(keys[0], abstain_eval.plan_keys("today", "propose"))
        rows[0].update(action="hold", reason="report-late", confidence=None, releasedCorrect=False)
        with tempfile.TemporaryDirectory() as calibration_dir:
            summary = self.analyse([(self.manifest(0, shards=1), rows)], calibration_dir=calibration_dir)
            self.assertEqual(summary["execution"], "one job on one GPU")
            # Review W3-8: a proposal hold is listed, and stays out of eval 11 and the worst case.
            self.assertEqual(summary["holdsByReason"]["propose"], {"report-late": 1})
            self.assertEqual(summary["worstCaseForHolds"]["eval11"]["heldCountedWrong"], 0)
            self.assertEqual(summary["worstCaseForHolds"]["certification"]["heldCountedWrong"], 0)
            with open(os.path.join(calibration_dir, abstain.artifact_name(abstain_eval.TASK, abstain_eval.MODEL))) as handle:
                written = json.load(handle)
        self.assertEqual(written["measuredOn"]["execution"], "one job on one GPU")
        self.assertIn("run as one job on one GPU", written["about"])
        self.assertNotIn("shards", written["about"])

    def test_shards_of_two_runs_or_no_provenance_are_refused(self):
        from latent_team import abstain_eval
        even, odd = self.split(abstain_eval.work_keys("today"))
        for first, second in ((self.manifest(0), self.manifest(1, run="run-2")),
                              (self.manifest(0), self.manifest(1, commit="def5678")),
                              (self.manifest(0, run=None), self.manifest(1, run=None)),
                              (self.manifest(0, commit=None), self.manifest(1, commit=None)),
                              (self.manifest(0, dataset={"revision": "r", "fingerprint": "f"}),
                               self.manifest(1, dataset={"revision": "r", "fingerprint": "f"})),
                              (self.manifest(0, phases=None), self.manifest(1, phases=None))):   # review W3-6
            with self.subTest((first, second)), self.assertRaises(SystemExit):
                self.analyse([(first, shard_rows(even)), (second, shard_rows(odd))])

    def test_analysis_takes_only_the_run_it_names(self):
        # Review W3-5: a complete older run in the folder is not analysed in place of another.
        from latent_team import abstain_eval
        even, odd = self.split(abstain_eval.work_keys("today"))
        shards = [(self.manifest(0), shard_rows(even)), (self.manifest(1), shard_rows(odd))]
        for run in ("run-2", None):
            with self.subTest(run), self.assertRaises(SystemExit):
                self.analyse(shards, run=run)
        summary = self.analyse(shards)
        self.assertEqual((summary["run"], summary["commit"]), ("run-1", "abc1234"))

    def test_holds_count_as_released_wrong_answers_for_the_calibration(self):
        # Review W3-5: the shards share a GPU, so a hold may hide a wrong answer; the
        # calibration comes from the worst case, and is not written when only that fails.
        from latent_team import abstain_eval
        keys = abstain_eval.work_keys("today")
        rows = shard_rows(keys)
        scored = [r for r in rows if r["block"] == 3]
        for r in scored[:40]:   # 40 of 150 scored requests held: fine as measured, not at worst
            r.update(action="hold", reason="deadline", teamAnswer=False, releasedCorrect=False, confidence=None)
        even = [r for n, r in enumerate(rows) if n % 2 == 0]
        odd = [r for n, r in enumerate(rows) if n % 2 == 1]
        with tempfile.TemporaryDirectory() as calibration_dir:
            summary = self.analyse([(self.manifest(0), even), (self.manifest(1), odd)], calibration_dir=calibration_dir)
            worst = summary["worstCaseForHolds"]["eval11"]
            self.assertEqual(worst["heldCountedWrong"], 40)
            self.assertEqual(worst["releasedWithoutHolds"], summary["eval11"]["released"])
            self.assertTrue(summary["eval11"]["passed"])   # as measured, holds release nothing
            self.assertFalse(worst["passed"])
            self.assertEqual(os.listdir(calibration_dir), [])
        self.assertEqual(summary["holdsByReason"]["score"], {"deadline": 40})
        # worst_case itself: a hold is released and wrong at every threshold.
        self.assertEqual(abstain_eval.worst_case({"action": "hold"}), (math.inf, True))

    def test_certification_holds_can_withhold_the_calibration(self):
        # Review W3-6: holds in the certification move the worst case's cutoff; enough of
        # them leave nothing certified, and no calibration, though the pre-registered count
        # certifies; with no cutoff the report still counts the holds it tallied.
        from latent_team import abstain_eval
        keys = abstain_eval.work_keys("today")
        rows = shard_rows(keys)
        for r in [r for r in rows if r["block"] == 1][:30]:
            r.update(action="hold", reason="deadline", teamAnswer=False, releasedCorrect=False, confidence=None)
        even = [r for n, r in enumerate(rows) if n % 2 == 0]
        odd = [r for n, r in enumerate(rows) if n % 2 == 1]
        with tempfile.TemporaryDirectory() as calibration_dir:
            summary = self.analyse([(self.manifest(0), even), (self.manifest(1), odd)], calibration_dir=calibration_dir)
            self.assertIsNotNone(summary["threshold"])
            self.assertIsNone(summary["worstCaseForHolds"]["threshold"])
            self.assertEqual(os.listdir(calibration_dir), [])
        worst = summary["worstCaseForHolds"]["eval11"]
        self.assertEqual((worst["heldCountedWrong"], worst["releasedWithoutHolds"], worst["passed"]), (0, 0, False))
        self.assertEqual(summary["eval12"], {"skipped": "no threshold certified"})
        self.assertNotIn("skipped", summary["eval12AtPreRegisteredThreshold"])

    def test_eval12_is_at_the_cutoff_that_would_ship(self):
        # Review W3-7: with holds in the certification the worst case's cutoff (-0.126) is
        # stricter than the pre-registered count's (-0.128); a fresh answer scored between them
        # is released at the one and not at the other, and the calibration takes the stricter.
        from latent_team import abstain_eval
        rows = []
        for kind, block, position in abstain_eval.work_keys("today"):
            level = position % 30
            rows.append({"kind": kind, "block": block, "position": position, "action": "release", "reason": "ok",
                         "fallback": False, "confidence": -0.1 - 0.001 * level, "teamAnswer": True,
                         "releasedCorrect": not (block == 1 and level >= 28), "seconds": 1.0})
            if kind == "fresh":
                rows[-1]["confidence"] = -0.127
        for r in [r for r in rows if r["block"] == 1][:3]:
            r.update(action="hold", reason="deadline", teamAnswer=False, releasedCorrect=False, confidence=None)
        even = [r for n, r in enumerate(rows) if n % 2 == 0]
        odd = [r for n, r in enumerate(rows) if n % 2 == 1]
        with tempfile.TemporaryDirectory() as calibration_dir:
            summary = self.analyse([(self.manifest(0), even), (self.manifest(1), odd)], calibration_dir=calibration_dir)
            name = abstain.artifact_name(abstain_eval.TASK, abstain_eval.MODEL)
            with open(os.path.join(calibration_dir, name)) as handle:
                written = json.load(handle)
        self.assertAlmostEqual(summary["threshold"], -0.128)
        self.assertAlmostEqual(summary["worstCaseForHolds"]["threshold"], -0.126)
        self.assertAlmostEqual(written["threshold"], -0.126)
        self.assertEqual(summary["eval12"]["released"], 0)
        self.assertEqual(summary["eval12AtPreRegisteredThreshold"]["released"], 8)

    def test_no_cutoff_still_counts_scored_holds(self):
        from latent_team import abstain_eval
        scored = shard_rows([("gsm8k", 3, p) for p in range(10)])
        for r in scored[:4]:
            r.update(action="hold", reason="deadline", confidence=None, releasedCorrect=False)
        result = abstain_eval.worst_case_eval11(scored, None)
        self.assertEqual((result["released"], result["heldCountedWrong"], result["releasedWithoutHolds"]), (4, 4, 0))
        self.assertFalse(result["passed"])

    def test_a_request_in_the_wrong_shard_is_refused(self):
        from latent_team import abstain_eval
        even, odd = self.split(abstain_eval.work_keys("today"))
        even, odd = even[1:], odd + even[:1]   # the same requests, each once, one in the wrong shard
        with self.assertRaises(SystemExit) as caught:
            self.analyse([(self.manifest(0), shard_rows(even)), (self.manifest(1), shard_rows(odd))])
        self.assertIn("another shard owns", str(caught.exception))

    def test_resume_keeps_only_this_runs_own_requests(self):
        from latent_team import abstain_eval
        keys = abstain_eval.work_keys("today")
        owned = {k for n, k in enumerate(keys) if n % 2 == 0}
        manifest = self.manifest(0)
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "certify-0-of-2.json")
            self.assertEqual(abstain_eval.resumed(path, manifest, owned), [])
            mine = [k for n, k in enumerate(keys) if n % 2 == 0][:5]
            for rows, other, fails in ((shard_rows(mine), {}, False),
                                       (shard_rows(mine), {"commit": "def5678"}, True),     # another commit
                                       (shard_rows(mine), {"run": "run-2"}, True),          # another run
                                       (shard_rows(mine + mine[:1]), {}, True),             # a request twice
                                       (shard_rows(mine + [keys[1]]), {}, True)):           # shard 1's request
                with open(path, "w") as handle:
                    json.dump(dict(manifest, **other, rows=rows, complete=False), handle)
                with self.subTest(other=other, rows=len(rows)):
                    if fails:
                        with self.assertRaises(SystemExit):
                            abstain_eval.resumed(path, manifest, owned)
                    else:
                        self.assertEqual(len(abstain_eval.resumed(path, manifest, owned)), 5)

    def test_the_written_calibration_loads_for_its_profile_only(self):
        # Review W3-4 findings 2 and 4: the writer's file carries its run, commit, dataset,
        # plan and profile, and the loader takes it for /latent/team public requests only.
        from latent_team import abstain_eval
        even, odd = self.split(abstain_eval.work_keys("today"))
        with tempfile.TemporaryDirectory() as calibration_dir:
            summary = self.analyse([(self.manifest(0), shard_rows(even)), (self.manifest(1), shard_rows(odd))],
                                   calibration_dir=calibration_dir)
            self.assertTrue(summary["eval11"]["passed"])
            name = abstain.artifact_name(abstain_eval.TASK, abstain_eval.MODEL)
            with open(os.path.join(calibration_dir, name)) as handle:
                written = json.load(handle)
            self.assertEqual(written["profile"], "request-public")
            self.assertEqual(written["provenance"]["run"], "run-1")
            self.assertEqual(written["provenance"]["dataset"]["labels"], "l")
            self.assertEqual(written["measuredOn"]["plan"], "today")
            self.assertEqual(written["measuredOn"]["execution"], "two shards sharing one GPU")
            self.assertEqual((written["heldOut"]["heldCountedWrong"], written["certification"]["heldCountedWrong"]),
                             (0, 0))
            settings = dict(steps=abstain_eval.STEPS, max_new_tokens=abstain_eval.TOKENS, threshold_set="t-1",
                            reference=True, batch=1, gated=True, directory=calibration_dir)
            self.assertIsNotNone(abstain.load_calibration(abstain_eval.MODEL, "w", abstain_eval.TASK,
                                                          profile="request-public", **settings))
            for profile in ("chat-public", "request-sensitive", "request-public-declared"):
                self.assertIsNone(abstain.load_calibration(abstain_eval.MODEL, "w", abstain_eval.TASK,
                                                           profile=profile, **settings))
            # A file whose counts do not fit its plan is refused, and the run holds.
            written["heldOut"]["questions"] = 519
            with open(os.path.join(calibration_dir, name), "w") as handle:
                json.dump(written, handle)
            with self.assertRaises(abstain.CalibrationInvalid):
                abstain.load_calibration(abstain_eval.MODEL, "w", abstain_eval.TASK, profile="request-public",
                                         **settings)


class BarrierTest(unittest.TestCase):
    """Review W3-6: no shard starts a part while another shard is still in an earlier one."""

    def setUp(self):
        from latent_team import abstain_eval
        self.ev = abstain_eval
        self.order = abstain_eval.work_keys("today", fresh=8)
        self.parts = abstain_eval.part_of_keys("today", fresh=8)
        self.manifest = RunProvenanceTest().manifest(0)

    def write(self, folder, shard, keys, **changes):
        with open(os.path.join(folder, f"certify-{shard}-of-2.json"), "w") as handle:
            json.dump(dict(self.manifest, shard=shard, rows=shard_rows(keys), complete=False, **changes), handle)

    def owned(self, shard, part):
        return [k for n, k in enumerate(self.order) if n % 2 == shard and self.parts[k] == part]

    def test_ready_only_when_every_shard_finished_the_earlier_parts(self):
        with tempfile.TemporaryDirectory() as folder:
            ready = lambda part: self.ev.barrier_ready(folder, self.manifest, part, self.order, self.parts)   # noqa: E731
            self.assertTrue(ready("propose"))          # nothing comes before the proposal
            self.assertFalse(ready("certify"))         # no shard has saved yet
            self.write(folder, 0, self.owned(0, "propose"))
            self.assertFalse(ready("certify"))         # shard 1 has not
            self.write(folder, 1, self.owned(1, "propose")[:-1])
            self.assertFalse(ready("certify"))         # shard 1's last proposal request is still running
            self.write(folder, 1, self.owned(1, "propose"), run="run-0")
            self.assertFalse(ready("certify"))         # a file of another run does not count
            self.write(folder, 1, self.owned(1, "propose"))
            self.assertTrue(ready("certify"))
            self.assertFalse(ready("score"))           # certification not finished

    def test_waiting_gives_up_after_its_limit(self):
        slept = []
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(SystemExit):
            self.ev.wait_for_part(folder, self.manifest, "certify", self.order, self.parts, poll=10, limit=30,
                                  sleep=slept.append)
        self.assertEqual(slept, [10, 10, 10])

    def test_progress_by_another_shard_resets_the_limit(self):
        # Review W3-7: a shard that resumed far behind keeps saving rows; the wait goes on.
        needed = self.owned(1, "propose")
        with tempfile.TemporaryDirectory() as folder:
            self.write(folder, 0, self.owned(0, "propose"))
            saved = [0]

            def sleep(seconds):   # shard 1 saves five more rows during every poll
                saved[0] = min(len(needed), saved[0] + 5)
                self.write(folder, 1, needed[:saved[0]])
            self.ev.wait_for_part(folder, self.manifest, "certify", self.order, self.parts, poll=10, limit=20,
                                  sleep=sleep)
            self.assertEqual(saved[0], len(needed))   # six polls, past a 20 s limit, and no stop

    def test_replacement_is_retried_then_given_up(self):
        # Review W3-7: on native Windows a reader can make os.replace fail for a moment.
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "certify-0-of-2.json")
            calls, slept = [], []

            def flaky(source, target):
                calls.append(target)
                if len(calls) == 1:
                    raise PermissionError("in use")
                os.replace(source, target)
            self.ev.write_atomic(path, {"rows": [1]}, replace=flaky, sleep=slept.append)
            with open(path) as handle:
                self.assertEqual(json.load(handle), {"rows": [1]})
            self.assertEqual((len(calls), len(slept)), (2, 1))

            def never(source, target):
                raise PermissionError("in use")
            with self.assertRaises(PermissionError):
                self.ev.write_atomic(path, {"rows": [2]}, replace=never, sleep=lambda seconds: None)
            with open(path) as handle:
                self.assertEqual(json.load(handle), {"rows": [1]})   # the last whole file stays

    def test_each_part_starts_after_a_save_and_a_wait(self):
        events, rows = [], []
        work = [(k[0], k[1], k[2], None) for k in self.order]

        def ask(kind, block, position, item):
            events.append(("ask", self.parts[(kind, block, position)]))
            return {"kind": kind, "block": block, "position": position, "seconds": 1.0}
        import contextlib
        import io
        with contextlib.redirect_stdout(io.StringIO()):
            self.ev.run_work(work, 1, 2, set(), rows, ask, lambda complete: events.append(("save", complete)),
                             lambda part: events.append(("wait", part)), self.parts)
        waits = [e for e in events if e[0] == "wait"]
        self.assertEqual(waits, [("wait", p) for p in self.ev.PARTS])
        for index, event in enumerate(events):
            if event[0] == "wait":
                self.assertEqual(events[index - 1], ("save", False))   # its rows are visible first
                following = next(e for e in events[index:] if e[0] == "ask")
                self.assertEqual(following[1], event[1])
        asked = [e[1] for e in events if e[0] == "ask"]
        self.assertEqual(asked, sorted(asked, key=self.ev.PARTS.index))   # parts never interleave
        self.assertEqual(len(rows), len(self.order) // 2)


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
            with open(os.path.join(folder, abstain.artifact_name("gsm8k-arithmetic", team.model_name)), "w",
                      encoding="utf-8") as handle:
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

    def test_an_answer_whose_graded_number_the_gate_changes_abstains(self):
        # Review W3-3 finding 4: the score is of 12345678, which the public gate redacts, so
        # the grader would read 2: the service declines instead of releasing.
        from latent_team.abstain_eval import PROBE_SCORE
        from tests.test_gateway_squad import STEPS, TOKENS, quiet_service, text_team
        team = text_team()
        decode = team.decode

        def writing(memory, memory_mask, prompts, max_new_tokens, **kwargs):
            out = decode(memory, memory_mask, prompts, max_new_tokens, **kwargs)
            texts = ["The answer is 12345678, after 2 steps." for _ in out[0]]
            if kwargs.get("scores"):
                pieces = ["The answer is ", "12345678", ", after 2 steps."]
                return texts, out[1], [{"pieces": pieces, "raw": "".join(pieces), "logprobs": [-0.1, -0.2, -0.1]}
                                       for _ in texts]
            return texts, out[1]

        team.decode = writing
        service = quiet_service(team)
        service.guard.calibration = lambda task, *args, **kwargs: PROBE_SCORE if task else None
        body = {"question": "What is it?", "latentSteps": STEPS, "maxNewTokens": TOKENS, "task": "gsm8k-arithmetic"}
        result = service(dict(body, secrets=["12345678"]))
        self.assertEqual((result["mode"], result["reason"]), ("abstained", "number-changed"))
        self.assertEqual(service(body)["mode"], "latent-team", "unchanged by the gate, the answer is released")
        from latent_team.guard import same_graded_number
        self.assertTrue(same_graded_number("The answer is 7.", "The answer is 7."))
        self.assertFalse(same_graded_number("The answer is 1,200.", "The answer is 1200."))

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
