"""M2b correctness checks that run before any training (CPU, tiny random models).

Covers: exact RoPE round trip, the identity check (a receiver's own cache through the
injection path decodes exactly like reading the text), alignment, causality of the
mapper, and gradient flow from the receiver's loss into the mapper.
"""
import unittest

try:
    import torch
    from transformers import LlamaConfig, LlamaForCausalLM, Qwen2Config, Qwen2ForCausalLM
    HAVE_TORCH = True
except ImportError:  # the runtime's own tests run without torch
    HAVE_TORCH = False


def tiny_llama():
    torch.manual_seed(0)
    config = LlamaConfig(vocab_size=97, hidden_size=64, intermediate_size=128, num_hidden_layers=4,
                         num_attention_heads=4, num_key_value_heads=2, rope_theta=100000.0,
                         max_position_embeddings=256, tie_word_embeddings=True)
    return LlamaForCausalLM(config).eval()


def tiny_qwen():
    torch.manual_seed(1)
    config = Qwen2Config(vocab_size=89, hidden_size=48, intermediate_size=96, num_hidden_layers=3,
                         num_attention_heads=4, num_key_value_heads=2, rope_theta=1000000.0,
                         max_position_embeddings=256, tie_word_embeddings=True)
    return Qwen2ForCausalLM(config).eval()


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for M2b")
class RopeTest(unittest.TestCase):
    def test_remove_then_apply_is_exact(self):
        from latent_transfer.kv import apply_rope, remove_rope, rope_tables
        model = tiny_llama()
        keys = torch.randn(2, 2, 7, 16)
        positions = torch.arange(7)[None].expand(2, 7)
        cos, sin = rope_tables(model, positions, torch.float32)
        torch.testing.assert_close(remove_rope(apply_rope(keys, cos, sin), cos, sin), keys, atol=1e-5, rtol=1e-5)


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for M2b")
class IdentityTest(unittest.TestCase):
    """The receiver's own de-RoPEd cache, re-RoPEd and injected, must decode like the text."""

    def test_injected_own_cache_matches_reading_the_text(self):
        from latent_transfer.kv import build_cache, continue_from_cache, greedy_after_cache, prefill
        model = tiny_llama()
        doc = torch.randint(3, 97, (1, 11))
        question = torch.randint(3, 97, (1, 5))
        mask = torch.ones_like(doc)

        with torch.no_grad():
            full = model(input_ids=torch.cat([doc, question], 1)).logits[:, -5:]
            own = prefill(model, doc, mask)
            injected = continue_from_cache(model, build_cache(model, own.keys, own.values), mask,
                                           question, torch.ones_like(question)).logits
        torch.testing.assert_close(injected, full, atol=1e-4, rtol=1e-4)

        # Greedy decoding through the injection path equals plain generation.
        own = prefill(model, doc, mask)
        tokens = greedy_after_cache(model, build_cache(model, own.keys, own.values), mask, question, 6, eos_ids=set())
        reference = model.generate(torch.cat([doc, question], 1), max_new_tokens=6, do_sample=False,
                                   eos_token_id=None, pad_token_id=0)[0, 16:].tolist()
        self.assertEqual(tokens, reference)

    def test_a_right_padded_row_matches_the_same_row_alone(self):
        from latent_transfer.kv import build_cache, continue_from_cache, prefill
        model = tiny_llama()
        short, long = torch.randint(3, 97, (1, 6)), torch.randint(3, 97, (1, 10))
        docs = torch.cat([torch.cat([short, torch.zeros(1, 4, dtype=torch.long)], 1), long])
        mask = torch.tensor([[1] * 6 + [0] * 4, [1] * 10])
        question = torch.randint(3, 97, (2, 3))
        with torch.no_grad():
            both = prefill(model, docs, mask)
            batched = continue_from_cache(model, build_cache(model, both.keys, both.values), mask,
                                          question, torch.ones_like(question)).logits[0]
            alone = model(input_ids=torch.cat([short, question[:1]], 1)).logits[0, -3:]
        torch.testing.assert_close(batched, alone, atol=1e-4, rtol=1e-4)


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for M2b")
class AlignmentTest(unittest.TestCase):
    def test_identical_tokenizers_give_integer_positions(self):
        from latent_transfer.align import causal_mask, sender_positions
        spans = [(0, 3), (3, 4), (4, 9), (9, 12)]
        self.assertEqual(sender_positions(spans, spans), [0.0, 1.0, 2.0, 3.0])
        mask = causal_mask(spans, spans)
        self.assertEqual(mask, [[j <= i for j in range(4)] for i in range(4)])

    def test_mask_never_shows_text_after_the_receiver_token(self):
        from latent_transfer.align import causal_mask, sender_positions
        sender = [(0, 2), (2, 7), (7, 8), (8, 12), (12, 13)]
        receiver = [(0, 4), (4, 6), (6, 12), (12, 13)]
        mask = causal_mask(sender, receiver)
        for j, (_, r_end) in enumerate(receiver):
            for i, (_, s_end) in enumerate(sender):
                self.assertEqual(mask[j][i], s_end <= r_end)
        positions = sender_positions(sender, receiver)
        self.assertEqual(positions, sorted(positions), "positions follow the text order")
        self.assertTrue(all(0 <= p <= len(receiver) - 0.5 for p in positions))

    def test_layer_groups_cover_every_layer_once(self):
        from latent_transfer.mapper import layer_groups
        for layers, blocks in [(24, 8), (32, 8), (30, 7), (5, 5)]:
            groups = layer_groups(layers, blocks)
            self.assertEqual(sum(groups, []), list(range(layers)))
            self.assertTrue(all(groups))


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for M2b")
class MapperTest(unittest.TestCase):
    def setUp(self):
        from latent_transfer.kv import model_shape, prefill
        from latent_transfer.mapper import Mapper, init_weights
        self.sender, self.receiver = tiny_qwen(), tiny_llama()
        torch.manual_seed(2)
        self.mapper = init_weights(Mapper(model_shape(self.sender), model_shape(self.receiver),
                                          receiver_embed_dim=64, dim=32, heads=4, ffn=64, blocks=3))
        self.s_ids = torch.randint(3, 89, (2, 9))
        self.r_ids = torch.randint(3, 97, (2, 7))
        # Sender token i covers characters [2i, 2i+2); receiver token j covers [0,3),[3,5),...
        s_spans = [(2 * i, 2 * i + 2) for i in range(9)]
        r_spans = [(0, 3), (3, 5), (5, 8), (8, 11), (11, 13), (13, 16), (16, 18)]
        from latent_transfer.align import causal_mask, sender_positions
        self.pos = torch.tensor([sender_positions(s_spans, r_spans)] * 2)
        self.allowed = torch.tensor([causal_mask(s_spans, r_spans)] * 2)
        self.cache = prefill(self.sender, self.s_ids, torch.ones_like(self.s_ids))

    def run_mapper(self, cache):
        embeds = self.receiver.get_input_embeddings()(self.r_ids)
        return self.mapper(embeds, torch.ones_like(self.r_ids), cache.keys, cache.values, self.pos, self.allowed)

    def test_output_shapes_match_the_receiver_cache(self):
        keys, values = self.run_mapper(self.cache)
        self.assertEqual(len(keys), 4)
        for k, v in zip(keys, values):
            self.assertEqual(tuple(k.shape), (2, 2, 7, 16))
            self.assertEqual(tuple(v.shape), (2, 2, 7, 16))

    def test_later_sender_tokens_do_not_change_earlier_receiver_tokens(self):
        keys, _ = self.run_mapper(self.cache)
        changed = self.cache
        changed.keys = [k.clone() for k in changed.keys]
        for k in changed.keys:
            k[:, :, 6:] += 5.0  # sender tokens 6.. end at character 14 or later
        keys2, _ = self.run_mapper(changed)
        # Receiver tokens 0..4 end by character 13, so they cannot see sender tokens 6..
        for a, b in zip(keys, keys2):
            torch.testing.assert_close(a[:, :, :5], b[:, :, :5])
        self.assertFalse(all(torch.allclose(a[:, :, 5:], b[:, :, 5:]) for a, b in zip(keys, keys2)))

    def test_receiver_loss_reaches_the_mapper_through_the_frozen_receiver(self):
        from latent_transfer.kv import build_cache, continue_from_cache
        for p in self.receiver.parameters():
            p.requires_grad_(False)
        keys, values = self.mapper.scaled(*self.run_mapper(self.cache))
        cache = build_cache(self.receiver, keys, values)
        suffix = torch.randint(3, 97, (2, 4))
        out = continue_from_cache(self.receiver, cache, torch.ones_like(self.r_ids), suffix, torch.ones_like(suffix))
        loss = torch.nn.functional.cross_entropy(out.logits[:, :-1].reshape(-1, 97), suffix[:, 1:].reshape(-1))
        loss.backward()
        grads = [p.grad for p in self.mapper.parameters() if p.requires_grad]
        self.assertTrue(all(g is not None for g in grads), "every mapper parameter gets a gradient")
        self.assertGreater(sum(float(g.abs().sum()) for g in grads), 0.0)
        self.assertTrue(all(p.grad is None for p in self.receiver.parameters()))



class ScoringTest(unittest.TestCase):
    """SQuAD scoring, including the length-insensitive containment metric (no torch needed)."""

    def test_f1_and_contains(self):
        from latent_transfer.data import contains, f1
        self.assertEqual(f1("Denver Broncos", ["Denver Broncos"]), 1.0)
        self.assertLess(f1("The team that won was the Denver Broncos", ["Denver Broncos"]), 0.5)
        self.assertEqual(contains("The team that won was the Denver Broncos", ["Denver Broncos"]), 1.0)
        self.assertEqual(contains("Broncos", ["Denver Broncos"]), 0.0)
        self.assertEqual(contains("Geminis", ["Gemini"]), 0.0)
        self.assertEqual(contains("anything", [""]), 0.0)

if __name__ == "__main__":
    unittest.main()
