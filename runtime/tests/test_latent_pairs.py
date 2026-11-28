"""L5: the plan, the batch runner and the report for mappers of more model pairs.

Standard library only. Nothing here loads a model or trains: the runner is driven with a
stand-in for the training and measuring processes.
"""
import json
import os
import tempfile
import unittest

from latent_compare.models import MAPPERS, MODELS
from latent_pairs import evaluate, plan, report, run
from latent_transfer.data import END, end_marker


class Tokenizer:
    """A tokenizer that knows some special tokens as one id and spells everything else out."""

    def __init__(self, specials, eos_token=None):
        self.specials, self.eos_token = list(specials), eos_token

    def __call__(self, text, add_special_tokens=False):
        ids, rest = [], text
        while rest:
            special = next((s for s in self.specials if rest.startswith(s)), None)
            if special:
                ids.append(1000 + self.specials.index(special))
                rest = rest[len(special):]
            else:
                ids.append(ord(rest[0]))
                rest = rest[1:]
        return {"input_ids": ids}


class EndMarkerTest(unittest.TestCase):
    def test_a_chatml_receiver_keeps_im_end(self):
        self.assertEqual(end_marker(Tokenizer([END, "<|endoftext|>"], eos_token="<|endoftext|>")), END)

    def test_a_receiver_without_im_end_gets_its_own_end_token(self):
        # Phi-3.5, Granite and Mistral spell <|im_end|> out; taught to write it they never stop.
        self.assertEqual(end_marker(Tokenizer(["<|endoftext|>"], eos_token="<|endoftext|>")), "<|endoftext|>")
        self.assertEqual(end_marker(Tokenizer(["</s>"], eos_token="</s>")), "</s>")

    def test_a_tokenizer_with_neither_is_refused(self):
        with self.assertRaises(ValueError):
            end_marker(Tokenizer([], eos_token=None))
        with self.assertRaises(ValueError):   # an end token it cannot write as one token is no end token
            end_marker(Tokenizer([], eos_token="<eos>"))


class PlanTest(unittest.TestCase):
    def test_pairs_of_eight_models(self):
        self.assertEqual(len(plan.ordered_pairs()), 56)
        self.assertEqual(len(plan.trainable_pairs()), 20)
        self.assertIn(("phi3.5", "qwen1.5"), plan.trainable_pairs())

    def test_the_batch_is_trainable_and_starts_with_the_m2b_s_pair(self):
        self.assertEqual(plan.BATCH[0], ("phi3.5", "qwen1.5"))
        self.assertEqual(len(set(plan.BATCH)), len(plan.BATCH))
        for pair in plan.BATCH:
            self.assertIsNone(plan.untrainable(*pair), pair)

    def test_why_a_pair_cannot_be_trained(self):
        self.assertIn("vLLM", plan.untrainable("qwen7", "qwen1.5"))
        self.assertIn("vLLM", plan.untrainable("qwen1.5", "llama8"))
        self.assertIn("14 GiB", plan.untrainable("mistral7", "qwen0.5"))
        self.assertIn("14 GiB", plan.untrainable("qwen0.5", "mistral7"))
        # A pair with both problems names the one that cannot be worked around first.
        self.assertIn("vLLM", plan.untrainable("mistral7", "qwen7"))
        with self.assertRaises(ValueError):
            plan.train_args("mistral7", "qwen0.5", "out", plan.recipe())

    def test_recipe_is_half_of_m2b_s_and_the_variants_change_only_what_they_name(self):
        base = plan.recipe()
        self.assertEqual((base["stage1_steps"], base["stage2_steps"], base["batch1"], base["batch2"]), (8000, 10000, 4, 2))
        full, small = plan.recipe(full_steps=True), plan.recipe(small_batches=True)
        self.assertEqual((full["stage1_steps"], full["stage2_steps"]), (15000, 20000))
        self.assertEqual((small["batch1"], small["batch2"]), (2, 1))
        self.assertEqual({k for k in base if base[k] != full[k]}, {"stage1_steps", "stage2_steps"})
        self.assertEqual({k for k in base if base[k] != small[k]}, {"batch1", "batch2"})

    def test_train_args_name_the_models_and_every_setting(self):
        args = plan.train_args("qwen3", "qwen1.5", "/out", plan.recipe(), resume="/out/stage1.pt")
        self.assertEqual(args[:6], ["--out", "/out", "--sender", MODELS["qwen3"]["id"], "--receiver", MODELS["qwen1.5"]["id"]])
        for flag, value in (("--stage1-steps", "8000"), ("--stage2-steps", "10000"), ("--batch1", "4"), ("--batch2", "2"),
                            ("--lr2", "1e-05"), ("--max-tokens", "256"), ("--dim", "384"), ("--resume", "/out/stage1.pt")):
            self.assertEqual(args[args.index(flag) + 1], value, flag)

    def test_train_args_match_the_trainer_s_own_flags(self):
        # A setting the trainer does not take would stop every run at its first line.
        with open(os.path.join(os.path.dirname(__file__), "..", "latent_transfer", "train.py"), encoding="utf-8") as handle:
            source = handle.read()
        for flag in plan.train_args("qwen3", "qwen1.5", "/out", plan.recipe(), resume="x")[::2]:
            self.assertIn(f'"{flag}"', source, flag)

    def test_budget_and_out_of_memory(self):
        self.assertTrue(plan.within_budget(23.9))
        self.assertFalse(plan.within_budget(24))
        self.assertTrue(plan.out_of_memory("torch.OutOfMemoryError: CUDA out of memory. Tried to allocate"))
        self.assertFalse(plan.out_of_memory("ValueError: Checkpoint is for another pair."))


