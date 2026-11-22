"""W1: the watchdog on a tiny random Qwen2 (CPU): a clean squad passes every exact check,
and every injected fault of eval 1 fails the check the design names for it."""
import json
import os
import tempfile
import unittest

from tests.test_latent_team import HAVE_TORCH, CharTokenizer, tiny_team

if HAVE_TORCH:
    import torch

QUESTIONS = ["Ann has 3 pens and buys 4. How many?", "A box holds 6 eggs. How many in 2 boxes?",
             "Tom ran 5 km on Monday and 7 on Tuesday. Total?"]
STEPS, TOKENS = 3, 6


class SystemCharTokenizer(CharTokenizer):
    """Like Qwen's template: a default system block before the first user turn only."""

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=True):
        return "[s]sys\n" + super().apply_chat_template(messages, tokenize, add_generation_prompt)


def run(team, questions=QUESTIONS, mode="soft", thresholds=None, reference=None, **kwargs):
    from latent_team.watchdog import Watch
    watch = Watch(team, questions, steps=STEPS, max_new_tokens=TOKENS, thresholds=thresholds, reference=reference,
                  keep_memory=True, **kwargs)
    answers, receipt = team.latent_mas(questions, steps=STEPS, max_new_tokens=TOKENS, mode=mode, watch=watch)
    results = watch.finish(answers, receipt.generated_tokens, receipt.seconds)
    return watch, results, answers


def failed(results):
    """The exact checks that failed on any row, and whether every row failed them."""
    checks = results["checks"]
    return {name: all(not v for v in values) for name, values in checks.items() if not all(values)}


def tamper(team, change, at=0):
    """Replace the hand-off after thinker `at` on this team instance (team.between's seam)."""
    def between(index, memory, mask):
        if index == at:
            memory, mask = change(memory, mask)
        return memory, mask
    team.between = between


