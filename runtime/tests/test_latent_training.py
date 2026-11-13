"""C13 levels 2 and 3 (adapter, LoRA, training loop) on the CPU: a tiny random Llama and a
byte-level ChatML tokenizer built in memory. No download, no GPU."""
import contextlib
import io
import json
import os
import tempfile
import unittest

try:
    import torch
    from tokenizers import Tokenizer, decoders, models, pre_tokenizers
    from transformers import LlamaConfig, LlamaForCausalLM, PreTrainedTokenizerFast
    HAVE_TORCH = True
except ImportError:
    HAVE_TORCH = False

CHATML_TEMPLATE = ("{% for message in messages %}{{ '<|im_start|>' + message['role'] + '\\n' + message['content'] + "
                   "'<|im_end|>' + '\\n' }}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}"
                   "{% endif %}")
SOLUTION = ("Natalia sold 48/2 = <<48/2=24>>24 clips in May.\n"
            "Natalia sold 48+24 = <<48+24=72>>72 clips altogether in April and May.\n#### 72")
QUESTION = "Natalia sold clips to 48 of her friends in April, and then half as many in May. How many in all?"


def tiny_tokenizer():
    """Byte-level BPE without merges: every byte is a token, plus the ChatML special tokens."""
    alphabet = sorted(pre_tokenizers.ByteLevel.alphabet())
    backend = Tokenizer(models.BPE(vocab={ch: i for i, ch in enumerate(alphabet)}, merges=[]))
    backend.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    backend.decoder = decoders.ByteLevel()
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=backend)
    tokenizer.add_special_tokens({"eos_token": "<|im_end|>", "pad_token": "<|endoftext|>"})
    from tokenizers import AddedToken
    tokenizer.add_tokens([AddedToken("<|im_start|>", special=True, normalized=False)], special_tokens=True)
    tokenizer.chat_template = CHATML_TEMPLATE
    return tokenizer


def tiny_model(tokenizer, seed=0, dtype=None):
    torch.manual_seed(seed)
    config = LlamaConfig(vocab_size=len(tokenizer), hidden_size=32, intermediate_size=64, num_hidden_layers=2,
                         num_attention_heads=4, num_key_value_heads=2, max_position_embeddings=4096,
                         tie_word_embeddings=False, bos_token_id=None, eos_token_id=tokenizer.eos_token_id,
                         pad_token_id=tokenizer.pad_token_id)
    model = LlamaForCausalLM(config).eval()
    return model.to(dtype) if dtype is not None else model


def tiny_team(seed=0, dtype=None):
    from latent_team.team import LatentTeam
    tokenizer = tiny_tokenizer()
    model = tiny_model(tokenizer, seed, dtype)
    return LatentTeam("tiny-llama", device="cpu", model=model, tokenizer=tokenizer)


def train_args(*extra):
    from latent_team.train import parser
    return parser().parse_args(["--level", "both", "--device", "cpu", "--out", "unused", *extra])


def target(team):
    from latent_team.train import target_text
    return target_text(SOLUTION, team.close_turn())


class TargetTextTest(unittest.TestCase):
    """Runs without torch: train.py imports torch lazily."""

    def test_annotations_go_and_the_answer_line_and_close_follow(self):
        from latent_team.train import target_text
        text = target_text(SOLUTION, "<|im_end|>\n")
        self.assertEqual(text, "Natalia sold 48/2 = 24 clips in May.\nNatalia sold 48+24 = 72 clips altogether in "
                               "April and May.\nThe answer is 72.<|im_end|>\n")
        self.assertNotIn("<<", text)
        self.assertNotIn("####", text)
        self.assertEqual(target_text("#### 1,200", "<|end|>\n"), "The answer is 1,200.<|end|>\n")
        with self.assertRaises(ValueError):
            target_text("no final line", "\n")

    def test_the_cli_refuses_the_random_mode_and_bad_numbers(self):
        from latent_team.train import check, parser
        # Codex review of 334ce35: aligned thoughts are not norm-matched to the random
        # control, and they lost to it in level 1, so they are not trained.
        for argv in (["--level", "adapter", "--mode", "random", "--out", "x"],
                     ["--level", "adapter", "--mode", "aligned", "--out", "x"],
                     ["--level", "neither", "--out", "x"]):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                parser().parse_args(argv)
        args = parser().parse_args(["--level", "lora", "--out", "x", "--grad-accum", "0", "--lr", "0"])
        self.assertEqual(len(check(args)), 2)
        # Codex review of 2d11edb: an adapter with no latent step has nothing to train.
        zero = parser().parse_args(["--level", "adapter", "--steps", "0", "--out", "x"])
        self.assertEqual(check(zero), ["--level adapter needs --steps of at least 1"])
        self.assertEqual(check(parser().parse_args(["--level", "lora", "--steps", "0", "--out", "x"])), [])
        defaults = parser().parse_args(["--level", "lora", "--out", "x"])
        self.assertEqual((defaults.steps, defaults.train_count, defaults.mode), (10, 2000, "soft"))
        self.assertEqual(check(defaults), [])


