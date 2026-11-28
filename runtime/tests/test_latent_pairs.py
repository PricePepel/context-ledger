"""L5: the plan, the batch runner and the report for mappers of more model pairs.

Standard library only, apart from one check of the sigma arithmetic that skips without
torch. Nothing here loads a model or trains: the runner is driven with a stand-in for the
training and measuring processes. Tests named `r1_*` are regression tests for the findings
of the first Codex review (docs/evals.md, L5).
"""
import json
import os
import tempfile
import unittest

from latent_compare import run as harness
from latent_compare.models import MAPPERS, MODELS
from latent_pairs import evaluate, plan, report, run
from latent_transfer.data import END, end_ids, end_marker, single_token

try:
    import torch
    HAVE_TORCH = True
except ImportError:
    HAVE_TORCH = False


class Tokenizer:
    """A tokenizer that knows some special tokens as one id and spells everything else out,
    or, with `unknown`, turns every string it does not know into its one unknown token."""

    def __init__(self, specials, eos_token=None, unknown=None, eos_token_id="from specials"):
        self.specials, self.eos_token, self.unk_token = list(specials), eos_token, unknown
        self.unk_token_id = 1000 + self.specials.index(unknown) if unknown else None
        self.eos_token_id = (1000 + self.specials.index(eos_token) if eos_token in self.specials else None) \
            if eos_token_id == "from specials" else eos_token_id

    def __call__(self, text, add_special_tokens=False):
        if self.unk_token and text not in self.specials:
            return {"input_ids": [self.unk_token_id]}
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
        tokenizer = Tokenizer([END, "<|endoftext|>"], eos_token="<|endoftext|>")
        self.assertEqual(end_marker(tokenizer), END)
        self.assertEqual(end_ids(tokenizer), {1000, 1001})   # what the pair stopped at before this card

    def test_a_receiver_without_im_end_gets_its_own_end_token(self):
        # Phi-3.5, Granite and Mistral spell <|im_end|> out; taught to write it they never stop.
        self.assertEqual(end_marker(Tokenizer(["<|endoftext|>"], eos_token="<|endoftext|>")), "<|endoftext|>")
        self.assertEqual(end_marker(Tokenizer(["</s>"], eos_token="</s>")), "</s>")
        self.assertEqual(end_ids(Tokenizer(["</s>"], eos_token="</s>")), {1000})

    def test_a_tokenizer_with_neither_is_refused(self):
        with self.assertRaises(ValueError):
            end_marker(Tokenizer([], eos_token=None))
        with self.assertRaises(ValueError):   # an end token it cannot write as one token is no end token
            end_marker(Tokenizer([], eos_token="<eos>"))

    def test_r1_10_an_unknown_token_does_not_pass_for_im_end(self):
        # This tokenizer writes any string it does not know as <unk>: one token, but not the marker.
        tokenizer = Tokenizer(["<unk>", "</s>"], eos_token="</s>", unknown="<unk>")
        self.assertIsNone(single_token(tokenizer, END))
        self.assertEqual(end_marker(tokenizer), "</s>")
        self.assertEqual(end_ids(tokenizer), {1001})

    def test_r1_10_one_token_for_end_and_unknown_is_still_an_end_token(self):
        # GPT-2 style (Granite): <|end_of_text|> is the end, the unknown and the padding token.
        tokenizer = Tokenizer(["<|end_of_text|>"], eos_token="<|end_of_text|>", unknown="<|end_of_text|>")
        self.assertEqual(end_marker(tokenizer), "<|end_of_text|>")
        self.assertEqual(end_ids(tokenizer), {1000})

    def test_r1_10_no_none_among_the_stop_ids(self):
        tokenizer = Tokenizer([END], eos_token=None, eos_token_id=None)
        self.assertEqual(end_ids(tokenizer), {1000})


class PlanTest(unittest.TestCase):
    def test_pairs_of_eight_models(self):
        self.assertEqual(len(plan.ordered_pairs()), 56)
        self.assertEqual(len(plan.trainable_pairs()), 20)
        self.assertIn(("phi3.5", "qwen1.5"), plan.trainable_pairs())

    def test_the_batch_is_trainable_and_starts_with_the_m2b_s_pair(self):
        self.assertEqual(plan.BATCH[0], ("phi3.5", "qwen1.5"))
        self.assertIn(plan.BATCH[0], MAPPERS)   # the pair with a registered checkpoint to check against
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


def arm(f1, ms=400.0, **more):
    return {"answer": "a" if f1 else "b", "f1": float(f1), "em": float(f1 == 1), "hit": float(f1 > 0), "ms": ms,
            "bytes": 100, **more}


MAPPED = {"senderTokens": 150, "receiverTokens": 140, "alignMs": 4.0, "senderMs": 80.0, "mapperMs": 50.0, "mappedBytes": 4096}
COUNT = 40
FIRST, SAME, SMALL = ("phi3.5", "qwen1.5"), ("qwen3", "qwen1.5"), ("qwen3", "qwen0.5")
BATCH = [FIRST, SAME, SMALL]
REGISTERED = MAPPERS[FIRST]["id"]


