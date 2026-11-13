"""C15 (many agents, sealed hand-off, vote baseline, split facts) on the CPU with the tiny model of
test_latent_training. No download, no GPU."""
import os
import tempfile
import unittest

from test_latent_training import HAVE_TORCH, QUESTION, tiny_team

if HAVE_TORCH:
    import torch

SPLIT_QUESTION = ("Tom has 3 apples. Ann gives him 4 more apples. He eats 2 of them. "
                  "How many apples does Tom have now?")


class SplitTest(unittest.TestCase):
    def test_a_question_splits_into_facts_and_the_last_sentence(self):
        from latent_team.scale import split_question
        facts, ask = split_question(SPLIT_QUESTION)
        self.assertEqual(facts, ["Tom has 3 apples.", "Ann gives him 4 more apples.", "He eats 2 of them."])
        self.assertEqual(ask, "How many apples does Tom have now?")
        # Prices and decimals stay inside their sentence.
        self.assertEqual(split_question("A pen costs $1.50. A cap costs $2. She buys both. What does she pay?")[0],
                         ["A pen costs $1.50.", "A cap costs $2.", "She buys both."])
        self.assertIsNone(split_question("Tom has 3 apples. How many does he have?"))  # one fact: nothing to deal

    def test_facts_are_dealt_round_robin_and_every_hand_ends_with_the_ask(self):
        from latent_team.scale import deal
        self.assertEqual(deal(["a.", "b.", "c."], "q?", 2), ["a. c. q?", "b. q?"])
        self.assertEqual(deal(["a.", "b."], "q?", 4), ["a. q?", "b. q?", "q?", "q?"])

    def test_the_vote_takes_the_most_common_number_and_the_first_on_a_tie(self):
        from latent_team.scale import tally
        self.assertEqual(tally(["The answer is 5.", "The answer is 7.", "The answer is 5."]), 5.0)
        self.assertEqual(tally(["The answer is 7.", "The answer is 5."]), 7.0)
        self.assertEqual(tally(["no number", "The answer is 3."]), 3.0)
        self.assertIsNone(tally(["no number", ""]))


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class ChainTest(unittest.TestCase):
    def test_chain_roles_start_with_the_planner_and_alternate(self):
        from latent_team.team import ROLES, chain_roles
        self.assertEqual(chain_roles(3), ROLES)
        self.assertEqual(chain_roles(1), ("planner",))
        self.assertEqual(chain_roles(6), ("planner", "critic", "refiner", "critic", "refiner", "critic"))
        with self.assertRaises(ValueError):
            chain_roles(0)

    def test_the_default_team_is_the_three_agent_team(self):
        team = tiny_team()
        default, receipt = team.latent_mas([QUESTION], steps=2, max_new_tokens=6)
        explicit, _ = team.latent_mas([QUESTION], steps=2, max_new_tokens=6, agents=3, views=None, sealed=False)
        self.assertEqual(default, explicit)
        self.assertEqual(receipt.latent_vectors, 6)
        self.assertEqual(team.latent_mas([QUESTION], steps=2, max_new_tokens=2, agents=5)[1].latent_vectors, 10)

    def test_an_all_zero_hide_changes_nothing(self):
        team = tiny_team()
        ids, mask = team.render([QUESTION])
        with torch.no_grad():
            out, full = team.forward(None, None, ids=ids, mask=mask)
            step = ids[:, -1:]
            plain = team.forward(out.past_key_values, full, ids=step)[0].logits
            out, full = team.forward(None, None, ids=ids, mask=mask)
            hidden = team.forward(out.past_key_values, full, ids=step, hide=torch.zeros_like(full))[0].logits
        self.assertTrue(torch.equal(plain, hidden))


def solver_logits(team, memory, mask, hide):
    from latent_team.team import LATENT_PROMPTS
    ids, new_mask = team.render([LATENT_PROMPTS["solver"].format(question="q?")], first=False)
    return team.forward(memory, mask, ids=ids, mask=new_mask, hide=hide)[0].logits