@unittest.skipUnless(HAVE_TORCH, "torch, transformers and tokenizers are needed for C13 training")
class TinySetupTest(unittest.TestCase):
    def test_the_tiny_tokenizer_gives_the_measured_chatml_turns(self):
        team = tiny_team()
        self.assertTrue(team.chatml())
        self.assertEqual(team.close_turn(), "<|im_end|>\n")
        self.assertIsNone(team.adapter)
        self.assertIn(team.tokenizer.eos_token_id, team.eos)


@unittest.skipUnless(HAVE_TORCH, "torch, transformers and tokenizers are needed for C13 training")
class AdapterTest(unittest.TestCase):
    def fresh_adapter(self, team):
        from latent_team.adapter import ThoughtAdapter
        return ThoughtAdapter(team.model.config.hidden_size, 4, team.model.get_input_embeddings().weight.shape[1])

    def test_a_fresh_adapter_is_an_exact_no_op(self):
        plain, adapted = tiny_team(), tiny_team()
        adapted.adapter = self.fresh_adapter(adapted)
        hidden = torch.randn(3, 32)
        for mode in ("soft", "aligned"):
            self.assertTrue(torch.equal(plain.thought(hidden, mode), adapted.thought(hidden, mode)), mode)
            a, mask_a = plain.working_memory([QUESTION], 3, mode)
            b, mask_b = adapted.working_memory([QUESTION], 3, mode)
            self.assertTrue(torch.equal(mask_a, mask_b))
            for layer_a, layer_b in zip(a.layers, b.layers):
                self.assertTrue(torch.equal(layer_a.keys, layer_b.keys), mode)
                self.assertTrue(torch.equal(layer_a.values, layer_b.values), mode)
            self.assertEqual(plain.latent_mas([QUESTION], steps=3, max_new_tokens=6, mode=mode)[0],
                             adapted.latent_mas([QUESTION], steps=3, max_new_tokens=6, mode=mode)[0])

    def test_the_random_control_ignores_the_adapter(self):
        plain, adapted = tiny_team(), tiny_team()
        adapted.adapter = self.fresh_adapter(adapted)
        torch.nn.init.normal_(adapted.adapter.B.weight, std=1.0)  # a trained-looking adapter
        hidden = torch.randn(3, 32)
        torch.manual_seed(7)
        expected = plain.thought(hidden, "random")
        torch.manual_seed(7)
        self.assertTrue(torch.equal(adapted.thought(hidden, "random"), expected))
        self.assertFalse(torch.equal(adapted.thought(hidden, "soft"), plain.thought(hidden, "soft")))
        self.assertFalse(torch.equal(adapted.thought(hidden, "aligned"), plain.thought(hidden, "aligned")))
        torch.manual_seed(11)
        a, _ = plain.working_memory([QUESTION], 3, "random")
        torch.manual_seed(11)
        b, _ = adapted.working_memory([QUESTION], 3, "random")
        self.assertTrue(torch.equal(a.layers[-1].keys, b.layers[-1].keys))

    def test_an_adapted_thought_keeps_the_unadapted_norm_so_the_control_stays_norm_matched(self):
        # Codex review of 2d11edb: a large correction made soft thoughts much longer than
        # the random control, so a win could come from magnitude rather than content.
        plain, adapted = tiny_team(), tiny_team()
        adapted.adapter = self.fresh_adapter(adapted)
        torch.nn.init.normal_(adapted.adapter.B.weight, std=50.0)  # a correction that dominates
        hidden = torch.randn(3, 32)
        for mode in ("soft", "aligned"):
            before = plain.thought(hidden, mode)
            after = adapted.thought(hidden, mode)
            self.assertFalse(torch.allclose(before, after), mode)
            self.assertTrue(torch.allclose(after.norm(dim=-1), before.norm(dim=-1), rtol=1e-5), mode)
        torch.manual_seed(3)
        control = adapted.thought(hidden, "random")
        self.assertTrue(torch.allclose(control.norm(dim=-1), adapted.thought(hidden, "soft").norm(dim=-1), rtol=1e-5))

    def test_the_last_partial_window_is_a_mean_over_its_own_examples(self):
        from latent_team.train import rescale_remainder
        weight = torch.nn.Parameter(torch.zeros(2))
        grad_accum = 8
        (weight * torch.tensor([3.0, 5.0])).sum().div(grad_accum).backward()  # one example in the window
        rescale_remainder([weight], grad_accum, 1)
        self.assertTrue(torch.allclose(weight.grad, torch.tensor([3.0, 5.0])), "one example's full gradient, not 1/8")
        with self.assertRaises(ValueError):
            rescale_remainder([weight], grad_accum, 0)

    def test_an_adapter_for_another_width_is_refused(self):
        from latent_team.adapter import ThoughtAdapter
        team = tiny_team()
        with tempfile.TemporaryDirectory() as tmp:
            ThoughtAdapter(48, 4).save(tmp)
            with self.assertRaises(ValueError):
                team.load_checkpoints(adapter=tmp)
        self.assertIsNone(team.adapter)


