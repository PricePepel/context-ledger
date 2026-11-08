"""M2c checks before measuring (CPU, a tiny random Qwen2 and a character tokenizer)."""
import unittest

try:
    import torch
    from transformers import Qwen2Config, Qwen2ForCausalLM
    HAVE_TORCH = True
except ImportError:
    HAVE_TORCH = False


class CharTokenizer:
    """Enough of a tokenizer for the team: chat template, left padding, decode."""
    pad_token_id, eos_token_id, unk_token_id = 0, 1, 2
    pad_token, eos_token = "<pad>", "<eos>"
    padding_side = "left"

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=True):
        return "[u]" + messages[0]["content"] + "[a]"

    def encode(self, text):
        return [3 + (ord(ch) % 90) for ch in text]

    def __call__(self, texts, return_tensors=None, padding=False, add_special_tokens=False):
        rows = [self.encode(t) for t in texts]
        width = max(len(r) for r in rows)
        ids = [[0] * (width - len(r)) + r for r in rows]
        mask = [[0] * (width - len(r)) + [1] * len(r) for r in rows]
        return {"input_ids": torch.tensor(ids), "attention_mask": torch.tensor(mask)}

    def decode(self, ids, skip_special_tokens=True):
        return " ".join(str(i) for i in ids)

    def convert_tokens_to_ids(self, token):
        return None