def corrupt(memory, columns):
    """Overwrite the cached keys and values at `columns` with noise, in every layer."""
    generator = torch.Generator().manual_seed(1)
    for layer in memory.layers:
        for tensor in (layer.keys, layer.values):
            tensor[:, :, columns] = torch.randn(tensor[:, :, columns].shape, generator=generator)


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class SealedTest(unittest.TestCase):
    def views(self):
        return [["Tom has 3 apples. q?"], ["Ann gives 4 more. q?"], ["He eats 2 of them. q?"]]

    def test_sealed_hides_exactly_the_prompts_and_they_no_longer_reach_the_solver(self):
        from latent_team.team import LATENT_PROMPTS, ROLES
        team = tiny_team()
        steps = 2
        with torch.no_grad():
            memory, mask, hide = team.chain(["q?"], steps, "soft", views=self.views(), sealed=True)
            widths = [team.render([LATENT_PROMPTS[role].format(question=view[0])], first=index == 0)[0].shape[1]
                      for index, (role, view) in enumerate(zip(ROLES, self.views()))]
            close = len(team._token_ids(team.close_turn()))
            self.assertEqual(int(hide.sum()), sum(widths))
            self.assertEqual(mask.shape[1] - int(hide.sum()), 3 * (steps + close))  # thoughts and closes stay
            before = solver_logits(team, memory, mask, hide)
            columns = hide[0].nonzero()[:, 0]
            # Garbage in the hidden prompt columns cannot change what the solver computes.
            memory, mask, hide = team.chain(["q?"], steps, "soft", views=self.views(), sealed=True)
            corrupt(memory, columns)
            after = solver_logits(team, memory, mask, hide)
            self.assertTrue(torch.allclose(before, after, atol=1e-6))
            # Unsealed, the same garbage does change it: the prompts are read.
            memory, mask, none = team.chain(["q?"], steps, "soft", views=self.views(), sealed=False)
            self.assertIsNone(none)
            open_before = solver_logits(team, memory, mask, None)
            memory, mask, _ = team.chain(["q?"], steps, "soft", views=self.views(), sealed=False)
            corrupt(memory, columns)
            self.assertFalse(torch.allclose(open_before, solver_logits(team, memory, mask, None), atol=1e-6))

    def test_sealed_thoughts_still_carry_what_their_agent_read(self):
        # The latent positions were computed reading the agent's own prompt, so a different
        # fact changes the solver's view even when sealed (scale.py: random_sealed is not empty).
        team = tiny_team()
        other = [["Tom has 9 apples. q?"]] + self.views()[1:]
        with torch.no_grad():
            a = solver_logits(team, *team.chain(["q?"], 2, "soft", views=self.views(), sealed=True))
            b = solver_logits(team, *team.chain(["q?"], 2, "soft", views=other, sealed=True))
        self.assertFalse(torch.allclose(a, b, atol=1e-6))


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class SealedLeakTest(unittest.TestCase):
    """Codex review of 66da55f: corrupting the prompts only after the whole chain, and reading
    only the solver's first step, would miss a leak through a later agent or a later decode step."""

    QUESTIONS = ["q?", "a much longer question here?"]  # rows of different lengths: padded columns
    VIEWS = [["Tom has 3 apples. q?", "x. a much longer question here?"],
             ["Ann gives 4 more apples to him. q?", "y. a much longer question here?"],
             ["He eats 2. q?", "z z z z z z z z z z z. a much longer question here?"]]

    def run_team(self, team, sealed, corrupt_hidden):
        """latent_mas with the hidden (or, unsealed, the would-be hidden) columns overwritten with
        noise before every later agent and before the solver. Returns the visible memory and
        every logit the solver's decode computed."""
        from latent_team.team import LATENT_PROMPTS
        think, forward = team.think, team.forward
        state, logits = {"columns": []}, []

        def spoiled(memory, memory_mask, prompts, steps, mode="soft", first=True, hide=None):
            if corrupt_hidden and state["columns"]:
                corrupt(memory, torch.tensor(state["columns"]))
            start = 0 if memory_mask is None else memory_mask.shape[1]
            width = team.render(prompts, first=first)[0].shape[1]
            out = think(memory, memory_mask, prompts, steps, mode=mode, first=first, hide=hide)
            state["columns"] += list(range(start, start + width))
            return out

        def recording(*args, **kwargs):
            out = forward(*args, **kwargs)
            if not kwargs.get("hidden_only"):
                logits.append(out[0].logits.detach().clone())
            return out

        team.think = spoiled
        with torch.no_grad():
            memory, mask, hide = team.chain(self.QUESTIONS, 2, "soft", views=self.VIEWS, sealed=sealed)
            if corrupt_hidden:
                corrupt(memory, torch.tensor(state["columns"]))
            visible = [c for c in range(mask.shape[1]) if c not in set(state["columns"])]
            kept = [(layer.keys[:, :, visible].clone(), layer.values[:, :, visible].clone()) for layer in memory.layers]
            team.forward = recording
            solver = [LATENT_PROMPTS["solver"].format(question=q) for q in self.QUESTIONS]
            texts = team.decode(memory, mask, solver, 6, first=False, hide=hide)[0]
        team.think, team.forward = think, forward
        return kept, logits, texts

    def test_noise_in_hidden_prompts_changes_nothing_downstream_when_sealed(self):
        clean_memory, clean_logits, clean_texts = self.run_team(tiny_team(), True, False)
        memory, logits, texts = self.run_team(tiny_team(), True, True)
        for (k0, v0), (k1, v1) in zip(clean_memory, memory):  # later agents never read the noise
            self.assertTrue(torch.allclose(k0, k1, atol=1e-5) and torch.allclose(v0, v1, atol=1e-5))
        self.assertEqual(len(logits), len(clean_logits))
        self.assertGreater(len(logits), 1)  # several decode steps, not only the first
        for a, b in zip(clean_logits, logits):
            self.assertTrue(torch.allclose(a, b, atol=1e-5))
        self.assertEqual(texts, clean_texts)

    def test_the_same_noise_does_change_an_unsealed_team(self):
        clean_memory, clean_logits, _ = self.run_team(tiny_team(), False, False)
        memory, logits, _ = self.run_team(tiny_team(), False, True)
        self.assertFalse(all(torch.allclose(k0, k1, atol=1e-5) for (k0, _), (k1, _) in zip(clean_memory, memory)))
        self.assertFalse(torch.allclose(clean_logits[0], logits[0], atol=1e-5))


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class CompatibilityTest(unittest.TestCase):
    def test_the_default_team_is_the_old_three_agent_computation(self):
        # The cycle 9-14 algorithm written out: three agents in turn on one memory, every one
        # reading the question, then a greedy solver turn (Codex review of 66da55f).
        from transformers import DynamicCache
        from latent_team.team import LATENT_PROMPTS, ROLES
        questions = [QUESTION, "What is 2 + 3?"]
        team = tiny_team()
        with torch.no_grad():
            memory, mask = DynamicCache(), None
            for index, role in enumerate(ROLES):
                memory, mask = team.think(memory, mask, [LATENT_PROMPTS[role].format(question=q) for q in questions],
                                          2, mode="soft", first=index == 0)
            # decode() appends to the cache in place: keep the memory as the agents left it.
            snapshot = [(layer.keys.clone(), layer.values.clone()) for layer in memory.layers]
            old = team.decode(memory, mask, [LATENT_PROMPTS["solver"].format(question=q) for q in questions], 6,
                              first=False)
            new_memory, new_mask = team.working_memory(questions, 2, "soft")
        self.assertEqual(team.latent_mas(questions, steps=2, max_new_tokens=6)[0], old[0])
        self.assertTrue(torch.equal(mask, new_mask))
        for (keys, values), layer in zip(snapshot, new_memory.layers):
            self.assertTrue(torch.equal(keys, layer.keys) and torch.equal(values, layer.values))


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class RunnerFixTest(unittest.TestCase):
    def test_a_unanimous_vote_keeps_every_digit_of_its_number(self):
        from latent_team import scale
        import types
        team = tiny_team()
        items = [{"question": "Big?", "gold": 1234567.0}, {"question": "Odd?", "gold": 123456.7}]
        replies = {"Big?": "The answer is 1,234,567.", "Odd?": "The answer is 123456.7."}
        team.sample = lambda qs, n, **kw: ([[replies[q]] * n for q in qs], types.SimpleNamespace(
            generated_tokens=[1] * len(qs), seconds=0.0))
        with tempfile.TemporaryDirectory() as out:
            report = scale.main(["--part", "scale", "--agents", "3", "--only", "vote@3", "--out",
                                 os.path.join(out, "v.json")], team=team, items=items)
        self.assertEqual(report["summaries"]["vote@3"]["accuracy"], 1.0)

    def test_a_random_system_draws_the_same_noise_alone_or_after_others(self):
        from unittest import mock
        from latent_team import scale
        items = ScaleRunTest.ITEMS
        runs, states = [], []
        real_run = scale.run

        def watched(team, spec, *args):
            if spec["key"] == "latent_random@3":
                states.append(torch.random.get_rng_state().clone())  # the generator as the system starts
            return real_run(team, spec, *args)

        # The second run first runs another random system, which draws from the same global
        # generator; without a per-system seed latent_random@3 would start from another state.
        for agents, only in (("3", "latent_random@3"), ("1,3", "latent_random@1,latent_random@3")):
            team = tiny_team()
            team.latent_mas = _short(team.latent_mas)
            with tempfile.TemporaryDirectory() as out, mock.patch.object(scale, "run", watched):
                report = scale.main(["--part", "scale", "--agents", agents, "--steps", "2", "--only", only, "--out",
                                     os.path.join(out, "r.json")], team=team, items=items)
            runs.append([r["answer"] for r in report["systems"]["latent_random@3"]["results"]])
        self.assertEqual(len(states), 2)
        self.assertTrue(torch.equal(states[0], states[1]))
        self.assertEqual(runs[0], runs[1])
        self.assertNotEqual(scale.system_seed(0, "latent_random@3"), scale.system_seed(1, "latent_random@3"))


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class TextTeamTest(unittest.TestCase):
    def test_each_agent_reads_the_latest_plan_and_critique(self):
        team = tiny_team()
        seen = []

        def generate(prompts, max_new_tokens):
            seen.append(prompts[0])
            return [f"note{len(seen)}"], [3]

        team.generate = generate
        team.text_mas(["Q?"], agents=5)
        self.assertEqual(len(seen), 6)  # five agents and the solver
        self.assertIn("Plan:\nnote1", seen[1])                          # critic reads the planner
        self.assertIn("Plan:\nnote1\n\nCritique:\nnote2", seen[2])     # refiner: plan and critique
        self.assertIn("Plan:\nnote3", seen[3])                          # next critic: the refined plan
        self.assertIn("Plan:\nnote3\n\nCritique:\nnote4", seen[4])
        self.assertIn("Plan:\nnote5", seen[5])                          # the solver: the latest plan
        self.assertEqual(team.capped, [0])

    def test_views_and_the_solver_question_replace_the_question(self):
        team = tiny_team()
        seen = []
        team.generate = lambda prompts, n: (seen.append(prompts[0]) or ["x"], [1])
        team.text_mas(["full?"], agents=3, views=[["a. q?"], ["b. q?"], ["c. q?"]], solver_questions=["q?"])
        self.assertTrue(all("full?" not in prompt for prompt in seen))
        self.assertIn("Question: a. q?", seen[0])
        self.assertIn("Question: q?\n", seen[3])


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class SampleTest(unittest.TestCase):
    def test_samples_are_grouped_per_question_and_reproducible_by_seed(self):
        team = tiny_team()
        groups, receipt = team.sample(["What is 2 + 3?", QUESTION], 3, temperature=1.0, max_new_tokens=5, rows=2)
        self.assertEqual([len(g) for g in groups], [3, 3])
        self.assertEqual(len(receipt.generated_tokens), 2)
        again, _ = team.sample(["What is 2 + 3?", QUESTION], 3, temperature=1.0, max_new_tokens=5, rows=2)
        self.assertEqual(groups, again)  # the same seed and rows give the same samples
        other, _ = team.sample(["What is 2 + 3?", QUESTION], 3, temperature=1.0, max_new_tokens=5, rows=2, seed=1)
        self.assertNotEqual(groups, other)

    def test_temperature_zero_is_greedy(self):
        team = tiny_team()
        greedy = team.generate(["hi"], 5)[0]
        self.assertEqual(team.decode(None, None, ["hi"], 5, temperature=0.0)[0], greedy)


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class ScaleRunTest(unittest.TestCase):
    ITEMS = [{"question": SPLIT_QUESTION, "gold": 5.0},
             {"question": "A pen costs $2. A cap costs $3. She buys both. What does she pay?", "gold": 5.0},
             {"question": "Tom has 3 apples. How many does he have?", "gold": 3.0}]

    def test_both_parts_run_every_system_and_compare_with_the_controls(self):
        from latent_team import scale
        team = tiny_team()
        team.single = _short(team.single)
        team.latent_mas = _short(team.latent_mas)
        team.text_mas = _short(team.text_mas)
        team.sample = _short(team.sample)
        with tempfile.TemporaryDirectory() as out:
            path = os.path.join(out, "scale.json")
            report = scale.main(["--part", "scale", "--agents", "1,3", "--text-agents", "3", "--steps", "1",
                                 "--batch", "2", "--vote-rows", "4", "--out", path], team=team, items=self.ITEMS)
            self.assertTrue(os.path.exists(path))
            self.assertEqual(set(report["systems"]), {"single", "latent_mas@1", "latent_random@1", "vote@1",
                                                       "latent_mas@3", "latent_random@3", "vote@3", "text_mas@3"})
            self.assertIn("latent_mas@3 vs latent_random@3", report["vsControls"])
            self.assertIn("latent_mas@3 vs vote@3", report["vsControls"])
            self.assertEqual(report["summaries"]["latent_mas@3"]["meanLatentVectors"], 3.0)
            self.assertEqual(len(report["systems"]["vote@3"]["results"][0]["votes"]), 3)
            split = scale.main(["--part", "split", "--agents", "2", "--text-agents", "2", "--steps", "1",
                                "--batch", "2", "--out", path], team=team, items=self.ITEMS)
        self.assertEqual((split["sample"]["items"], split["sample"]["excludedTooFewFacts"]), (2, 1))
        self.assertEqual(set(split["systems"]), {"single_full", "alone", "latent_sealed@2", "random_sealed@2",
                                                  "latent_open@2", "random_open@2", "text_mas@2"})
        self.assertIn("latent_sealed@2 vs random_sealed@2", split["vsControls"])
        self.assertIn("latent_sealed@2 vs alone", split["vsControls"])

    def test_only_runs_the_named_systems_and_refuses_unknown_ones(self):
        from latent_team import scale
        team = tiny_team()
        team.single = _short(team.single)
        with tempfile.TemporaryDirectory() as out:
            report = scale.main(["--part", "scale", "--agents", "3", "--only", "single", "--out",
                                 os.path.join(out, "s.json")], team=team, items=self.ITEMS)
            self.assertEqual(set(report["systems"]), {"single"})
            with self.assertRaises(SystemExit):
                scale.main(["--part", "scale", "--agents", "3", "--only", "nope", "--out",
                            os.path.join(out, "s.json")], team=team, items=self.ITEMS)


def _short(method):
    """The method with a 4-token answer budget, so the CPU run stays fast."""
    def wrapped(*args, **kwargs):
        kwargs["max_new_tokens"] = 4
        return method(*args, **kwargs)
    return wrapped


if __name__ == "__main__":
    unittest.main()