@unittest.skipUnless(HAVE_TORCH, "torch, transformers and tokenizers are needed for C13 training")
class LoRATest(unittest.TestCase):
    def test_injected_lora_is_an_exact_no_op(self):
        from latent_team.lora import inject_lora, lora_modules
        for dtype in (torch.float32, torch.bfloat16):
            tokenizer = tiny_tokenizer()
            model = tiny_model(tokenizer, dtype=dtype)
            ids = torch.tensor([tokenizer.encode("<|im_start|>user\nhello there<|im_end|>\n")])
            with torch.no_grad():
                before = model(input_ids=ids).logits
                names = inject_lora(model, rank=4, alpha=8, dropout=0.1)
                model.train()  # dropout on: B = 0 keeps it a no-op anyway
                after = model(input_ids=ids).logits
            self.assertTrue(torch.equal(before, after), dtype)
            self.assertEqual(len(names), 8)  # q, k, v, o in each of 2 layers
            self.assertEqual({n.rsplit(".", 1)[-1] for n in names}, {"q_proj", "k_proj", "v_proj", "o_proj"})
            self.assertEqual(len(lora_modules(model)), 8)
            self.assertTrue(all(p.dtype == torch.float32 for _, m in lora_modules(model)
                                for p in (m.lora_A, m.lora_B)))
            with self.assertRaises(ValueError):
                inject_lora(model)

    def test_the_default_targets_cover_phi3_attention(self):
        from transformers import Phi3Config, Phi3ForCausalLM
        from latent_team.lora import inject_lora
        config = Phi3Config(vocab_size=64, hidden_size=32, intermediate_size=64, num_hidden_layers=2,
                            num_attention_heads=4, num_key_value_heads=4, pad_token_id=0, bos_token_id=None,
                            eos_token_id=1, max_position_embeddings=256)
        names = inject_lora(Phi3ForCausalLM(config))
        self.assertEqual(sorted(n.rsplit(".", 1)[-1] for n in names), ["o_proj", "o_proj", "qkv_proj", "qkv_proj"])

    def test_patterns_match_qualified_names_and_no_match_fails(self):
        from latent_team.lora import inject_lora
        model = tiny_model(tiny_tokenizer())
        self.assertEqual(inject_lora(model, ["model.layers.1.self_attn.*_proj"], rank=2),
                         [f"model.layers.1.self_attn.{p}_proj" for p in "qkvo"])
        with self.assertRaises(ValueError):
            inject_lora(tiny_model(tiny_tokenizer()), ["nothing_here"])


