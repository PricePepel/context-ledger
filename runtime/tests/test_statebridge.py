"""Card L4: the arithmetic of the training-free alignment, its anchors and its pass rule.

The anchor, interval and table checks need only the standard library. The linear algebra
needs torch and is skipped without it, like the other latent_transfer checks.
"""
import json
import os
import unicodedata
import unittest

from latent_transfer import statebridge_anchors as anchors
from latent_transfer import statebridge_stats as stats

try:
    import torch
    from transformers import LlamaConfig, LlamaForCausalLM
    HAVE_TORCH = True
except ImportError:
    HAVE_TORCH = False

SP, BPE = chr(0x2581), chr(0x0120)


class FakeTokenizer:
    """A vocabulary of (raw token, decoded text) with the calls vocab_keys uses."""

    def __init__(self, entries, special=()):
        self.entries, self.all_special_ids = entries, list(special)

    def __len__(self):
        return len(self.entries)

    def convert_ids_to_tokens(self, token_id):
        return self.entries[token_id][0]

    def decode(self, ids):
        return self.entries[ids[0]][1]


class AnchorTest(unittest.TestCase):
    def test_word_start_markers_of_both_families_give_one_key(self):
        self.assertEqual(anchors.anchor_key(SP + "the", "the"), " the")       # SentencePiece drops the space
        self.assertEqual(anchors.anchor_key(BPE + "the", " the"), " the")     # byte-level keeps it
        self.assertEqual(anchors.anchor_key("the", "the"), "the")
        self.assertNotEqual(anchors.anchor_key("the", "the"), anchors.anchor_key(BPE + "the", " the"))

    def test_a_bare_marker_is_a_space_and_keeps_inner_spaces(self):
        self.assertEqual(anchors.anchor_key(SP, ""), " ")
        self.assertEqual(anchors.anchor_key(BPE, " "), " ")
        self.assertEqual(anchors.anchor_key(BPE + BPE, "  "), "  ")

    def test_broken_bytes_and_empty_tokens_are_not_anchors(self):
        self.assertIsNone(anchors.anchor_key("ðŁ", chr(0xFFFD)))
        self.assertIsNone(anchors.anchor_key("", ""))
        self.assertIsNone(anchors.anchor_key("x", ""))
        self.assertIsNone(anchors.anchor_key("x", None))

    def test_vocab_keys_skip_specials_and_keep_the_lowest_id(self):
        tokenizer = FakeTokenizer([("<s>", "<s>"), (SP + "cat", "cat"), ("cat", "cat"), (SP + "cat", "cat"),
                                   ("ð", chr(0xFFFD))], special=[0])
        self.assertEqual(anchors.vocab_keys(tokenizer), {" cat": 1, "cat": 2})

    def test_shared_anchors_across_two_vocabularies(self):
        sender = anchors.vocab_keys(FakeTokenizer([(SP + "cat", "cat"), ("s", "s"), (SP + "dog", "dog")]))
        receiver = anchors.vocab_keys(FakeTokenizer([("s", "s"), (BPE + "bird", " bird"), (BPE + "cat", " cat")]))
        self.assertEqual(anchors.shared_anchors(sender, receiver), [(0, 2, " cat"), (1, 0, "s")])
        self.assertEqual(anchors.overlap([(0, 2, " cat"), (1, 0, "s")], 3, 3),
                         {"anchors": 2, "senderShare": 0.6667, "receiverShare": 0.6667})

    def test_holdout_is_disjoint_and_complete(self):
        rows = [(i, i, str(i)) for i in range(25)]
        fit, held = anchors.split_holdout(rows, every=10)
        self.assertEqual(held, [rows[9], rows[19]])
        self.assertEqual(sorted(fit + held), rows)
        with self.assertRaises(ValueError):
            anchors.split_holdout(rows, every=1)

    def test_covered_share(self):
        self.assertEqual(anchors.covered_share([1, 2, 3, 4], {1: 0, 4: 0}), 0.5)
        self.assertEqual(anchors.covered_share([], {}), 1.0)