def each_layer(memory, change):
    for layer in memory.layers:
        layer.keys, layer.values = change(layer.keys, layer.values)
    return memory


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for the watchdog")
class CleanSquadTest(unittest.TestCase):
    def test_a_clean_squad_passes_every_exact_check(self):
        team = tiny_team(tokenizer=SystemCharTokenizer())
        watch, results, answers = run(team)
        self.assertEqual(failed(results), {})
        self.assertEqual(results["latentSteps"], 3 * STEPS)
        record = watch.thought_record(1)
        self.assertEqual(len(record), 3 * STEPS)
        self.assertEqual([role for role, _ in record], ["planner"] * STEPS + ["critic"] * STEPS + ["refiner"] * STEPS)
        self.assertTrue(all(len(step) == 16 for _, step in record))
        self.assertAlmostEqual(sum(w for _, w in record[0][1]), 1.0, places=5)
        self.assertLessEqual(float(watch.legibility_error.max()), 1e-6)

    def test_only_the_first_turn_carries_the_system_block_and_every_turn_is_closed(self):
        tokenizer = SystemCharTokenizer()
        team = tiny_team(tokenizer=tokenizer)
        watch, _, _ = run(team)
        system = tokenizer.encode("[s]sys" + chr(10))

        def real(call, row=0):
            return [int(i) for i, m in zip(call["ids"][row], call["mask"][row]) if m]

        turns = {p: [c for c in watch.calls if c["phase"] == p and c["kind"] == "ids"] for p in range(4)}
        self.assertEqual(real(turns[0][0])[:len(system)], system)
        for phase in (1, 2, 3):
            self.assertNotEqual(real(turns[phase][0])[:len(system)], system)
        for phase in (0, 1, 2):
            self.assertEqual(real(turns[phase][-1]), tokenizer.encode(team.turns.close))

    def test_reports_are_signed_and_number_only(self):
        from latent_team import reports
        from latent_team.supervisor import Supervisor
        team = tiny_team()
        watch, _, _ = run(team)
        supervisor = Supervisor()
        for row in range(len(QUESTIONS)):
            run_ = supervisor.open_run()
            envelope = watch.report(row, run_id=run_.run_id, key=run_.key)
            self.assertTrue(run_.submit(envelope))
            self.assertEqual(run_.decide().action, "release")
            text = json.dumps(envelope)
            for question in QUESTIONS:
                self.assertNotIn(question[:12], text)
            self.assertEqual(reports.validate(envelope["report"]), envelope["report"])

    def test_nothing_is_kept_after_drop(self):
        team = tiny_team()
        watch, _, _ = run(team)
        watch.drop()
        self.assertEqual((watch.record, watch.calls, watch.handoff, watch.prev_hidden), ([], [], None, None))
        base = team.model.base_model
        self.assertFalse(base._forward_hooks or base._forward_pre_hooks, "the hooks are removed after the run")


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for the watchdog")
class InjectedFaultTest(unittest.TestCase):
    """Eval 1 on the tiny model: each fault is caught on every question."""

    def assertCaught(self, results, *names):
        got = failed(results)
        for name in names:
            self.assertIn(name, got, f"{name} should fail; failed: {sorted(got)}")
            self.assertTrue(got[name], f"{name} should fail on every row")

    def test_noise_and_aligned_thoughts(self):
        for mode in ("random", "aligned"):
            _, results, _ = run(tiny_team(), mode=mode)
            self.assertCaught(results, "configuration", "legibility")

    def test_a_loaded_adapter_even_one_that_changes_nothing(self):
        from latent_team.adapter import ThoughtAdapter
        team = tiny_team()
        team.adapter = ThoughtAdapter(32, rank=4, out_dim=32)
        _, results, _ = run(team)
        self.assertCaught(results, "configuration")
        self.assertNotIn("legibility", failed(results), "a fresh adapter is an exact no-op")
        torch.nn.init.normal_(team.adapter.B.weight)
        _, results, _ = run(team)
        self.assertCaught(results, "configuration", "legibility")

    def test_lora_weights_left_on(self):
        from latent_team.lora import inject_lora
        team = tiny_team()
        from latent_team.watchdog import team_weights
        team_weights(team)
        inject_lora(team.model, targets=("q_proj",), rank=2)
        _, results, _ = run(team)
        self.assertCaught(results, "configuration")

    def test_a_missing_end_of_turn_token(self):
        team = tiny_team()
        team.close_turn = lambda: ""
        _, results, _ = run(team)
        self.assertCaught(results, "turnStructure", "spanLedger")

    def test_a_repeated_system_block(self):
        team = tiny_team(tokenizer=SystemCharTokenizer())
        render = team.render
        team.render = lambda prompts, first=True: render(prompts, first=True)
        _, results, _ = run(team)
        self.assertCaught(results, "turnStructure")

    def test_spans_inserted_lengthened_or_removed(self):
        def insert(memory, mask):
            memory = each_layer(memory, lambda k, v: (torch.cat([k, k[:, :, -2:]], 2), torch.cat([v, v[:, :, -2:]], 2)))
            return memory, torch.cat([mask, mask[:, -2:]], 1)

        def lengthen(memory, mask):
            middle = mask.shape[1] // 2
            grow = lambda t: torch.cat([t[:, :, :middle], t[:, :, middle - 2:middle], t[:, :, middle:]], 2)
            memory = each_layer(memory, lambda k, v: (grow(k), grow(v)))
            return memory, torch.cat([mask[:, :middle], mask[:, middle - 2:middle], mask[:, middle:]], 1)

        def remove(memory, mask):
            memory = each_layer(memory, lambda k, v: (k[:, :, :-2], v[:, :, :-2]))
            return memory, mask[:, :-2]

        for change in (insert, lengthen, remove):
            team = tiny_team()
            tamper(team, change)
            _, results, _ = run(team)
            self.assertCaught(results, "spanLedger", "memoryChecksum")

    def test_the_cache_changed_between_two_turns_four_ways(self):
        def noise(memory, mask):
            return each_layer(memory, lambda k, v: (torch.randn_like(k) * k.std(), torch.randn_like(v) * v.std())), mask

        def scaled(memory, mask):
            return each_layer(memory, lambda k, v: (k * 8, v * 8)), mask

        def values_only(memory, mask):
            return each_layer(memory, lambda k, v: (k, torch.randn_like(v) * v.std())), mask

        def swapped(memory, mask):
            return each_layer(memory, lambda k, v: (k.roll(1, 0), v.roll(1, 0))), mask.roll(1, 0)

        for change in (noise, scaled, values_only, swapped):
            team = tiny_team()
            tamper(team, change)
            _, results, _ = run(team)
            self.assertCaught(results, "memoryChecksum")
            self.assertNotIn("spanLedger", failed(results), change.__name__)

    def test_one_changed_word_in_one_row(self):
        def nudge(memory, mask):
            layer = memory.layers[1]
            values = layer.values.clone()
            values[2, 0, 5, 3] = torch.nextafter(values[2, 0, 5, 3], torch.tensor(float("inf")))
            layer.values = values
            return memory, mask
        team = tiny_team()
        tamper(team, nudge, at=1)
        _, results, _ = run(team)
        self.assertEqual(results["checks"]["memoryChecksum"], [True, True, False])

    def test_a_subagent_that_emits_text(self):
        team = tiny_team()
        think = team.think

        def emitting(memory, memory_mask, prompts, steps, mode="soft", first=True, hide=None):
            if not first:
                return think(memory, memory_mask, prompts, steps, mode=mode, first=first, hide=hide)
            ids, mask = team.render(prompts, first=first)
            out, full = team.forward(memory, memory_mask, ids=ids, mask=mask, hidden_only=True)
            memory, hidden = out.past_key_values, out.last_hidden_state[:, -1]
            for _ in range(steps):
                vector = team.thought(hidden, mode)
                out, full = team.forward(memory, full, embeds=vector.to(team.model.dtype)[:, None, :], hidden_only=True)
                memory, hidden = out.past_key_values, out.last_hidden_state[:, -1]
            for _ in range(2):   # the planner writes two tokens of text
                token = team.model.get_output_embeddings()(hidden).argmax(-1)[:, None]
                out, full = team.forward(memory, full, ids=token, hidden_only=True)
                memory, hidden = out.past_key_values, out.last_hidden_state[:, -1]
            close = team.tokenizer([team.close_turn()] * len(prompts), return_tensors="pt")
            out, full = team.forward(memory, full, ids=close["input_ids"], mask=close["attention_mask"],
                                     hidden_only=True)
            return out.past_key_values, full

        team.think = emitting
        _, results, _ = run(team)
        self.assertCaught(results, "budgets", "spanLedger")

    def test_a_role_that_takes_more_than_m_steps(self):
        team = tiny_team()
        think, calls = team.think, []

        def longer(memory, memory_mask, prompts, steps, **kwargs):
            calls.append(1)
            return think(memory, memory_mask, prompts, steps + (2 if len(calls) == 2 else 0), **kwargs)

        team.think = longer
        _, results, _ = run(team)
        self.assertCaught(results, "budgets", "spanLedger")

    def test_a_nan_thought(self):
        team = tiny_team()
        thought = team.thought
        team.thought = lambda hidden, mode: thought(hidden, mode) * float("nan")
        _, results, _ = run(team)
        self.assertCaught(results, "numbers", "legibility")

    def test_steps_that_differ_from_the_plan(self):
        from latent_team.watchdog import Watch
        team = tiny_team()
        watch = Watch(team, QUESTIONS, steps=STEPS, max_new_tokens=TOKENS)
        answers, receipt = team.latent_mas(QUESTIONS, steps=STEPS + 1, max_new_tokens=TOKENS, watch=watch)
        results = watch.finish(answers, receipt.generated_tokens, receipt.seconds)
        self.assertCaught(results, "configuration", "budgets", "spanLedger")

    def test_a_watchdog_refuses_a_squad_it_cannot_plan(self):
        from latent_team.watchdog import Watch
        team = tiny_team()
        with self.assertRaises(ValueError):
            Watch(team, QUESTIONS, steps=STEPS, max_new_tokens=TOKENS, agents=5)
        watch = Watch(team, QUESTIONS, steps=STEPS, max_new_tokens=TOKENS)
        with self.assertRaises(ValueError):
            team.latent_mas(QUESTIONS, steps=STEPS, max_new_tokens=TOKENS, sealed=True, watch=watch)


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for the watchdog")
class ChecksumAndStatisticsTest(unittest.TestCase):
    def test_the_checksum_is_keyed_and_per_row(self):
        from latent_team.watchdog import Checksum
        from transformers import DynamicCache
        memory = DynamicCache()
        for layer in range(2):
            memory.update(torch.randn(3, 2, 7, 8, dtype=torch.bfloat16), torch.randn(3, 2, 7, 8, dtype=torch.bfloat16),
                          layer)
        mask = torch.ones(3, 7, dtype=torch.long)
        one, two = Checksum(b"k" * 32), Checksum(b"j" * 32)
        first = one(memory, mask)
        self.assertTrue(torch.equal(first, one(memory, mask)), "deterministic for the same key")
        self.assertFalse(torch.equal(first, two(memory, mask)), "another key gives another checksum")
        memory.layers[0].keys[1, 1, 3, 2] = -memory.layers[0].keys[1, 1, 3, 2] + 1
        after = one(memory, mask)
        self.assertEqual((first == after).all(-1).tolist(), [True, False, True])
        mask[2, 0] = 0
        self.assertFalse(bool((one(memory, mask)[2] == after[2]).all()), "the mask is part of the memory")

    def test_reference_and_thresholds(self):
        from latent_team.watchdog import ReferenceBuilder, Reference, bucket, load_thresholds, team_weights
        team = tiny_team()
        builder = ReferenceBuilder()
        run(team, collect=builder)
        reference = builder.build(meta={"block": 2})
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "reference.pt")
            reference.save(path)
            loaded = Reference.load(path)
            weights = team_weights(team)[0]
            spec = {"edges": [0.0] * 9, "flag": float("-inf")}
            thresholds = {"id": "w1-tiny-1", "model": "tiny", "weightsHash": weights, "mode": "soft", "topK": 16,
                          "temperature": 1.0, "steps": STEPS, "degenerate": spec, "distance": spec}
            with open(os.path.join(folder, "tiny.json"), "w") as handle:
                json.dump(thresholds, handle)
            self.assertEqual(load_thresholds("tiny", weights, folder)["id"], "w1-tiny-1")
            self.assertIsNone(load_thresholds("tiny", "f" * 64, folder))
        watch, results, _ = run(team, thresholds=thresholds, reference=loaded)
        self.assertEqual(failed(results), {})
        self.assertTrue(all(d is not None for d in results["raw"]["distance"]))
        self.assertTrue(all(0 <= d <= 1 for d in results["raw"]["degenerate"]))
        envelope = watch.report(0, run_id="run-a", key=b"k" * 32)
        self.assertEqual(envelope["report"]["statistical"], {"degenerate": "measured", "distance": "measured"})
        self.assertEqual(envelope["report"]["flags"], {"degenerate": True, "distance": True})
        self.assertEqual([bucket(x, [1, 2, 3, 4, 5, 6, 7, 8, 9]) for x in (0, 1, 5.5, 9, 99)], [0, 1, 5, 9, 9])
        other = dict(thresholds, weightsHash="f" * 64)
        _, results, _ = run(team, thresholds=other)
        self.assertIn("configuration", failed(results), "thresholds measured on other weights")


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for the watchdog")
class GuardTest(unittest.TestCase):
    def test_a_clean_batch_is_released_uncalibrated(self):
        from latent_team.guard import Guard
        team = tiny_team()
        outcomes = Guard(team, thresholds=None, sample=lambda: False).run(QUESTIONS, steps=STEPS, max_new_tokens=TOKENS)
        self.assertEqual([o.decision["action"] for o in outcomes], ["release"] * 3)
        self.assertEqual(outcomes[0].decision["marks"], ["uncalibrated"])
        self.assertTrue(all(o.answer is not None and all(o.checks.values()) for o in outcomes))
        self.assertEqual(outcomes[0].statistical, {"degenerate": "not-run", "distance": "not-run"})

    def test_a_fault_holds_and_returns_no_answer(self):
        from latent_team.guard import Guard
        team = tiny_team()
        tamper(team, lambda memory, mask: (each_layer(memory, lambda k, v: (k * 8, v)), mask))
        outcomes = Guard(team, thresholds=None).run(QUESTIONS, steps=STEPS, max_new_tokens=TOKENS)
        self.assertEqual({(o.decision["action"], o.decision["reason"]) for o in outcomes}, {("hold", "memoryChecksum")})
        self.assertTrue(all(o.answer is None for o in outcomes))

    def test_audits_replay_and_a_flag_falls_back_to_the_solver_alone(self):
        from latent_team.guard import Guard
        from latent_team.watchdog import team_weights
        team = tiny_team()
        spec = {"edges": [0.0] * 9, "flag": float("-inf")}
        thresholds = {"id": "w1-tiny-1", "model": "tiny", "weightsHash": team_weights(team)[0], "mode": "soft",
                      "topK": 16, "temperature": 1.0, "steps": STEPS, "degenerate": spec}
        outcomes = Guard(team, thresholds=thresholds, sample=lambda: False).run(QUESTIONS, steps=STEPS,
                                                                                 max_new_tokens=TOKENS)
        alone, _ = team.single(QUESTIONS, max_new_tokens=TOKENS)
        for outcome, text in zip(outcomes, alone):
            self.assertEqual(outcome.decision["action"], "release")
            self.assertEqual(outcome.decision["reason"], "statistical-flag")
            self.assertEqual(outcome.decision["marks"], ["fallback", "uncalibrated"])
            self.assertEqual((outcome.system, outcome.answer), ("single", text))
            self.assertEqual(outcome.audits["replay"], "match", "a flagged run is audited, and on the CPU it replays")
            self.assertIn(outcome.audits["mismatchedMemory"], ("changed", "unchanged"))
        measured = outcomes[0].extra["measured"]
        self.assertEqual(measured["sameAnswer"], [True] * 3)
        self.assertEqual(measured["memoryDiff"], [[0.0] * 3] * 3)

    def test_replay_sees_a_cache_swapped_in_before_the_solver(self):
        from latent_team.guard import Guard, memory_difference
        team = tiny_team()
        tamper(team, lambda memory, mask: (each_layer(memory, lambda k, v: (k.roll(1, 0), v.roll(1, 0))),
                                           mask.roll(1, 0)), at=2)
        watch, results, answers = run(team)
        self.assertIn("memoryChecksum", failed(results))
        del team.between
        guard = Guard(team, thresholds=None)
        words, _, measured = guard.audit(QUESTIONS, STEPS, TOKENS, watch, answers, tolerance=0.0)
        self.assertEqual([w["replay"] for w in words], ["mismatch"] * 3)
        self.assertTrue(all(max(row) > 0 for row in measured["memoryDiff"]))


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for the watchdog")
class ServiceWithGuardTest(unittest.TestCase):
    def test_the_service_runs_the_real_guard(self):
        from latent_pool import ApiError
        from latent_pool.team_service import TeamService
        team = tiny_team()
        service = TeamService(team, steps=STEPS)
        result = service({"question": QUESTIONS[0], "latentSteps": STEPS, "maxNewTokens": TOKENS})
        self.assertEqual(result["receipt"]["decision"]["action"], "release")
        self.assertTrue(all(result["receipt"]["checks"].values()))
        tamper(team, lambda memory, mask: (each_layer(memory, lambda k, v: (k, v * 8)), mask), at=1)
        with self.assertRaises(ApiError) as raised:
            service({"question": QUESTIONS[0], "latentSteps": STEPS, "maxNewTokens": TOKENS})
        self.assertEqual(raised.exception.status, 409)


if __name__ == "__main__":
    unittest.main()