def tiny_team(tied=True):
    from latent_team.team import LatentTeam
    torch.manual_seed(0)
    config = Qwen2Config(vocab_size=96, hidden_size=32, intermediate_size=64, num_hidden_layers=2,
                         num_attention_heads=4, num_key_value_heads=2, max_position_embeddings=4096,
                         tie_word_embeddings=tied)
    model = Qwen2ForCausalLM(config).eval()
    return LatentTeam("tiny", device="cpu", dtype=torch.float32, model=model, tokenizer=CharTokenizer(),
                      allow_non_chatml=True)


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for M2c")
class AlignmentTest(unittest.TestCase):
    def test_tied_embeddings_keep_the_direction_and_take_the_mean_input_norm(self):
        from latent_team.team import align
        team = tiny_team(tied=True)
        h = torch.randn(5, 32) * 7
        e = align(h, team.w_a, team.target)
        cosine = torch.nn.functional.cosine_similarity(e, h, dim=-1)
        self.assertTrue(bool((cosine > 0.999).all()), cosine)
        torch.testing.assert_close(e.norm(dim=-1), torch.full((5,), float(team.target)), rtol=1e-3, atol=1e-3)

    def test_untied_embeddings_map_output_rows_toward_their_input_rows(self):
        from latent_team.team import align
        team = tiny_team(tied=False)
        w_in = team.model.get_input_embeddings().weight.detach()
        w_out = team.model.get_output_embeddings().weight.detach()
        e = align(w_out, team.w_a, team.target)
        # Least squares from output space to input space: better than no mapping at all.
        mapped = torch.nn.functional.cosine_similarity(e, w_in, dim=-1).mean()
        unmapped = torch.nn.functional.cosine_similarity(w_out, w_in, dim=-1).mean()
        self.assertGreater(float(mapped), float(unmapped))


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for M2c")
class WorkingMemoryTest(unittest.TestCase):
    def test_memory_with_zero_steps_equals_reading_both_prompts_as_text(self):
        from transformers import DynamicCache
        team = tiny_team()
        memory, mask = team.think(DynamicCache(), None, ["plan the sum"], steps=0)
        ids_b, mask_b = team.render(["solve it"], first=False)
        out, _ = team.forward(memory, mask, ids=ids_b, mask=mask_b)
        ids_a, _ = team.render(["plan the sum"])
        close = torch.tensor([team.tokenizer.encode(team.close_turn())])
        # A closed agent turn, then the next agent turn: the same tokens read as text.
        reference = team.model(input_ids=torch.cat([ids_a, close, ids_b], 1)).logits[:, -1:]
        torch.testing.assert_close(out.logits, reference, atol=1e-4, rtol=1e-4)  # forward keeps the last position only

    def test_latent_steps_extend_the_memory_by_one_position_each(self):
        from transformers import DynamicCache
        team = tiny_team()
        memory, mask = team.think(DynamicCache(), None, ["abc"], steps=7)
        # prompt + 7 latent positions + the closing token(s) of the turn
        self.assertEqual(memory.get_seq_length(), len("[u]abc[a]") + 7 + len(team.close_turn()))
        self.assertEqual(mask.shape[1], memory.get_seq_length())

    def test_a_batch_gives_the_same_answers_as_one_question_at_a_time(self):
        team = tiny_team()
        questions = ["2+2?", "a much longer question here?"]
        together, receipt = team.latent_mas(questions, steps=3, max_new_tokens=6)
        alone = [team.latent_mas([q], steps=3, max_new_tokens=6)[0][0] for q in questions]
        self.assertEqual(together, alone)
        self.assertEqual(receipt.latent_vectors, 9)
        self.assertEqual(len(receipt.generated_tokens), 2)

    def test_the_random_control_changes_the_memory_but_not_its_length(self):
        from transformers import DynamicCache
        team = tiny_team()
        n = len(team.close_turn())
        soft, _ = team.think(DynamicCache(), None, ["abc"], steps=4)
        random, _ = team.think(DynamicCache(), None, ["abc"], steps=4, mode="random")
        self.assertEqual(soft.get_seq_length(), random.get_seq_length())
        thoughts = slice(-4 - n, -n)
        self.assertFalse(torch.allclose(soft.layers[0].keys[:, :, thoughts], random.layers[0].keys[:, :, thoughts]))
        torch.testing.assert_close(soft.layers[0].keys[:, :, :-4 - n], random.layers[0].keys[:, :, :-4 - n])

    def test_soft_thoughts_are_mixtures_of_real_token_embeddings(self):
        team = tiny_team()
        hidden = torch.randn(3, 32)
        vector = team.thought(hidden, "soft")
        table = team.model.get_input_embeddings().weight
        logits = team.model.get_output_embeddings()(hidden)
        top = logits.topk(team.soft_top_k, dim=-1)
        expected = (torch.softmax(top.values, -1)[..., None] * table[top.indices]).sum(-2)
        torch.testing.assert_close(vector, expected)
        # A convex mixture never leaves the box spanned by the embedding table.
        self.assertTrue(bool((vector.abs().max(dim=-1).values <= table.abs().max() + 1e-6).all()))
        with self.assertRaises(ValueError):
            team.thought(hidden, "nonsense")

    def test_random_thoughts_match_the_soft_norm_and_bad_modes_fail_early(self):
        team = tiny_team()
        hidden = torch.randn(4, 32)
        soft, random = team.thought(hidden, "soft"), team.thought(hidden, "random")
        torch.testing.assert_close(random.norm(dim=-1), soft.norm(dim=-1))
        self.assertLess(float(torch.nn.functional.cosine_similarity(random, soft, dim=-1).abs().mean()), 0.9)
        with self.assertRaises(ValueError):
            team.latent_mas(["q"], steps=0, mode="nonsense")

    def test_non_chatml_models_are_refused_unless_opted_in(self):
        from latent_team.team import LatentTeam
        model = tiny_team().model
        with self.assertRaises(NotImplementedError):
            LatentTeam("tiny", device="cpu", dtype=torch.float32, model=model, tokenizer=CharTokenizer())

    def test_chatml_turns_close_and_skip_the_system_block(self):
        team = tiny_team()
        team.tokenizer.chat_template = "{% for m in messages %}<|im_start|>...{% endfor %}"
        self.assertEqual(team.turn("hi"), "<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n")
        self.assertEqual(team.close_turn(), "<|im_end|>\n")

    def test_decoding_stops_at_the_budget_and_counts_exactly(self):
        team = tiny_team()
        texts, counts = team.generate(["count please"], max_new_tokens=5)
        self.assertLessEqual(counts[0], 5)
        self.assertEqual(len(texts[0].split()) if texts[0] else 0, counts[0])

    def test_text_systems_run_and_count_tokens(self):
        team = tiny_team()
        answers, receipt = team.text_mas(["1+1?"], max_agent_tokens=4, max_new_tokens=4)
        self.assertEqual(len(answers), 1)
        self.assertLessEqual(receipt.generated_tokens[0], 16)
        single, receipt = team.single(["1+1?"], max_new_tokens=4)
        self.assertLessEqual(receipt.generated_tokens[0], 4)


class AnswerTest(unittest.TestCase):
    def test_answer_extraction(self):
        from latent_team.evaluate import correct, gold_number, predicted_number
        self.assertEqual(gold_number("She pays 3*4=12\n#### 1,200"), 1200.0)
        self.assertEqual(predicted_number("So 5 + 7 = 12. The answer is 12."), 12.0)
        self.assertEqual(predicted_number("Total: \\boxed{18}"), 18.0)
        self.assertEqual(predicted_number("It costs $1,250.50 in all"), 1250.5)
        self.assertTrue(correct("The answer is 72", 72.0))
        self.assertFalse(correct("The answer is 7, not 72", 72.0))
        self.assertFalse(correct("no number", 3.0))


if __name__ == "__main__":
    unittest.main()