class StatsTest(unittest.TestCase):
    def test_interval_of_a_constant_difference_is_that_constant(self):
        diff, low, high = stats.paired_bootstrap([0.6] * 20, [0.1] * 20, rounds=200)
        for value in (diff, low, high):
            self.assertAlmostEqual(value, 0.5)

    def test_interval_brackets_the_mean_and_is_repeatable(self):
        a = [1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.5, 1.0, 0.0, 1.0]
        b = [0.0, 0.0, 1.0, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0, 1.0]
        first = stats.paired_bootstrap(a, b, rounds=500, seed=3)
        self.assertEqual(first, stats.paired_bootstrap(a, b, rounds=500, seed=3))
        self.assertAlmostEqual(first[0], 0.35)
        self.assertLess(first[1], first[0])
        self.assertGreater(first[2], first[0])
        with self.assertRaises(ValueError):
            stats.paired_bootstrap([1.0], [1.0, 2.0])

    def test_pass_needs_both_conditions(self):
        good, flat, weak = [0.9] * 30, [0.1] * 30, [0.5] * 30
        self.assertTrue(stats.pass_rule(good, flat, weak, rounds=200)["passed"])
        # Beats its mismatched control but is below the text summary: fails.
        below = stats.pass_rule(weak, flat, good, rounds=200)
        self.assertTrue(below["beatsMismatched"])
        self.assertFalse(below["atLeastSummary"])
        self.assertFalse(below["passed"])
        # As good as the summary but no better than a mismatched prefix: fails.
        same = stats.pass_rule(good, good, weak, rounds=200)
        self.assertFalse(same["beatsMismatched"])
        self.assertFalse(same["passed"])

    def test_a_marginal_secondary_pass_needs_a_repeat(self):
        aligned = [0.51] * 30
        marginal = stats.pass_rule(aligned, [0.5] * 30, [0.5] * 30, rounds=200, primary=False)
        self.assertTrue(marginal["passed"])
        self.assertTrue(marginal["needsRepeat"])
        self.assertFalse(stats.pass_rule(aligned, [0.5] * 30, [0.5] * 30, rounds=200)["needsRepeat"])

    def test_summary_and_tables(self):
        def cell(answer, score, ms=None):
            return {"answer": answer, "f1": score, "contains": score, "ms": ms, "hit": None}
        results = [{"id": str(i), "text": cell("a b", 1.0, 10.0), "t2t": cell("a", 0.5, 30.0),
                    "anchor/summary": cell("a", 0.2, 40.0), "anchor/summary mismatched": cell("c", 0.2)}
                   for i in range(8)]
        arms = ["text", "t2t", "anchor/summary", "anchor/summary mismatched"]
        summary = stats.summarize(results, arms, rounds=100)
        self.assertEqual(summary["arms"]["text"], {"f1": 1.0, "contains": 1.0, "words": 2.0, "ms": 10.0})
        self.assertNotIn("ms", summary["arms"]["anchor/summary mismatched"])
        self.assertFalse(summary["rule"]["anchor/summary"]["passed"])
        self.assertEqual(summary["differences"]["anchor/summary - t2t"], [-0.3, -0.3, -0.3])
        text = stats.render({"meta": {"sender": "S", "receiver": "R", "items": "squad, seed 0", "fit": {}},
                             "summary": summary})
        self.assertIn("| `anchor/summary` | 0.200 | 0.200 | 1.0 | 40 |", text)
        self.assertIn("| fail |", text)


class EdgeFileTest(unittest.TestCase):
    def test_edge_items_are_well_formed_and_hold_no_invisible_characters(self):
        path = os.path.join(os.path.dirname(__file__), "..", "latent_transfer", "statebridge_edge.json")
        with open(path, encoding="utf-8") as handle:
            raw = handle.read()
        hidden = [hex(ord(ch)) for ch in raw if unicodedata.category(ch) in ("Cc", "Cf") and ch not in "\t\n\r"]
        self.assertEqual(hidden, [])
        items = json.loads(raw)["items"]
        self.assertEqual(len(items), 8)
        self.assertEqual(len({item["id"] for item in items}), 8)
        for item in items:
            self.assertTrue(any(answer in item["context"] for answer in item["answers"]), item["id"])
        self.assertTrue(any(ord(ch) > 0xFFFF for item in items for ch in item["context"]))  # emoji


