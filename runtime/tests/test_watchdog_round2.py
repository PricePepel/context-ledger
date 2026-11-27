"""W1, review round 2 (Codex): one regression test per finding (tiny CPU model)."""
import unittest

from tests.test_latent_team import HAVE_TORCH, tiny_team
from tests.test_watchdog import QUESTIONS, STEPS, TOKENS, each_layer, failed, run, tamper

if HAVE_TORCH:
    import torch


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for the watchdog")
class RoundTwoTest(unittest.TestCase):
    def assertCaught(self, results, *names):
        got = failed(results)
        for name in names:
            self.assertTrue(got.get(name), f"{name} should fail on every row; failed: {got}")

    def test_a_latent_step_whose_new_column_is_masked_out(self):
        team = tiny_team()
        forward = team.forward

        def masking(memory, memory_mask, ids=None, mask=None, embeds=None, hidden_only=False, hide=None):
            if embeds is not None:
                mask = torch.zeros(embeds.shape[:2], dtype=torch.long)
            return forward(memory, memory_mask, ids=ids, mask=mask, embeds=embeds, hidden_only=hidden_only, hide=hide)

        team.forward = masking
        _, results, _ = run(team)
        self.assertCaught(results, "spanLedger")

    def test_a_weight_replaced_a_buffer_changed_or_a_weight_edited_during_a_turn(self):
        from latent_team.watchdog import team_weights
        team = tiny_team()
        team_weights(team)
        parameter = next(team.model.parameters())
        parameter.data = parameter.data.clone()          # same values, same version, new tensor
        _, results, _ = run(team)
        self.assertCaught(results, "configuration")

        team = tiny_team()
        team_weights(team)
        name, buffer = next(iter(team.model.named_buffers()))
        buffer.mul_(1.0)
        _, results, _ = run(team)
        self.assertCaught(results, "configuration")

        team = tiny_team()
        team_weights(team)
        think = team.think

        def editing(*args, **kwargs):
            with torch.no_grad():
                next(team.model.parameters()).mul_(1.0)
            return think(*args, **kwargs)

        team.think = editing
        _, results, _ = run(team)
        self.assertCaught(results, "configuration")

    def test_non_finite_keys_written_by_the_solver(self):
        team = tiny_team()
        decode = team.decode

        def poisoning(memory, memory_mask, prompts, max_new_tokens, **kwargs):
            out = decode(memory, memory_mask, prompts, max_new_tokens, **kwargs)
            if memory is not None:
                each_layer(memory, lambda k, v: (k, v.clone().fill_(float("nan"))))
            return out

        team.decode = poisoning
        _, results, _ = run(team)
        self.assertCaught(results, "numbers")

    def test_an_error_inside_the_watchdog_fails_every_check(self):
        from latent_team.watchdog import Watch
        team = tiny_team()
        watch = Watch(team, QUESTIONS, steps=STEPS, max_new_tokens=TOKENS)

        def broken(hidden):
            raise RuntimeError("watchdog bug")

        watch.rebuild = broken
        answers, receipt = team.latent_mas(QUESTIONS, steps=STEPS, max_new_tokens=TOKENS, watch=watch)
        results = watch.finish(answers, receipt.generated_tokens, receipt.seconds)
        self.assertTrue(watch.broken > 0)
        self.assertEqual({name for name, values in results["checks"].items() if any(values)}, set())

    def test_a_guard_whose_watchdog_cannot_finish_holds(self):
        from unittest import mock
        from latent_team.guard import Guard
        from latent_team.watchdog import Watch
        team = tiny_team()
        with mock.patch.object(Watch, "finish", side_effect=RuntimeError("bug")):
            outcomes = Guard(team, thresholds=None, sample=lambda: False).run(QUESTIONS, steps=STEPS,
                                                                               max_new_tokens=TOKENS)
        self.assertEqual({(o.decision["action"], o.decision["reason"], o.answer) for o in outcomes},
                         {("hold", "watchdog-error", None)})

    def test_a_fallback_over_its_budget_is_held(self):
        from latent_team.guard import Guard
        from latent_team.team import Receipt
        from latent_team.watchdog import team_weights
        team = tiny_team()
        spec = {"edges": [0.0] * 9, "flag": float("-inf")}
        thresholds = {"id": "w1-tiny-1", "model": "tiny", "weightsHash": team_weights(team)[0], "mode": "soft",
                      "topK": 16, "temperature": 1.0, "steps": STEPS, "degenerate": spec}
        team.single = lambda questions, max_new_tokens=512: (["The answer is 1."] * len(questions),
                                                            Receipt("single", 0, [TOKENS + 5] * len(questions)))
        outcomes = Guard(team, thresholds=thresholds, sample=lambda: False).run(QUESTIONS, steps=STEPS,
                                                                                 max_new_tokens=TOKENS)
        self.assertEqual({(o.decision["action"], o.decision["reason"], o.answer) for o in outcomes},
                         {("hold", "fallback-failed", None)})

    def test_the_mismatched_audit_keeps_no_autograd_graph(self):
        from latent_team.guard import Guard
        team = tiny_team()
        decode, seen = team.decode, []

        def recording(*args, **kwargs):
            seen.append(torch.is_grad_enabled())
            return decode(*args, **kwargs)

        watch, _, answers = run(team)
        team.decode = recording
        with torch.enable_grad():
            Guard(team, thresholds=None).audit(QUESTIONS, STEPS, TOKENS, watch, answers, tolerance=0.0)
        self.assertIn(False, seen)
        self.assertNotIn(True, seen, "every decode of an audit runs without gradients")

    def test_replay_sees_a_change_undone_before_the_next_hand_off(self):
        from latent_team.guard import Guard
        team = tiny_team()

        def scale(factor):
            def change(memory, mask):
                return each_layer(memory, lambda k, v: (k, v * factor)), mask
            return change

        def between(index, memory, mask):
            return scale(8.0)(memory, mask) if index == 0 else scale(0.125)(memory, mask) if index == 1 else (memory, mask)

        team.between = between
        watch, results, answers = run(team)
        del team.between
        words, _, measured = Guard(team, thresholds=None).audit(QUESTIONS, STEPS, TOKENS, watch, answers, 0.0)
        self.assertEqual({w["replay"] for w in words}, {"mismatch"})
        self.assertTrue(all(row[0] > 0 for row in measured["memoryDiff"]), "the critic's hand-off differs")

    def test_a_reference_built_on_other_weights_is_refused(self):
        import io
        from latent_team.watchdog import Reference, ReferenceBuilder
        team = tiny_team()
        builder = ReferenceBuilder()
        run(team, collect=builder)
        buffer = io.BytesIO()
        torch.save({"means": {}, "whiten": torch.eye(2), "pooledMean": torch.zeros(2), "pooledWhiten": torch.eye(2),
                    "meta": {"weightsHash": "a" * 64}}, buffer)
        with self.assertRaises(ValueError):
            Reference.from_bytes(buffer.getvalue(), weights_hash="b" * 64)
        self.assertEqual(Reference.from_bytes(buffer.getvalue(), weights_hash="a" * 64).meta["weightsHash"], "a" * 64)


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for the watchdog")
class RoundThreeTest(unittest.TestCase):
    """W1, review round 3 (Codex): one regression test per finding."""

    def flag_thresholds(self, team):
        from latent_team.watchdog import team_weights
        spec = {"edges": [0.0] * 9, "flag": float("-inf")}
        return {"id": "w1-tiny-1", "model": "tiny", "weightsHash": team_weights(team)[0], "mode": "soft",
                "topK": 16, "temperature": 1.0, "steps": STEPS, "degenerate": spec}

    def test_a_fallback_from_a_model_changed_during_the_audits_is_held(self):
        from latent_team.guard import Guard
        team = tiny_team()
        single = team.single

        def changing(*args, **kwargs):
            with torch.no_grad():
                next(team.model.parameters()).mul_(1.0)
            return single(*args, **kwargs)

        thresholds = self.flag_thresholds(team)
        team.single = changing
        outcomes = Guard(team, thresholds=thresholds, sample=lambda: False).run(QUESTIONS, steps=STEPS,
                                                                                 max_new_tokens=TOKENS)
        self.assertEqual({(o.decision["action"], o.decision["reason"], o.answer) for o in outcomes},
                         {("hold", "fallback-failed", None)})

    def test_a_fallback_within_the_deadline_is_released(self):
        from latent_team.guard import Guard
        team = tiny_team()
        outcomes = Guard(team, thresholds=self.flag_thresholds(team), sample=lambda: False, time_cap=600).run(
            QUESTIONS, steps=STEPS, max_new_tokens=TOKENS)
        self.assertEqual({(o.decision["action"], o.system) for o in outcomes}, {("release", "single")},
                         "the deadline is measured on one clock")

    def test_a_decode_that_reports_tokens_it_never_made(self):
        team = tiny_team()
        decode = team.decode

        def short(memory, memory_mask, prompts, max_new_tokens, **kwargs):
            texts, _ = decode(memory, memory_mask, prompts, 1, **kwargs)
            return texts, [TOKENS - 1] * len(texts)

        team.decode = short
        _, results, _ = run(team)
        self.assertTrue(all(not v for v in results["checks"]["budgets"]))

    def test_a_zero_step_run_replays_as_a_match(self):
        from latent_team.guard import Guard
        from latent_team.watchdog import Watch
        team = tiny_team()
        watch = Watch(team, QUESTIONS, steps=0, max_new_tokens=TOKENS, keep_memory=True)
        answers, receipt = team.latent_mas(QUESTIONS, steps=0, max_new_tokens=TOKENS, watch=watch)
        watch.finish(answers, receipt.generated_tokens, receipt.seconds)
        words, _, _ = Guard(team, thresholds=None).audit(QUESTIONS, 0, TOKENS, watch, answers, tolerance=0.0)
        self.assertEqual({w["replay"] for w in words}, {"match"})

    def test_a_failing_audit_stage_holds_instead_of_crashing(self):
        from latent_team.guard import Guard
        team = tiny_team()

        def failing(*args, **kwargs):
            raise RuntimeError("CUDA error")

        team.single = failing
        outcomes = Guard(team, thresholds=None).run(QUESTIONS, steps=STEPS, max_new_tokens=TOKENS, audit=True)
        self.assertEqual({(o.decision["action"], o.decision["reason"], o.answer) for o in outcomes},
                         {("hold", "runtime-error", None)})


if __name__ == "__main__":
    unittest.main()