@unittest.skipUnless(HAVE_TORCH, "torch, transformers and tokenizers are needed for C13 training")
class GradientTest(unittest.TestCase):
    def test_only_adapter_and_lora_weights_get_gradients(self):
        from latent_team.lora import lora_modules
        from latent_team.train import setup
        for mode in ("soft", "aligned"):
            team = tiny_team()
            groups = setup(team, train_args("--rank", "4", "--lora-rank", "4"))
            self.assertEqual(set(groups), {"adapter", "lora"})
            loss = team.latent_loss([QUESTION], [target(team)], steps=3, mode=mode)
            loss.backward()
            for name, params in groups.items():
                for parameter in params:
                    self.assertIsNotNone(parameter.grad, name)
            # B starts at zero, so A gets a zero gradient on the first step; B does not.
            self.assertGreater(float(team.adapter.B.weight.grad.abs().sum()), 0, mode)
            self.assertTrue(all(float(m.lora_B.grad.abs().sum()) > 0 for _, m in lora_modules(team.model)), mode)
            trainable = {id(p) for params in groups.values() for p in params}
            base = [(n, p) for n, p in team.model.named_parameters() if id(p) not in trainable]
            self.assertTrue(base)
            for name, parameter in base:
                self.assertFalse(parameter.requires_grad, name)
                self.assertIsNone(parameter.grad, name)


@unittest.skipUnless(HAVE_TORCH, "torch, transformers and tokenizers are needed for C13 training")
class LossMaskTest(unittest.TestCase):
    def test_labels_mark_only_the_target_tokens(self):
        from latent_team.team import IGNORE
        team = tiny_team()
        prompts, targets = ["short", "a longer solver prompt"], ["ab<|im_end|>\n", "xyz 1<|im_end|>\n"]
        ids, mask, labels = team.target_batch(prompts, targets)
        for row, (prompt, text) in enumerate(zip(prompts, targets)):
            head = team.tokenizer(team.turn(prompt), add_special_tokens=False)["input_ids"]
            tail = team.tokenizer(team.turn(prompt) + text, add_special_tokens=False)["input_ids"][len(head):]
            n = len(tail)
            self.assertEqual(labels[row, -n:].tolist(), tail)
            self.assertEqual(ids[row, -n:].tolist(), tail)
            self.assertTrue(bool((labels[row, :-n] == IGNORE).all()))
            self.assertEqual(int(mask[row].sum()), len(head) + n)
        self.assertEqual(team.target_batch(prompts, targets, max_target_tokens=2)[2].ne(IGNORE).sum(1).tolist(), [2, 2])

    def test_the_loss_only_reads_states_that_predict_target_tokens(self):
        from latent_team.team import IGNORE, target_loss
        head = torch.nn.Linear(8, 20, bias=False)
        labels = torch.full((2, 7), IGNORE)
        labels[0, 4:] = torch.tensor([3, 5, 7])
        labels[1, 5:] = torch.tensor([1, 2])
        hidden = torch.randn(2, 7, 8, requires_grad=True)
        loss = target_loss(hidden, labels, head)
        loss.backward()
        predicts = torch.zeros(2, 7, dtype=torch.bool)
        predicts[0, 3:6] = True   # the state at t predicts the token at t + 1
        predicts[1, 4:6] = True
        norms = hidden.grad.norm(dim=-1)
        self.assertTrue(bool((norms[~predicts] == 0).all()))
        self.assertTrue(bool((norms[predicts] > 0).all()))
        with torch.no_grad():
            moved = hidden.clone()
            moved[0, 1] += 5.0  # a prompt position: no effect
            self.assertEqual(float(target_loss(moved, labels, head)), float(loss))
            moved[0, 3] += 5.0  # predicts the first target token: changes the loss
            self.assertNotEqual(float(target_loss(moved, labels, head)), float(loss))
            relabeled = labels.clone()
            relabeled[0, 5] = 9  # a different target token: changes the loss
            self.assertNotEqual(float(target_loss(hidden, relabeled, head)), float(loss))
        with self.assertRaises(ValueError):
            target_loss(hidden, torch.full((2, 7), IGNORE), head)

    def test_with_no_latent_steps_the_loss_is_the_text_loss_of_the_target(self):
        from latent_team.team import LATENT_PROMPTS, ROLES
        team = tiny_team()
        text = target(team)
        with torch.no_grad():
            loss = team.latent_loss([QUESTION], [text], steps=0)
            close = team.tokenizer(team.close_turn(), add_special_tokens=False)["input_ids"]
            pieces = []
            for index, role in enumerate(ROLES):
                pieces += team.render([LATENT_PROMPTS[role].format(question=QUESTION)], first=index == 0)[0][0].tolist()
                pieces += close
            ids, _, labels = team.target_batch([LATENT_PROMPTS["solver"].format(question=QUESTION)], [text])
            n = int(labels.ne(-100).sum())
            full = torch.tensor([pieces + ids[0].tolist()])
            logits = team.model(input_ids=full).logits[0]
            expected = torch.nn.functional.cross_entropy(logits[-n - 1:-1], full[0, -n:])
        torch.testing.assert_close(loss, expected, atol=1e-5, rtol=1e-5)

    def test_a_batch_loss_is_the_token_weighted_mean_of_its_rows(self):
        team = tiny_team()
        questions = [QUESTION, "What is 2 + 3?"]
        texts = [target(team), "2 + 3 = 5\nThe answer is 5.<|im_end|>\n"]
        with torch.no_grad():
            together = team.latent_loss(questions, texts, steps=2)
            alone = [team.latent_loss([q], [t], steps=2) for q, t in zip(questions, texts)]
            counts = [int(team.target_batch(["p"], [t])[2].ne(-100).sum()) for t in texts]
        expected = sum(l * n for l, n in zip(alone, counts)) / sum(counts)
        torch.testing.assert_close(together, expected, atol=1e-5, rtol=1e-5)