@unittest.skipUnless(HAVE_TORCH, "torch is needed for the alignment arithmetic")
class ArithmeticTest(unittest.TestCase):
    def setUp(self):
        from latent_transfer import statebridge
        self.sb = statebridge
        torch.manual_seed(0)

    def random_rotation(self, rows, columns):
        q, _ = torch.linalg.qr(torch.randn(max(rows, columns), max(rows, columns), dtype=torch.float64))
        return q[:rows, :columns]

    def fit(self, x, y, **kwargs):
        return self.sb.fit_map(self.sb.Moments(x.shape[1], y.shape[1]).add(x, y), **kwargs)

    def test_moments_in_blocks_equal_moments_at_once(self):
        x, y = torch.randn(50, 6, dtype=torch.float64), torch.randn(50, 4, dtype=torch.float64)
        whole = self.sb.Moments(6, 4).add(x, y)
        parts = self.sb.Moments(6, 4).add(x[:20], y[:20]).add(x[20:], y[20:])
        self.assertEqual(parts.count, 50)
        for name in ("sum_x", "sum_y", "xtx", "yty", "xty"):
            torch.testing.assert_close(getattr(parts, name), getattr(whole, name))
        with self.assertRaises(ValueError):
            self.sb.Moments(6, 4).add(x[:3], y[:2])

    def test_recovers_a_known_rotation_and_shift(self):
        x = torch.randn(400, 8, dtype=torch.float64)
        rotation = self.random_rotation(8, 8)
        shift = torch.randn(8, dtype=torch.float64)
        fitted = self.fit(x + 3.0, x @ rotation + shift, ridge=1e-9)
        torch.testing.assert_close(fitted.rotation.T @ fitted.rotation, torch.eye(8, dtype=torch.float64), atol=1e-9, rtol=0)
        fresh = torch.randn(5, 8, dtype=torch.float64)
        torch.testing.assert_close(fitted.apply(fresh + 3.0), fresh @ rotation + shift, atol=1e-6, rtol=1e-6)

    def test_wide_to_narrow_has_orthonormal_columns(self):
        # The receiver is a rotated 5-dimensional part of a 9-dimensional sender space, plus noise dimensions.
        x = torch.randn(600, 9, dtype=torch.float64)
        y = x[:, :5] @ self.random_rotation(5, 5)
        fitted = self.fit(x, y, ridge=1e-9)
        self.assertEqual(tuple(fitted.rotation.shape), (9, 5))
        torch.testing.assert_close(fitted.rotation.T @ fitted.rotation, torch.eye(5, dtype=torch.float64), atol=1e-9, rtol=0)
        self.assertEqual(tuple(fitted.apply(torch.randn(7, 9, dtype=torch.float64)).shape), (7, 5))
        error = (fitted.apply(x) - y).norm() / y.norm()
        self.assertLess(float(error), 0.2)

    def test_narrow_to_wide_has_orthonormal_rows(self):
        x = torch.randn(500, 4, dtype=torch.float64)
        y = x @ self.random_rotation(4, 7)
        fitted = self.fit(x, y, ridge=1e-6)
        self.assertEqual(tuple(fitted.rotation.shape), (4, 7))
        torch.testing.assert_close(fitted.rotation @ fitted.rotation.T, torch.eye(4, dtype=torch.float64), atol=1e-9, rtol=0)

    def test_whitening_gives_identity_covariance(self):
        scale = torch.tensor([5.0, 1.0, 0.2, 3.0], dtype=torch.float64)
        x = torch.randn(2000, 4, dtype=torch.float64) * scale
        fitted = self.fit(x, x.clone(), ridge=1e-12)
        white = (x - x.mean(0)) @ fitted.whiten_x
        torch.testing.assert_close(white.T @ white / 2000, torch.eye(4, dtype=torch.float64), atol=1e-6, rtol=0)

    def test_relative_ridge_scales_with_the_data(self):
        x, y = torch.randn(300, 5, dtype=torch.float64), torch.randn(300, 5, dtype=torch.float64)
        small = self.fit(x * 1e-3, y * 1e-3)
        large = self.fit(x, y)
        torch.testing.assert_close(small.rotation, large.rotation, atol=1e-8, rtol=0)
        fresh = torch.randn(3, 5, dtype=torch.float64)
        torch.testing.assert_close(small.apply(fresh * 1e-3) * 1e3, large.apply(fresh), atol=1e-8, rtol=1e-8)

    def test_a_fit_needs_two_rows(self):
        with self.assertRaises(ValueError):
            self.fit(torch.randn(1, 3), torch.randn(1, 3))

    def test_norm_calibration_and_anchoring_by_hand(self):
        vectors = torch.tensor([[3.0, 4.0], [0.0, 0.5]])
        calibrated = self.sb.norm_calibrate(vectors, 2.0)
        torch.testing.assert_close(calibrated, torch.tensor([[1.2, 1.6], [0.0, 2.0]]))
        vocab = torch.tensor([[10.0, 0.0], [0.0, 1.0], [1.0, 1.0], [0.0, 0.0]])
        self.assertEqual(self.sb.nearest_vocab(calibrated, vocab, chunk=2).tolist(), [2, 1])
        self.assertEqual(self.sb.nearest_vocab(calibrated, vocab, chunk=64).tolist(), [2, 1])
        anchored, ids = self.sb.anchor_to_vocab(calibrated, vocab, alpha=0.3)
        self.assertEqual(ids.tolist(), [2, 1])
        torch.testing.assert_close(anchored, torch.tensor([[0.7 * 1.2 + 0.3, 0.7 * 1.6 + 0.3], [0.0, 0.7 * 2.0 + 0.3]]))
        untouched, _ = self.sb.anchor_to_vocab(calibrated, vocab, alpha=0)
        torch.testing.assert_close(untouched, calibrated)
        self.assertAlmostEqual(self.sb.mean_vocab_norm(vocab), (10 + 1 + 2 ** 0.5 + 0) / 4, places=5)

    def test_zeroed_states_give_one_repeated_vector(self):
        x, y = torch.randn(200, 6, dtype=torch.float64), torch.randn(200, 4, dtype=torch.float64)
        vocab = torch.randn(30, 4, dtype=torch.float64)
        prefix, ids = self.sb.bridge(torch.zeros(5, 6, dtype=torch.float64), self.fit(x, y), vocab, 1.0)
        torch.testing.assert_close(prefix, prefix[:1].expand(5, 4))
        self.assertEqual(len(set(ids.tolist())), 1)

    def test_retrieval_accuracy_counts_rows_that_land_on_their_own_target(self):
        vocab = torch.randn(40, 6, dtype=torch.float64)
        rotation = self.random_rotation(6, 6)
        rows = vocab @ rotation.T          # sender rows are the receiver rows in another basis
        fitted = self.fit(rows, vocab, ridge=1e-9)
        self.assertEqual(self.sb.retrieval_accuracy(fitted, rows, list(range(40)), vocab), 1.0)
        shuffled = list(range(1, 40)) + [0]
        self.assertEqual(self.sb.retrieval_accuracy(fitted, rows, shuffled, vocab), 0.0)

    def test_per_message_fit_does_not_depend_on_the_states(self):
        """With fewer rows than dimensions the paper's fit returns the reference embeddings,
        each singular value d changed to sqrt(d^2 + K*lambda), whatever the states are."""
        rows, width, ridge = 12, 40, 1e-3
        reference = torch.randn(rows, width, dtype=torch.float64) * 0.05
        states = torch.randn(rows, width, dtype=torch.float64) * 80
        other_states = torch.randn(rows, width, dtype=torch.float64) * 80 + 7
        first = self.sb.per_message_map(states, reference, ridge).apply(states)
        second = self.sb.per_message_map(other_states, reference, ridge).apply(other_states)
        torch.testing.assert_close(first, second, atol=1e-7, rtol=0)
        mean = reference.mean(0)
        left, singular, right = torch.linalg.svd(reference - mean, full_matrices=False)
        keep = rows - 1  # centring leaves rows - 1 directions
        expected = (left[:, :keep] * (singular[:keep] ** 2 + rows * ridge).sqrt()) @ right[:keep] + mean
        torch.testing.assert_close(first, expected, atol=1e-7, rtol=0)
        # It is not the reference itself: the ridge inflates the small directions.
        self.assertGreater(float((first - reference).norm() / reference.norm()), 0.01)

    def test_with_more_rows_than_dimensions_the_states_do_matter(self):
        reference = torch.randn(200, 6, dtype=torch.float64)
        states, other_states = torch.randn(200, 6, dtype=torch.float64), torch.randn(200, 6, dtype=torch.float64)
        first = self.sb.per_message_map(states, reference).apply(states)
        second = self.sb.per_message_map(other_states, reference).apply(other_states)
        self.assertGreater(float((first - second).norm() / first.norm()), 0.5)