class Runner:
    """Stands in for the training and measuring processes."""

    def __init__(self, train=None, measure=0, seconds=3600.0):
        self.train_codes, self.measure_code, self.seconds, self.calls = list(train or [0]), measure, seconds, []

    def __call__(self, command, log_path):
        self.calls.append(command)
        if "latent_transfer.train" in command:
            folder = command[command.index("--out") + 1]
            code = self.train_codes.pop(0) if self.train_codes else 0
            with open(os.path.join(folder, "log.jsonl"), "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"event": "start"}) + "\n")
                if code == 0:
                    handle.write(json.dumps({"event": "done"}) + "\n")
            with open(log_path, "a", encoding="utf-8") as handle:
                handle.write("ok\n" if code == 0 else
                             ("torch.OutOfMemoryError: CUDA out of memory.\n" if code == 9 else "ValueError: broken\n"))
            return code, self.seconds
        return self.measure_code, self.seconds / 10


class RunTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name
        self.said = []

    def go(self, runner, pairs=(("qwen3", "qwen1.5"),), **options):
        run.run_pairs(self.root, os.path.join(self.root, "compare"), list(pairs), runner=runner, say=self.said.append,
                      **options)

    def status(self, pair=("qwen3", "qwen1.5")):
        return run.load_status(os.path.join(self.root, plan.pair_name(*pair)))

    def test_a_pair_is_trained_then_measured(self):
        runner = Runner()
        self.go(runner)
        status = self.status()
        self.assertEqual(status["state"], "measured")
        self.assertEqual((status["trainSeconds"], status["evalSeconds"]), (3600.0, 360.0))
        self.assertFalse(status["smallBatches"])
        self.assertEqual(len(runner.calls), 2)
        self.assertIn("latent_pairs.evaluate", runner.calls[1])
        self.assertEqual(runner.calls[1][runner.calls[1].index("--pair") + 1], "qwen3:qwen1.5")

    def test_a_measured_pair_is_not_run_again(self):
        self.go(Runner())
        again = Runner()
        self.go(again)
        self.assertEqual(again.calls, [])

    def test_out_of_memory_is_retried_once_at_the_small_batches(self):
        runner = Runner(train=[9, 0])
        self.go(runner)
        status = self.status()
        self.assertEqual(status["state"], "measured")
        self.assertTrue(status["smallBatches"] and status["retriedAfterOutOfMemory"])
        second = runner.calls[1]
        self.assertEqual((second[second.index("--batch1") + 1], second[second.index("--batch2") + 1]), ("2", "1"))
        folder = os.path.join(self.root, "qwen3__qwen1.5")
        self.assertTrue(os.path.exists(os.path.join(folder, "attempt1", "log.jsonl")))
        self.assertEqual(status["trainSeconds"], 7200.0)   # both attempts count against the budget

    def test_out_of_memory_twice_fails_the_pair(self):
        self.go(Runner(train=[9, 9]))
        self.assertEqual(self.status()["state"], "failed")
        self.assertIn("small batches", self.status()["reason"])

    def test_another_error_fails_without_a_retry(self):
        runner = Runner(train=[1])
        self.go(runner)
        self.assertEqual(self.status()["state"], "failed")
        self.assertIn("ValueError: broken", self.status()["reason"])
        self.assertEqual(len(runner.calls), 1)

    def test_a_failed_measurement_keeps_the_mapper_and_is_tried_again(self):
        self.go(Runner(measure=1))
        self.assertEqual(self.status()["state"], "trained")
        again = Runner()
        self.go(again)
        self.assertEqual(self.status()["state"], "measured")
        self.assertEqual(len(again.calls), 1)   # measured only: the training log already ends with `done`
        self.assertIn("latent_pairs.evaluate", again.calls[0])

    def test_an_interrupted_stage_2_resumes_from_the_stage_1_checkpoint(self):
        folder = os.path.join(self.root, "qwen3__qwen1.5")
        os.makedirs(folder)
        with open(os.path.join(folder, "stage1.pt"), "w", encoding="utf-8") as handle:
            handle.write("checkpoint")
        with open(os.path.join(folder, "log.jsonl"), "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"event": "stage2", "step": 100}) + "\n")
        runner = Runner()
        self.go(runner)
        first = runner.calls[0]
        self.assertEqual(first[first.index("--resume") + 1], os.path.join(folder, "stage1.pt"))

    def test_no_pair_starts_once_the_budget_is_used(self):
        pairs = [("qwen3", "qwen1.5"), ("qwen1.5", "qwen3"), ("qwen3", "qwen0.5")]
        runner = Runner(seconds=3600.0 * 10)   # each pair: 10 h of training and 1 h of measuring
        self.go(runner, pairs=pairs, budget=20)
        self.assertEqual([self.status(pair).get("state") for pair in pairs], ["measured", "measured", None])
        self.assertIn("not started", self.said[-1])

    def test_time_of_pairs_run_by_an_earlier_call_counts(self):
        self.go(Runner(seconds=3600.0 * 20), pairs=[("qwen3", "qwen1.5")])
        later = Runner()
        self.go(later, pairs=[("qwen1.5", "qwen3")], budget=20, budget_pairs=[("qwen3", "qwen1.5"), ("qwen1.5", "qwen3")])
        self.assertEqual(later.calls, [])

    def test_pairs_argument_takes_only_batch_pairs(self):
        self.assertEqual(run.parse_pairs("phi3.5:qwen1.5, qwen3:qwen1.5"), [("phi3.5", "qwen1.5"), ("qwen3", "qwen1.5")])
        with self.assertRaises(ValueError):
            run.parse_pairs("mistral7:qwen0.5")


def arm(f1, ms=400.0, **more):
    return {"answer": "a" if f1 else "b", "f1": float(f1), "em": float(f1 == 1), "hit": float(f1 > 0), "ms": ms,
            "bytes": 100, **more}


MAPPED = {"senderTokens": 150, "receiverTokens": 140, "alignMs": 4.0, "senderMs": 80.0, "mapperMs": 50.0, "mappedBytes": 4096}


def groups(count=40):
    main = [{"id": f"m{index}", "group": "main", "passage": f"Passage {index}.", "question": "Q?", "answers": ["a"]}
            for index in range(count)]
    return {"main": main, "long_passage": [], "tiny_passage": [], "non_english_emoji": [], "unanswerable": []}


def latent(items, swat=lambda i: 1.0, mismatched=lambda i: 0.0, zeroed=lambda i: 0.0, checkpoint="ckpt1", skip=()):
    results = {}
    for index, item in enumerate(items["main"]):
        record = {"text_m2b": arm(1.0), "swat": arm(swat(index), **MAPPED), "mismatched": arm(mismatched(index), **MAPPED),
                  "zeroed": arm(zeroed(index), **MAPPED), "t2t_m2b": arm(index % 2, 3000.0)}
        for name in skip:
            record.pop(name)
        results[item["id"]] = record
    return {"checkpoint": checkpoint, "results": results}


class VerdictTest(unittest.TestCase):
    def pair(self, **options):
        items = groups()
        kept = dict(MAPPERS)
        self.addCleanup(lambda: (MAPPERS.clear(), MAPPERS.update(kept)))
        evaluate.register("qwen3", "qwen1.5", None, "ckpt1")
        from latent_compare.report import latent_section
        return latent_section(items, {}, {("qwen3", "qwen1.5"): latent(items, **options)})["qwen3>qwen1.5"], len(items["main"])

    def test_pass_when_both_controls_are_beaten(self):
        verdict = report.verdict(*self.pair(swat=lambda i: float(i % 4 != 0)))
        self.assertTrue(verdict["pass"])
        self.assertEqual(verdict["reasons"], [])
        self.assertEqual(verdict["vsSummary"], report.BETTER)
        self.assertEqual(verdict["vsPassage"], report.WORSE)

    def test_fail_when_the_mismatched_cache_scores_the_same(self):
        verdict = report.verdict(*self.pair(swat=lambda i: float(i % 2), mismatched=lambda i: float(i % 2)))
        self.assertFalse(verdict["pass"])
        self.assertTrue(any("mismatched" in reason for reason in verdict["reasons"]))

    def test_fail_when_the_zeroed_cache_is_as_good(self):
        verdict = report.verdict(*self.pair(swat=lambda i: float(i % 2), zeroed=lambda i: float(i % 2 or i % 3 == 0)))
        self.assertFalse(verdict["pass"])
        self.assertTrue(any("zeroed" in reason for reason in verdict["reasons"]))

    def test_fail_when_a_control_did_not_run_on_every_item(self):
        pair, count = self.pair()
        self.assertTrue(report.verdict(pair, count)["pass"])
        # The same numbers pass on 40 items and cannot pass as a 200-item result.
        self.assertFalse(report.verdict(pair, 200)["pass"])

    def test_fail_when_a_control_is_missing(self):
        verdict = report.verdict(*self.pair(skip=("zeroed",)))
        self.assertFalse(verdict["pass"])

    def test_words(self):
        self.assertEqual(report.word({"low": 0.01, "high": 0.2}), report.BETTER)
        self.assertEqual(report.word({"low": -0.2, "high": -0.01}), report.WORSE)
        self.assertEqual(report.word({"low": -0.01, "high": 0.02}), report.SAME)
        self.assertEqual(report.word({"low": 0.0, "high": 0.2}), report.SAME)   # reaching zero is not above it
        self.assertEqual(report.word(None), report.UNMEASURED)


LOG = [
    {"event": "start", "mapperParams": 100, "alignmentRule": 2},
    {"event": "stage1", "step": 100, "secPerStep": 0.9},
    {"event": "stage1", "step": 8000, "secPerStep": 0.5},
    {"event": "stage1-eval", "step": 8000, "peakAllocatedGiB": 11.0, "peakReservedGiB": 12.5},
    {"event": "stage2-eval", "step": 0, "devF1": 0.9},      # before any stage 2 step: not a result
    {"event": "stage2", "step": 10000, "secPerStep": 0.4},
    {"event": "stage2-eval", "step": 500, "devF1": 0.6, "peakAllocatedGiB": 12.0, "peakReservedGiB": 13.5},
    {"event": "stage2-eval", "step": 1000, "devF1": 0.8, "peakAllocatedGiB": 12.0, "peakReservedGiB": 13.25},
    {"event": "done", "bestDevF1": 0.8},
]


class CostTest(unittest.TestCase):
    def test_cost_from_a_training_log(self):
        cost = report.cost(LOG, {"trainSeconds": 9000, "evalSeconds": 900, "smallBatches": False})
        self.assertEqual((cost["stage1SecPerStep"], cost["stage2SecPerStep"]), (0.5, 0.4))
        self.assertEqual((cost["peakReservedGiB"], cost["peakAllocatedGiB"]), (13.5, 12.0))
        self.assertEqual((cost["bestDevF1"], cost["bestStep"]), (0.8, 1000))
        self.assertEqual((cost["trainHours"], cost["measureHours"]), (2.5, 0.25))

    def test_an_empty_log_costs_nothing(self):
        self.assertEqual(report.cost([]), {})

    def test_estimate_scales_the_steps_and_keeps_the_overhead(self):
        cost = report.cost(LOG, {"trainSeconds": 9000, "evalSeconds": 900})
        # stepping: 8000 * 0.5 + 10000 * 0.4 = 8000 s; overhead: 9900 - 8000 = 1900 s
        self.assertEqual(report.estimate_hours([cost], 8000, 10000), round(9900 / 3600, 1))
        self.assertEqual(report.estimate_hours([cost], 16000, 20000), round((16000 + 1900) / 3600, 1))
        self.assertIsNone(report.estimate_hours([], 8000, 10000))


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name
        self.items = groups()
        self.kept = dict(MAPPERS)

    def folder(self, name, files):
        base = os.path.join(self.root, name)
        os.makedirs(os.path.join(base, "latent"), exist_ok=True)
        with open(os.path.join(base, "items.json"), "w", encoding="utf-8") as handle:
            json.dump(self.items, handle)
        for pair, data in files.items():
            with open(os.path.join(base, "latent", f"{plan.pair_name(*pair)}.json"), "w", encoding="utf-8") as handle:
                json.dump(data, handle)
        return base

    def trained(self, pair, state="measured"):
        base = os.path.join(self.root, plan.pair_name(*pair))
        os.makedirs(base, exist_ok=True)
        with open(os.path.join(base, "log.jsonl"), "w", encoding="utf-8") as handle:
            handle.write("\n".join(json.dumps(row) for row in LOG) + "\n")
        run.save_status(base, {"state": state, "trainSeconds": 9000, "evalSeconds": 900})

    def test_summary_and_table(self):
        first, same, failing = ("phi3.5", "qwen1.5"), ("qwen3", "qwen1.5"), ("qwen3", "qwen0.5")
        compare = self.folder("compare", {
            first: latent(self.items, checkpoint=self.kept[first]["id"]),
            same: latent(self.items, swat=lambda i: float(i % 4 != 0), checkpoint="same1"),
            failing: latent(self.items, swat=lambda i: float(i % 2), mismatched=lambda i: float(i % 2), checkpoint="fail1")})
        repro = self.folder("repro", {first: latent(self.items, swat=lambda i: float(i % 10 != 0), checkpoint="again1")})
        for pair in (first, same, failing):
            self.trained(pair)
        summary = report.build(self.root, compare, repro)
        self.assertEqual(dict(MAPPERS), self.kept)   # reading results leaves the registry as it was
        pairs = summary["pairs"]
        self.assertEqual(pairs["phi3.5>qwen1.5"]["checkpoint"], "again1")   # the batch row is the retrained mapper
        self.assertTrue(pairs["qwen3>qwen1.5"]["verdict"]["pass"])
        self.assertFalse(pairs["qwen3>qwen0.5"]["verdict"]["pass"])
        self.assertEqual(pairs["qwen1.5>qwen3"]["state"], "not started")
        self.assertNotIn("arms", pairs["qwen1.5>qwen3"])
        check = summary["recipeCheck"]
        self.assertEqual(check["registeredCheckpoint"], self.kept[first]["id"])
        self.assertAlmostEqual(check["retrainedMinusRegistered"]["diff"], -0.1)
        self.assertFalse(check["adequate"])   # the interval goes below -0.05
        self.assertEqual(len(summary["notTrained"]), 36)
        self.assertEqual(len(summary["trainableNotInBatch"]), 20 - len(plan.BATCH))
        text = report.render(summary)
        self.assertIn("| qwen3>qwen1.5 | 0.750 [", text)
        self.assertIn("**Fail**: `swat − mismatched` interval reaches zero", text)
        self.assertIn("not adequate", text)
        self.assertIn("26 because a model runs through vLLM only", text)
        self.assertIn("10 because a model has 14 GiB", text)

    def test_a_recipe_within_the_margin_is_adequate(self):
        first = ("phi3.5", "qwen1.5")
        compare = self.folder("compare", {first: latent(self.items, checkpoint=self.kept[first]["id"])})
        repro = self.folder("repro", {first: latent(self.items, checkpoint="again1")})
        self.trained(first)
        self.assertTrue(report.build(self.root, compare, repro)["recipeCheck"]["adequate"])


class RegisterTest(unittest.TestCase):
    def test_register_refuses_what_is_not_a_pair(self):
        kept = dict(MAPPERS)
        self.addCleanup(lambda: (MAPPERS.clear(), MAPPERS.update(kept)))
        for sender, receiver in (("qwen3", "qwen3"), ("nope", "qwen3"), ("qwen3", "nope")):
            with self.assertRaises(ValueError):
                evaluate.register(sender, receiver, "x.pt", "id")
        entry = evaluate.register("qwen3", "qwen1.5", "x.pt", "id1")
        self.assertEqual((entry["id"], entry["card"]), ("id1", "L5"))


if __name__ == "__main__":
    unittest.main()