@unittest.skipUnless(HAVE_TORCH, "torch, transformers and tokenizers are needed for C13 training")
class TrainingRunTest(unittest.TestCase):
    def test_the_cli_trains_saves_and_a_fresh_model_reloads_identical_outputs(self):
        from latent_team import train
        from latent_team.lora import lora_modules
        team = tiny_team()
        items = [{"question": QUESTION, "solution": SOLUTION, "gold": 72.0},
                 {"question": "What is 2 + 3?", "solution": "2 + 3 = <<2+3=5>>5\n#### 5", "gold": 5.0},
                 {"question": "What is 4 * 2?", "solution": "4 * 2 = <<4*2=8>>8\n#### 8", "gold": 8.0}]
        lines = []
        with tempfile.TemporaryDirectory() as out:
            record = train.main(["--level", "both", "--mode", "soft", "--steps", "2", "--train-count", "3",
                                 "--grad-accum", "1", "--log-every", "1", "--lr", "1e-2", "--rank", "4",
                                 "--lora-rank", "4", "--device", "cpu", "--out", out],
                                team=team, items=items, log=lines.append)
            self.assertEqual(len(record["history"]), 3)  # 3 optimizer steps, one log line each
            self.assertEqual(record["examples"], 3)
            for name in ("adapter/adapter.pt", "adapter/adapter.json", "lora/lora.pt", "lora/lora.json",
                         "train-log.json", "epoch-1/adapter/adapter.pt", "epoch-1/lora/lora.pt"):
                self.assertTrue(os.path.exists(os.path.join(out, name)), name)
            with open(os.path.join(out, "train-log.json")) as handle:
                self.assertEqual(json.load(handle)["trainable"], record["trainable"])
            self.assertTrue(any(json.loads(line).get("event") == "done" for line in lines))
            self.assertGreater(float(team.adapter.B.weight.detach().abs().sum()), 0)
            self.assertTrue(all(float(m.lora_B.detach().abs().sum()) > 0 for _, m in lora_modules(team.model)))
            fresh = tiny_team()
            loaded = fresh.load_checkpoints(adapter=os.path.join(out, "adapter"), lora=os.path.join(out, "lora"))
        self.assertEqual(set(loaded), {"adapter", "lora"})
        self.assertEqual(loaded["adapter"]["trainedMode"], "soft")
        hidden = torch.randn(2, 32)
        self.assertTrue(torch.equal(team.thought(hidden, "soft"), fresh.thought(hidden, "soft")))
        with torch.no_grad():
            self.assertEqual(float(team.latent_loss([QUESTION], [target(team)], 2)),
                             float(fresh.latent_loss([QUESTION], [target(fresh)], 2)))
            ids = torch.tensor([team.tokenizer.encode("<|im_start|>user\nhi<|im_end|>\n")])
            self.assertTrue(torch.equal(team.model(input_ids=ids).logits, fresh.model(input_ids=ids).logits))
        self.assertEqual(team.latent_mas([QUESTION], steps=2, max_new_tokens=6)[0],
                         fresh.latent_mas([QUESTION], steps=2, max_new_tokens=6)[0])
        # Untrained, the same base model answers differently: the reload is not vacuous.
        self.assertNotEqual(float(tiny_team().latent_loss([QUESTION], [target(team)], 2).detach()),
                            float(fresh.latent_loss([QUESTION], [target(fresh)], 2).detach()))

    def test_fewer_gradient_agents_keep_the_loss_and_still_train_both_parts(self):
        from latent_team.lora import lora_modules
        from latent_team.train import setup
        team = tiny_team()
        groups = setup(team, train_args("--rank", "4", "--lora-rank", "4"))
        full = team.latent_loss([QUESTION], [target(team)], steps=3)
        short = team.latent_loss([QUESTION], [target(team)], steps=3, grad_agents=1)
        self.assertEqual(float(full.detach()), float(short.detach()))  # the same forward
        short.backward()
        self.assertGreater(float(team.adapter.B.weight.grad.abs().sum()), 0)
        self.assertTrue(all(m.lora_B.grad is not None for _, m in lora_modules(team.model)))
        self.assertEqual(set(groups), {"adapter", "lora"})

    def test_targets_over_the_token_limit_are_skipped_not_cut(self):
        from latent_team.train import train
        team = tiny_team()
        items = [{"question": "What is 2 + 3?", "solution": "#### 5", "gold": 5.0},
                 {"question": QUESTION, "solution": SOLUTION, "gold": 72.0}]
        with tempfile.TemporaryDirectory() as out:
            args = train_args("--level", "adapter", "--steps", "1", "--grad-accum", "1", "--rank", "2",
                              "--max-target-tokens", "40", "--out", out)
            record = train(team, items, args, log=lambda line: None)
            with self.assertRaises(ValueError):
                train(tiny_team(), items[1:], args, log=lambda line: None)
        self.assertEqual((record["examples"], record["tooLong"]), (1, 1))

    def test_examples_over_the_prompt_limit_are_skipped_and_counted(self):
        # Cycle 13: memory grows with the question, which all four turns repeat, so the
        # longest questions ran out of GPU memory with gradients through two subagents.
        from latent_team.team import LATENT_PROMPTS
        from latent_team.train import train
        team = tiny_team()
        short = "What is 2 + 3?"
        limit = max(team.turn_tokens(short).values())
        items = [{"question": short, "solution": "#### 5", "gold": 5.0},
                 {"question": QUESTION, "solution": SOLUTION, "gold": 72.0}]
        with tempfile.TemporaryDirectory() as out:
            args = train_args("--level", "adapter", "--steps", "1", "--grad-accum", "1", "--rank", "2",
                              "--max-prompt-tokens", str(limit), "--out", out)
            record = train(team, items, args, log=lambda line: None)
            with self.assertRaises(ValueError):
                train(tiny_team(), items[1:], args, log=lambda line: None)
        self.assertEqual((record["examples"], record["longPrompts"], record["tooLong"]), (1, 1, 0))
        # The cap counts the chat template too (Codex review of 8bfbf51): at the raw text
        # length of the longest prompt, the rendered turn is over the cap and is skipped.
        raw = max(len(team._token_ids(p.format(question=short))) for p in LATENT_PROMPTS.values())
        self.assertLess(raw, limit)
        with tempfile.TemporaryDirectory() as out:
            args = train_args("--level", "adapter", "--steps", "1", "--grad-accum", "1", "--rank", "2",
                              "--max-prompt-tokens", str(raw), "--out", out)
            with self.assertRaises(ValueError):
                train(tiny_team(), items[:1], args, log=lambda line: None)
        from latent_team.train import check, parser
        self.assertEqual(check(parser().parse_args(["--level", "lora", "--out", "x", "--max-prompt-tokens", "0"])),
                         ["--max-prompt-tokens must be at least 1"])

    def test_a_few_steps_on_one_repeated_example_lower_its_loss(self):
        from latent_team.train import train
        for level in ("adapter", "lora", "both"):
            team = tiny_team()
            items = [{"question": QUESTION, "solution": SOLUTION, "gold": 72.0}] * 6
            with tempfile.TemporaryDirectory() as out:
                args = train_args("--level", level, "--steps", "2", "--grad-accum", "1", "--log-every", "1",
                                  "--lr", "2e-2", "--rank", "4", "--lora-rank", "4", "--lora-dropout", "0",
                                  "--max-grad-norm", "0", "--out", out)
                args.level = level
                record = train(team, items, args, log=lambda line: None)
            losses = [entry["loss"] for entry in record["history"]]
            self.assertEqual(len(losses), 6)
            self.assertLess(losses[-1], losses[0], (level, losses))


if __name__ == "__main__":
    unittest.main()