def tiny_model():
    torch.manual_seed(0)
    config = LlamaConfig(vocab_size=97, hidden_size=64, intermediate_size=128, num_hidden_layers=3,
                         num_attention_heads=4, num_key_value_heads=2, max_position_embeddings=256,
                         tie_word_embeddings=False)
    return LlamaForCausalLM(config).eval()


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for the model helpers")
class ModelHelperTest(unittest.TestCase):
    def setUp(self):
        from latent_transfer import statebridge
        self.sb = statebridge
        self.model = tiny_model()

    def test_final_states_are_what_the_output_embedding_reads(self):
        ids = torch.randint(3, 97, (1, 9))
        states, logits = self.sb.reading_states(self.model, ids)
        self.assertEqual(tuple(states.shape), (9, 64))
        torch.testing.assert_close(self.model.get_output_embeddings()(states), logits, atol=1e-5, rtol=1e-5)

    def test_generation_returns_the_state_behind_every_token(self):
        ids = torch.randint(3, 97, (1, 6))
        tokens, states = self.sb.generate_with_states(self.model, ids, 5, stop_ids=set())
        self.assertEqual(len(tokens), 5)
        self.assertEqual(tuple(states.shape), (5, 64))
        self.assertEqual(self.model.get_output_embeddings()(states).argmax(-1).tolist(), tokens)
        plain = self.model.generate(ids, attention_mask=torch.ones_like(ids), max_new_tokens=5, do_sample=False,
                                    pad_token_id=0)
        self.assertEqual(plain[0, 6:].tolist(), tokens)

    def test_a_trailing_stop_token_is_dropped_with_its_state(self):
        ids = torch.randint(3, 97, (1, 6))
        tokens, _ = self.sb.generate_with_states(self.model, ids, 5, stop_ids=set())
        cut, states = self.sb.generate_with_states(self.model, ids, 5, stop_ids={tokens[-1]})
        self.assertLess(len(cut), 5)
        self.assertEqual(states.shape[0], len(cut))
        self.assertEqual(cut, tokens[:len(cut)])

    def test_a_prefix_of_a_texts_own_embeddings_decodes_like_the_text(self):
        document, question = torch.randint(3, 97, (1, 11)), torch.randint(3, 97, (1, 5))
        embed = self.model.get_input_embeddings()
        with torch.no_grad():
            from_embeds = self.sb.answer_from_embeds(self.model, torch.cat([embed(document)[0], embed(question)[0]]),
                                                     6, eos_ids={1})
            ids = torch.cat([document, question], dim=1)
            from_ids = self.model.generate(ids, attention_mask=torch.ones_like(ids), max_new_tokens=6,
                                           do_sample=False, eos_token_id=[1], pad_token_id=0)[0, 16:].tolist()
        self.assertEqual(from_embeds, [token for token in from_ids])


    def test_answers_are_plain_greedy_whatever_the_models_defaults_say(self):
        document = torch.randint(3, 97, (1, 12))
        embeds = self.model.get_input_embeddings()(document)[0]
        with torch.no_grad():
            plain = self.sb.answer_from_embeds(self.model, embeds, 8, eos_ids={1})
            self.model.generation_config.repetition_penalty = 5.0
            try:
                penalised = self.sb.answer_from_embeds(self.model, embeds, 8, eos_ids={1})
            finally:
                self.model.generation_config.repetition_penalty = 1.0
            # Argmax by hand, one token at a time.
            ids, by_hand = document, []
            for _ in range(8):
                token = int(self.model(input_ids=ids).logits[0, -1].argmax())
                if token == 1:
                    break
                by_hand.append(token)
                ids = torch.cat([ids, torch.tensor([[token]])], dim=1)
        self.assertEqual(penalised, plain)
        self.assertEqual([t for t in plain if t != 1], by_hand)


if __name__ == "__main__":
    unittest.main()