def groups(count=COUNT):
    main = [{"id": f"m{index}", "group": "main", "passage": f"Passage {index}.", "question": "Q?", "answers": ["a"]}
            for index in range(count)]
    return {"main": main, "long_passage": [], "tiny_passage": [], "non_english_emoji": [], "unanswerable": []}


ITEMS = groups()
ITEMS_ID = harness.fingerprint(ITEMS)


def latent(swat=lambda i: 1.0, mismatched=lambda i: 0.0, zeroed=lambda i: 0.0, checkpoint="ckpt1", skip=(), no_summary=(),
           items=ITEMS, items_id=ITEMS_ID):
    results = {}
    for index, item in enumerate(items["main"]):
        record = {"text_m2b": arm(1.0), "swat": arm(swat(index), **MAPPED), "mismatched": arm(mismatched(index), **MAPPED),
                  "zeroed": arm(zeroed(index), **MAPPED), "t2t_m2b": arm(index % 2, 3000.0)}
        for name in skip:
            record.pop(name)
        if index in no_summary:
            record["t2t_m2b"] = {"error": "ValueError: The sender's summary of this item is missing or failed."}
        results[item["id"]] = record
    return {"itemsId": items_id, "checkpoint": checkpoint, "results": results}


def receive(text=lambda i: 1.0):
    return {"itemsId": ITEMS_ID, "results": {item["id"]: {"text": arm(text(index))} for index, item in enumerate(ITEMS["main"])}}


LOG = [
    {"event": "start", "mapperParams": 100, "alignmentRule": 2, "time": 0},
    {"event": "stage1", "step": 100, "secPerStep": 0.9, "time": 1},
    {"event": "stage1", "step": 8000, "secPerStep": 0.5, "time": 2},
    {"event": "stage1-eval", "step": 8000, "peakAllocatedGiB": 11.0, "peakReservedGiB": 12.5, "time": 3},
    {"event": "stage2-eval", "step": 0, "devF1": 0.9, "time": 4},      # before any stage 2 step: not a result
    {"event": "stage2", "step": 10000, "secPerStep": 0.4, "time": 5},
    {"event": "stage2-eval", "step": 500, "devF1": 0.6, "peakAllocatedGiB": 12.0, "peakReservedGiB": 13.5, "time": 6},
    {"event": "saved", "path": "best.pt", "id": "early", "devF1": 0.6, "time": 6.5},
    {"event": "stage2-eval", "step": 1000, "devF1": 0.8, "peakAllocatedGiB": 12.0, "peakReservedGiB": 13.25, "time": 7},
    {"event": "saved", "path": "best.pt", "id": "kept", "devF1": 0.8, "time": 7.5},
    {"event": "done", "bestDevF1": 0.8, "time": 8},
]


class Runner:
    """Stands in for the training and measuring processes: writes what they would leave."""

    def __init__(self, train=None, measure=0, seconds=3600.0, results=None, write_result=True):
        self.train_codes, self.measure_code, self.seconds, self.calls = list(train or [0]), measure, seconds, []
        self.results, self.write_result, self.trained = results or {}, write_result, 0

    def __call__(self, command, log_path):
        self.calls.append(command)
        if "latent_transfer.train" in command:
            folder = command[command.index("--out") + 1]
            code = self.train_codes.pop(0) if self.train_codes else 0
            self.trained += 1
            with open(os.path.join(folder, "log.jsonl"), "a", encoding="utf-8") as handle:
                rows = LOG if code == 0 else LOG[:3] + ([{"event": "diverged", "stage": 1, "step": 9}] if code == 3 else [])
                handle.write("".join(json.dumps(row) + "\n" for row in rows))
            if code == 0:
                with open(os.path.join(folder, "best.pt"), "w", encoding="utf-8") as handle:
                    handle.write(f"weights of training run {self.trained} in {folder}")
            with open(log_path, "a", encoding="utf-8") as handle:
                handle.write({0: "ok\n", 9: "torch.OutOfMemoryError: CUDA out of memory.\n"}.get(code, "ValueError: broken\n"))
            return code, self.seconds
        if self.measure_code == 0 and self.write_result:
            out, pair = command[command.index("--out") + 1], tuple(command[command.index("--pair") + 1].split(":"))
            target = os.path.join(out, "latent", f"{plan.pair_name(*pair)}.json")
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as handle:
                json.dump(self.results.get(pair) or latent(checkpoint=f"id-{pair[0]}-{pair[1]}-{len(self.calls)}"), handle)
        return self.measure_code, self.seconds / 10


