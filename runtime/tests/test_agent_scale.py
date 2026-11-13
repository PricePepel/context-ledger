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