class Folders(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name
        self.compare, self.repro = os.path.join(self.root, "compare"), os.path.join(self.root, "repro")
        for base in (self.compare, self.repro):
            os.makedirs(os.path.join(base, "latent"))
            os.makedirs(os.path.join(base, "receive"))
            self.write(os.path.join(base, "items.json"), ITEMS)
        self.write(run.result_path(self.compare, *FIRST), latent(checkpoint=REGISTERED))
        self.said = []

    def write(self, target, data):
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(data, handle)

    def go(self, runner, pairs=None, decide=None, **options):
        run.run_batch(self.root, self.compare, self.repro, pairs, runner=runner, say=self.said.append, batch=BATCH,
                      items_id=ITEMS_ID, decide=decide or (lambda *_: {"adequate": True, "fullSteps": False}), **options)

    def folder(self, pair):
        return os.path.join(self.root, plan.pair_name(*pair))

    def status(self, pair=SAME):
        return run.load_status(self.folder(pair))

    def build(self):
        return report.build(self.root, self.compare, self.repro, batch=BATCH, items_id=ITEMS_ID, main_items=COUNT)


class RunTest(Folders):
    def test_a_pair_is_trained_then_measured(self):
        runner = Runner()
        self.go(runner, pairs=[SAME])
        status = self.status()
        self.assertEqual(status["state"], "measured")
        self.assertEqual((status["trainSeconds"], status["evalSeconds"]), (3600.0, 360.0))
        self.assertFalse(status["smallBatches"])
        self.assertNotIn("running", status)
        self.assertEqual(len(runner.calls), 2)
        self.assertIn("latent_pairs.evaluate", runner.calls[1])
        self.assertEqual(runner.calls[1][runner.calls[1].index("--pair") + 1], "qwen3:qwen1.5")
        self.assertEqual(runner.calls[1][runner.calls[1].index("--out") + 1], self.compare)

    def test_the_first_pair_is_measured_beside_the_registered_result_not_over_it(self):
        runner = Runner()
        self.go(runner, pairs=[FIRST])
        self.assertEqual(runner.calls[1][runner.calls[1].index("--out") + 1], self.repro)
        self.assertEqual(run.load_json(run.result_path(self.compare, *FIRST))["checkpoint"], REGISTERED)

    def test_a_measured_pair_is_not_run_again(self):
        self.go(Runner(), pairs=[SAME])
        again = Runner()
        self.go(again, pairs=[SAME])
        self.assertEqual(again.calls, [])

    def test_out_of_memory_is_retried_once_at_the_small_batches(self):
        runner = Runner(train=[9, 0])
        self.go(runner, pairs=[SAME])
        status = self.status()
        self.assertEqual(status["state"], "measured")
        self.assertTrue(status["smallBatches"] and status["retriedAfterOutOfMemory"])
        second = runner.calls[1]
        self.assertEqual((second[second.index("--batch1") + 1], second[second.index("--batch2") + 1]), ("2", "1"))
        self.assertTrue(os.path.exists(os.path.join(self.folder(SAME), "attempt1", "log.jsonl")))
        self.assertEqual(status["trainSeconds"], 7200.0)   # both attempts count against the budget

    def test_out_of_memory_twice_fails_the_pair(self):
        self.go(Runner(train=[9, 9]), pairs=[SAME])
        self.assertEqual(self.status()["state"], "failed")
        self.assertIn("small batches", self.status()["reason"])

    def test_another_error_fails_without_a_retry(self):
        runner = Runner(train=[1])
        self.go(runner, pairs=[SAME])
        self.assertEqual(self.status()["state"], "failed")
        self.assertIn("ValueError: broken", self.status()["reason"])
        self.assertEqual(len(runner.calls), 1)

    def test_a_failed_measurement_keeps_the_mapper_and_is_tried_again(self):
        self.go(Runner(measure=1), pairs=[SAME])
        self.assertEqual(self.status()["state"], "trained")
        again = Runner()
        self.go(again, pairs=[SAME])
        self.assertEqual(self.status()["state"], "measured")
        self.assertEqual(len(again.calls), 1)   # measured only: the training log already ends with `done`
        self.assertIn("latent_pairs.evaluate", again.calls[0])

    def test_an_interrupted_stage_2_resumes_from_the_stage_1_checkpoint(self):
        os.makedirs(self.folder(SAME))
        with open(os.path.join(self.folder(SAME), "stage1.pt"), "w", encoding="utf-8") as handle:
            handle.write("checkpoint")
        with open(os.path.join(self.folder(SAME), "log.jsonl"), "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"event": "stage2", "step": 100}) + "\n")
        runner = Runner()
        self.go(runner, pairs=[SAME])
        first = runner.calls[0]
        self.assertEqual(first[first.index("--resume") + 1], os.path.join(self.folder(SAME), "stage1.pt"))
        self.assertEqual(self.status()["stage2Restarts"], 1)

    def test_no_pair_starts_once_the_budget_is_used(self):
        runner = Runner(seconds=3600.0 * 10)   # each pair: 10 h of training and 1 h of measuring
        self.go(runner, budget=20)
        self.assertEqual([self.status(pair).get("state") for pair in BATCH], ["measured", "measured", None])
        self.assertIn("not started", self.said[-1])

    def test_time_of_pairs_run_by_an_earlier_call_counts(self):
        self.go(Runner(seconds=3600.0 * 20), pairs=[FIRST])
        later = Runner()
        self.go(later, pairs=[SAME], budget=20)
        self.assertEqual(later.calls, [])

    def test_pairs_argument_takes_only_batch_pairs(self):
        self.assertEqual(run.parse_pairs("phi3.5:qwen1.5, qwen3:qwen1.5"), [("phi3.5", "qwen1.5"), ("qwen3", "qwen1.5")])
        with self.assertRaises(ValueError):
            run.parse_pairs("mistral7:qwen0.5")

    # Codex review, round 1 -------------------------------------------------
    def test_r1_3_every_measurement_is_forced_and_tied_to_the_checkpoint_file(self):
        runner = Runner()
        self.go(runner, pairs=[SAME])
        self.assertIn("--force", runner.calls[1])
        result = self.status()["result"]
        self.assertEqual(result["sha256"], run.sha256_file(run.result_path(self.compare, *SAME)))
        self.assertEqual(result["checkpointSha256"], run.sha256_file(os.path.join(self.folder(SAME), "best.pt")))
        self.assertEqual(result["itemsId"], ITEMS_ID)

    def test_r1_3_a_measured_pair_is_measured_again_when_its_result_or_checkpoint_changed(self):
        self.go(Runner(), pairs=[SAME])
        self.write(run.result_path(self.compare, *SAME), latent(checkpoint="someone-else"))
        again = Runner()
        self.go(again, pairs=[SAME])
        self.assertEqual(len(again.calls), 1)
        self.assertIn("latent_pairs.evaluate", again.calls[0])
        with open(os.path.join(self.folder(SAME), "best.pt"), "w", encoding="utf-8") as handle:
            handle.write("other weights with the same id")
        third = Runner()
        self.go(third, pairs=[SAME])
        self.assertEqual(len(third.calls), 1)

    def test_r1_3_a_result_in_another_run_folder_does_not_count(self):
        self.go(Runner(), pairs=[SAME])
        other = os.path.join(self.root, "other")
        again = Runner()
        run.run_batch(self.root, other, self.repro, [SAME], runner=again, say=self.said.append, batch=BATCH,
                      items_id=ITEMS_ID, decide=lambda *_: {"adequate": True, "fullSteps": False})
        self.assertEqual(len(again.calls), 1)
        self.assertEqual(again.calls[0][again.calls[0].index("--out") + 1], other)

    def test_r1_3_a_measurement_that_left_no_file_or_another_item_set_is_not_measured(self):
        self.go(Runner(write_result=False), pairs=[SAME])
        self.assertEqual(self.status()["state"], "trained")
        self.assertIn("no result file", self.status()["reason"])
        self.go(Runner(results={SAME: latent(items_id="another-set")}), pairs=[SAME])
        self.assertEqual(self.status()["state"], "trained")
        self.assertIn("another-set", self.status()["reason"])

    def test_r1_4_no_second_pair_before_the_recipe_is_decided(self):
        def undecided(*_):
            raise ValueError("the retrained phi3.5>qwen1.5 is not measured")
        runner = Runner(measure=1)   # the first pair trains, its measurement fails
        self.go(runner, decide=undecided)
        self.assertEqual(self.status(FIRST)["state"], "trained")
        self.assertEqual(self.status(SAME), {})
        self.assertEqual(self.status(SMALL), {})
        self.assertIn("the recipe is not decided", self.said[-1])
        self.assertFalse(os.path.exists(os.path.join(self.root, run.RECIPE_FILE)))

    def test_r1_4_a_recipe_that_is_not_adequate_brings_the_full_steps_back(self):
        runner = Runner()
        self.go(runner, decide=lambda *_: {"adequate": False, "fullSteps": True})
        first, second = runner.calls[0], runner.calls[2]
        self.assertEqual(first[first.index("--stage1-steps") + 1], "8000")     # the check itself uses the recipe
        self.assertEqual(second[second.index("--stage1-steps") + 1], "15000")
        self.assertEqual(second[second.index("--stage2-steps") + 1], "20000")
        self.assertTrue(self.status(SAME)["fullSteps"])
        self.assertTrue(run.load_json(os.path.join(self.root, run.RECIPE_FILE))["fullSteps"])

    def test_r1_4_the_decision_is_made_once_and_kept(self):
        calls = []

        def decide(*_):
            calls.append(1)
            return {"adequate": True, "fullSteps": False}
        self.go(Runner(), decide=decide)
        self.go(Runner(), decide=decide)
        self.assertEqual(len(calls), 1)

    def test_r1_5_an_interruption_while_the_first_attempt_is_set_aside_does_not_bring_it_back(self):
        folder = self.folder(SAME)
        os.makedirs(os.path.join(folder, "attempt1"))
        # Cut off after the log had been moved and before stage1.pt was: the status already says retry.
        self.write(os.path.join(folder, "attempt1", "log.jsonl"), {"event": "start"})
        with open(os.path.join(folder, "stage1.pt"), "w", encoding="utf-8") as handle:
            handle.write("first attempt's checkpoint")
        run.save_status(folder, {"state": "training", "smallBatches": True, "retriedAfterOutOfMemory": True, "retry": "moving"})
        runner = Runner()
        self.go(runner, pairs=[SAME])
        first = runner.calls[0]
        self.assertNotIn("--resume", first)   # the first attempt's stage 1 is not carried into the retry
        self.assertEqual((first[first.index("--batch1") + 1], first[first.index("--batch2") + 1]), ("2", "1"))
        self.assertTrue(os.path.exists(os.path.join(folder, "attempt1", "stage1.pt")))
        self.assertEqual(self.status()["retry"], "ready")

    def test_r1_5_setting_aside_twice_keeps_the_first_copy(self):
        folder = self.folder(SAME)
        os.makedirs(os.path.join(folder, "attempt1"))
        for where, text in ((os.path.join(folder, "attempt1"), "moved"), (folder, "left behind")):
            with open(os.path.join(where, "train.out"), "w", encoding="utf-8") as handle:
                handle.write(text)
        run.set_aside(folder)
        with open(os.path.join(folder, "attempt1", "train.out"), encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "moved")
        self.assertFalse(os.path.exists(os.path.join(folder, "train.out")))

    def test_r1_6_a_log_line_cut_off_by_an_interruption_is_left_out(self):
        folder = self.folder(SAME)
        os.makedirs(folder)
        with open(os.path.join(folder, "log.jsonl"), "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"event": "start"}) + "\n" + '{"event": "stage1", "step": 1')
        self.assertEqual(run.read_log(folder), [{"event": "start"}])
        self.assertFalse(run.finished(folder))
        self.assertEqual(report.cost(run.read_log(folder))["trainerStarts"], 1)

    def test_r1_7_the_time_of_a_run_that_was_cut_off_counts(self):
        folder = self.folder(SAME)
        os.makedirs(folder)
        log = os.path.join(folder, "train.out")
        with open(log, "w", encoding="utf-8") as handle:
            handle.write("step 5000\n")
        seen = os.path.getmtime(log)
        run.save_status(folder, {"state": "training", "trainSeconds": 100.0,
                                 "running": {"kind": "train", "startedAt": seen - 5 * 3600, "log": "train.out"}})
        self.assertAlmostEqual(run.hours_used(self.root, BATCH), 5 + 100 / 3600, places=3)
        status = self.status()
        self.assertNotIn("running", status)
        self.assertEqual(status["interrupted"], 1)
        self.assertAlmostEqual(run.hours_used(self.root, BATCH), 5 + 100 / 3600, places=3)   # charged once

    def test_r1_7_the_start_is_written_down_before_the_process_runs(self):
        seen = []

        def runner(command, log_path):
            seen.append(run.load_status(self.folder(SAME)).get("running"))
            return Runner()(command, log_path)
        self.go(runner, pairs=[SAME])
        self.assertEqual([entry["kind"] for entry in seen], ["train", "eval"])

    def test_r1_8_a_run_that_diverged_fails_even_with_a_checkpoint(self):
        folder = self.folder(SAME)
        os.makedirs(folder)
        with open(os.path.join(folder, "best.pt"), "w", encoding="utf-8") as handle:
            handle.write("an early checkpoint that scored well")
        runner = Runner(train=[3])
        self.go(runner, pairs=[SAME])
        self.assertEqual(self.status()["state"], "failed")
        self.assertIn("diverged", self.status()["reason"])
        self.assertEqual(len(runner.calls), 1)   # never measured


class VerdictTest(unittest.TestCase):
    def pair(self, **options):
        with report.registered({SAME: "ckpt1"}):
            from latent_compare.report import latent_section
            return latent_section(ITEMS, {}, {SAME: latent(**options)})["qwen3>qwen1.5"]

    def test_pass_when_both_controls_are_beaten(self):
        verdict = report.verdict(self.pair(swat=lambda i: float(i % 4 != 0)), COUNT)
        self.assertTrue(verdict["pass"])
        self.assertEqual(verdict["reasons"], [])
        self.assertEqual(verdict["vsSummary"], report.BETTER)
        self.assertEqual(verdict["vsPassage"], report.WORSE)

    def test_fail_when_the_mismatched_cache_scores_the_same(self):
        verdict = report.verdict(self.pair(swat=lambda i: float(i % 2), mismatched=lambda i: float(i % 2)), COUNT)
        self.assertFalse(verdict["pass"])
        self.assertTrue(any("mismatched" in reason for reason in verdict["reasons"]))

    def test_fail_when_the_zeroed_cache_is_as_good(self):
        verdict = report.verdict(self.pair(swat=lambda i: float(i % 2), zeroed=lambda i: float(i % 2 or i % 3 == 0)), COUNT)
        self.assertFalse(verdict["pass"])
        self.assertTrue(any("zeroed" in reason for reason in verdict["reasons"]))

    def test_fail_when_a_control_is_missing(self):
        self.assertFalse(report.verdict(self.pair(skip=("zeroed",)), COUNT)["pass"])

    def test_r1_2_a_short_item_set_cannot_pass_as_the_200_item_result(self):
        pair = self.pair()
        self.assertTrue(report.verdict(pair, COUNT)["pass"])
        verdict = report.verdict(pair)   # the rule's own size
        self.assertFalse(verdict["pass"])
        self.assertIn("the main set has 40 items, not 200", verdict["reasons"])

    def test_r1_8_a_comparison_over_fewer_items_says_so(self):
        verdict = report.verdict(self.pair(swat=lambda i: float(i % 4 != 0), no_summary={0, 1, 2}), COUNT)
        self.assertTrue(verdict["pass"])   # the pass rule's own arms ran on every item
        self.assertEqual(verdict["vsSummary"], "not measured (37 of 40 items)")

    def test_words(self):
        self.assertEqual(report.word({"low": 0.01, "high": 0.2}), report.BETTER)
        self.assertEqual(report.word({"low": -0.2, "high": -0.01}), report.WORSE)
        self.assertEqual(report.word({"low": -0.01, "high": 0.02}), report.SAME)
        self.assertEqual(report.word({"low": 0.0, "high": 0.2}), report.SAME)   # reaching zero is not above it
        self.assertEqual(report.word(None), report.UNMEASURED)


class CostTest(unittest.TestCase):
    def test_cost_from_a_training_log(self):
        cost = report.cost(LOG, {"trainSeconds": 9000, "evalSeconds": 900, "smallBatches": False})
        self.assertEqual((cost["stage1SecPerStep"], cost["stage2SecPerStep"]), (0.5, 0.4))
        self.assertEqual((cost["peakReservedGiB"], cost["peakAllocatedGiB"]), (13.5, 12.0))
        self.assertEqual((cost["bestDevF1"], cost["bestStep"], cost["bestCheckpoint"]), (0.8, 1000, "kept"))
        self.assertEqual((cost["trainHours"], cost["measureHours"]), (2.5, 0.25))

    def test_an_empty_log_costs_nothing(self):
        self.assertEqual(report.cost([]), {"trainerStarts": 0})

    def test_r1_6_a_restarted_stage_2_is_not_credited_with_the_cut_off_run_s_score(self):
        restarted = LOG[:-1] + [   # cut off after scoring 0.8, then stage 2 again from stage 1
            {"event": "start", "mapperParams": 100, "alignmentRule": 2, "time": 20},
            {"event": "stage2", "step": 10000, "secPerStep": 0.45, "time": 21},
            {"event": "stage2-eval", "step": 500, "devF1": 0.7, "time": 22},
            {"event": "saved", "path": "best.pt", "id": "second", "devF1": 0.7, "time": 22.5},
            {"event": "done", "bestDevF1": 0.7, "time": 23}]
        cost = report.cost(restarted)
        self.assertEqual((cost["bestDevF1"], cost["bestStep"], cost["bestCheckpoint"]), (0.7, 500, "second"))
        self.assertEqual(cost["stage2SecPerStep"], 0.45)
        self.assertEqual(cost["stage1SecPerStep"], 0.5)   # stage 1 ran once, in the first part
        self.assertEqual(cost["trainerStarts"], 2)

    def test_estimate_scales_the_steps_and_keeps_the_overhead(self):
        cost = report.cost(LOG, {"trainSeconds": 9000, "evalSeconds": 900})
        # stepping: 8000 * 0.5 + 10000 * 0.4 = 8000 s; overhead: 9900 - 8000 = 1900 s
        self.assertEqual(report.estimate_hours([cost], 8000, 10000), round(9900 / 3600, 1))
        self.assertEqual(report.estimate_hours([cost], 16000, 20000), round((16000 + 1900) / 3600, 1))
        self.assertIsNone(report.estimate_hours([], 8000, 10000))


class BuildTest(Folders):
    def measured(self, results, **options):
        self.go(Runner(results=results), **options)

    def test_summary_and_table(self):
        self.write(os.path.join(self.compare, "receive", "qwen1.5.json"), receive(text=lambda i: float(i % 2)))
        self.measured({FIRST: latent(swat=lambda i: float(i % 10 != 0), checkpoint="again1"),
                       SAME: latent(swat=lambda i: float(i % 4 != 0), checkpoint="same1"),
                       SMALL: latent(swat=lambda i: float(i % 2), mismatched=lambda i: float(i % 2), checkpoint="fail1")},
                      decide=lambda *a: report.recipe_decision(*a, batch=BATCH, items_id=ITEMS_ID, main_items=COUNT))
        kept = dict(MAPPERS)
        summary = self.build()
        self.assertEqual(dict(MAPPERS), kept)   # reading results leaves the registry as it was
        pairs = summary["pairs"]
        self.assertEqual(pairs["phi3.5>qwen1.5"]["checkpoint"], "again1")   # the batch row is the retrained mapper
        self.assertTrue(pairs["qwen3>qwen1.5"]["verdict"]["pass"])
        self.assertFalse(pairs["qwen3>qwen0.5"]["verdict"]["pass"])
        check = summary["recipeCheck"]
        self.assertEqual((check["registeredCheckpoint"], check["retrainedCheckpoint"]), (REGISTERED, "again1"))
        self.assertAlmostEqual(check["retrainedMinusRegistered"]["diff"], -0.1)
        self.assertFalse(check["adequate"])   # the interval goes below -0.05
        self.assertTrue(summary["recipeDecision"]["fullSteps"])
        self.assertEqual(pairs["qwen3>qwen1.5"]["cost"]["fullSteps"], True)
        self.assertEqual(len(summary["notTrained"]), 36)
        self.assertEqual(len(summary["trainableNotInBatch"]), 20 - len(BATCH))
        text = report.render(summary)
        self.assertIn("| qwen3>qwen1.5 | 0.750 [", text)
        self.assertIn("**Fail**: `swat − mismatched` interval reaches zero", text)
        self.assertIn("not adequate", text)
        self.assertIn("26 because a model runs through vLLM only", text)
        self.assertIn("10 because a model has 14 GiB", text)

    def test_a_recipe_within_the_margin_is_adequate(self):
        self.measured({FIRST: latent(checkpoint="again1")}, pairs=[FIRST])
        decision = report.recipe_decision(self.root, self.compare, self.repro, batch=BATCH, items_id=ITEMS_ID, main_items=COUNT)
        self.assertTrue(decision["adequate"])
        self.assertFalse(decision["fullSteps"])

    # Codex review, round 1 -------------------------------------------------
    def test_r1_1_the_registered_result_is_not_an_l5_row(self):
        # Nothing trained: the compare folder holds only the registered M2b-S result.
        summary = self.build()
        entry = summary["pairs"]["phi3.5>qwen1.5"]
        self.assertEqual(entry["state"], "not started")
        self.assertNotIn("verdict", entry)
        self.assertNotIn("arms", entry)
        self.assertIn("is not measured", summary["recipeCheck"]["notMade"])
        self.assertNotIn("**Pass**", report.render(summary))

    def test_r1_1_a_result_file_replaced_after_the_measurement_gets_no_verdict(self):
        self.measured({SAME: latent(checkpoint="same1")}, pairs=[SAME])
        self.assertTrue(self.build()["pairs"]["qwen3>qwen1.5"]["verdict"]["pass"])
        self.write(run.result_path(self.compare, *SAME), latent(checkpoint="an-older-passing-file"))
        entry = self.build()["pairs"]["qwen3>qwen1.5"]
        self.assertNotIn("verdict", entry)
        self.assertIn("not the one recorded", entry["notVerified"])
        self.assertIn("not verified", report.render(self.build()))

    def test_r1_1_a_failed_pair_gets_no_verdict_from_an_old_file(self):
        self.write(run.result_path(self.compare, *SAME), latent(checkpoint="old-pass"))
        self.go(Runner(train=[1]), pairs=[SAME])
        entry = self.build()["pairs"]["qwen3>qwen1.5"]
        self.assertEqual(entry["state"], "failed")
        self.assertNotIn("verdict", entry)

    def test_r1_1_the_recipe_check_needs_the_registered_checkpoint_and_a_different_one(self):
        self.measured({FIRST: latent(checkpoint="again1")}, pairs=[FIRST])
        self.write(run.result_path(self.compare, *FIRST), latent(checkpoint="not-the-registered-one"))
        with self.assertRaisesRegex(ValueError, "not the registered"):
            report.recipe_decision(self.root, self.compare, self.repro, batch=BATCH, items_id=ITEMS_ID, main_items=COUNT)
        self.write(run.result_path(self.compare, *FIRST), latent(checkpoint=REGISTERED))
        self.go(Runner(results={FIRST: latent(checkpoint=REGISTERED)}, measure=0), pairs=[FIRST])
        self.write(run.result_path(self.repro, *FIRST), latent(checkpoint=REGISTERED))
        with self.assertRaises(ValueError):
            report.recipe_decision(self.root, self.compare, self.repro, batch=BATCH, items_id=ITEMS_ID, main_items=COUNT)

    def test_r1_2_another_item_set_is_refused(self):
        self.measured({SAME: latent(checkpoint="same1")}, pairs=[SAME])
        with self.assertRaisesRegex(ValueError, "not L2's"):
            report.build(self.root, self.compare, self.repro, batch=BATCH, main_items=COUNT)   # the pinned L2 set
        with self.assertRaisesRegex(ValueError, "distinct main items"):
            report.build(self.root, self.compare, self.repro, batch=BATCH, items_id=ITEMS_ID)  # 200 items needed
        self.assertEqual((plan.ITEMS_ID, plan.MAIN_ITEMS), ("62078721512a88db", 200))

    def test_r1_2_the_recipe_check_needs_every_item_on_both_sides(self):
        self.measured({FIRST: latent(checkpoint="again1")}, pairs=[FIRST])
        half = latent(checkpoint=REGISTERED)
        for item in ITEMS["main"][1:]:
            half["results"].pop(item["id"])
        self.write(run.result_path(self.compare, *FIRST), half)
        with self.assertRaisesRegex(ValueError, "only 1 of 40 items"):
            report.recipe_decision(self.root, self.compare, self.repro, batch=BATCH, items_id=ITEMS_ID, main_items=COUNT)

    def test_r1_11_the_registry_is_put_back_after_an_error(self):
        kept = dict(MAPPERS)
        with self.assertRaises(RuntimeError):
            with report.registered({FIRST: "retrained", SAME: "new"}):
                self.assertEqual(MAPPERS[FIRST]["id"], "retrained")
                raise RuntimeError("the reader failed")
        self.assertEqual(dict(MAPPERS), kept)

    def test_r1_12_hit_rate_against_the_receiver_s_own_template(self):
        self.write(os.path.join(self.compare, "receive", "qwen1.5.json"), receive(text=lambda i: float(i % 2)))
        self.measured({SAME: latent(checkpoint="same1")}, pairs=[SAME])
        entry = self.build()["pairs"]["qwen3>qwen1.5"]
        hit = entry["intervals"]["swat-harness_text"]["hit"]
        self.assertEqual((hit["n"], hit["diff"]), (COUNT, 0.5))
        self.assertEqual(entry["verdict"]["vsHarnessTextHit"], report.BETTER)
        self.assertIn("hit: `swat − text` (harness)", report.render(self.build()))

    def test_r1_12_harness_answers_from_another_item_set_are_not_compared(self):
        other = receive()
        other["itemsId"] = "another-set"
        self.write(os.path.join(self.compare, "receive", "qwen1.5.json"), other)
        self.measured({SAME: latent(checkpoint="same1")}, pairs=[SAME])
        verdict = self.build()["pairs"]["qwen3>qwen1.5"]["verdict"]
        self.assertEqual((verdict["vsHarnessText"], verdict["vsHarnessTextHit"]), (report.UNMEASURED, report.UNMEASURED))


class ReaderTest(unittest.TestCase):
    """A result file read as the current result without the checks another path makes is the
    mistake L2's review found six times and this card's review found twice more (round 1,
    findings 1 and 3). So the report has one reader per kind of result, and this fails when
    a result file is opened anywhere else."""

    def functions_calling(self, module, name):
        import ast
        with open(os.path.join(os.path.dirname(__file__), "..", "latent_pairs", module), encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
        found = set()
        for function in [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)]:
            for node in ast.walk(function):
                if isinstance(node, ast.Call) and getattr(node.func, "id", getattr(node.func, "attr", None)) == name:
                    found.add(function.name)
        return found

    def test_the_report_reads_a_latent_result_only_through_its_two_checked_readers(self):
        self.assertEqual(self.functions_calling("report.py", "result_path"), {"measured_pair", "recipe_check"})
        self.assertEqual(self.functions_calling("report.py", "latent_section"), {"pair_section"})
        self.assertEqual(self.functions_calling("report.py", "pair_section"), {"build"})

    def test_the_runner_takes_a_pair_as_measured_only_through_bound(self):
        self.assertEqual(self.functions_calling("run.py", "bound"), {"run_pair"})
        self.assertEqual(self.functions_calling("report.py", "bound"), {"measured_pair"})


class RegisterTest(unittest.TestCase):
    def test_register_refuses_what_is_not_a_pair(self):
        kept = dict(MAPPERS)
        self.addCleanup(lambda: (MAPPERS.clear(), MAPPERS.update(kept)))
        for sender, receiver in (("qwen3", "qwen3"), ("nope", "qwen3"), ("qwen3", "nope")):
            with self.assertRaises(ValueError):
                evaluate.register(sender, receiver, "x.pt", "id")
        entry = evaluate.register("qwen3", "qwen1.5", "x.pt", "id1")
        self.assertEqual((entry["id"], entry["card"]), ("id1", "L5"))


class TrainerSourceTest(unittest.TestCase):
    """What the trainer must keep doing; it only runs on the GPU, so these read its source."""

    def source(self, name):
        with open(os.path.join(os.path.dirname(__file__), "..", "latent_transfer", name), encoding="utf-8") as handle:
            return handle.read()

    def test_r1_6_checkpoints_are_moved_into_place(self):
        source = self.source("pair.py")
        self.assertIn('path + ".tmp")', source)
        self.assertIn('os.replace(path + ".tmp", path)', source)

    def test_r1_8_a_loss_that_is_not_a_number_stops_both_stages(self):
        source = self.source("train.py")
        self.assertEqual(source.count("if not finite(loss, norm):"), 2)
        self.assertEqual(source.count("sys.exit(DIVERGED)"), 2)
        self.assertIn(f"DIVERGED = {run.DIVERGED}", source)

    def test_r1_9_calibration_holds_one_batch_and_its_peak_is_logged_before_the_reset(self):
        source = self.source("train.py")
        block = source[source.index("stats = SigmaStats()"):source.index("optimizer = torch.optim.AdamW(params, lr=args.lr1")]
        self.assertIn("del cache, calib", block)
        self.assertLess(block.index("calibration_peak ="), block.index("release_calibration_memory()"))
        self.assertIn("cap_gpu_memory()", source)


@unittest.skipUnless(HAVE_TORCH, "torch is needed for the sigma arithmetic")
class SigmaTest(unittest.TestCase):
    def test_r1_9_batch_by_batch_sums_give_the_same_sigma(self):
        from latent_transfer.mapper import SigmaStats, calibrate_sigma
        torch.manual_seed(0)
        keys = [[torch.randn(3, 2, 5, 4) for _ in range(2)] for _ in range(4)]
        values = [[torch.randn(3, 2, 5, 4) for _ in range(2)] for _ in range(4)]
        masks = [(torch.rand(3, 5) > 0.3).long() for _ in range(4)]
        stats = SigmaStats()
        for k, v, m in zip(keys, values, masks):
            stats.add(k, v, m)
        self.assertTrue(torch.equal(stats.sigma(), calibrate_sigma(keys, values, masks)))
        weight = torch.cat(masks).float()[:, None, :, None]
        direct = ((torch.cat([k[0] for k in keys]) ** 2 * weight).sum((0, 2, 3)) / (weight.sum() * 4)).sqrt()
        self.assertTrue(torch.allclose(stats.sigma()[0, :, 0], direct, atol=1e-6))


if __name__ == "__main__":
    unittest.main()
