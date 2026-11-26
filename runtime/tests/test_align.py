"""L3: cross-tokenizer alignment on hard text, and the optional norm calibration.

The span arithmetic and the calibration reference need only the standard library. The
batch and tensor checks skip without torch; the real-tokenizer check skips unless
transformers and locally cached tokenizers are present.

Span fixtures are the offsets real tokenizers returned in the audit (docs/evals.md, L3).
"""
import math
import unittest
from fractions import Fraction

from latent_transfer.align import (ALIGNMENT_RULE, RULE_RAW, RULE_REFINED, align_document, blind_receiver,
                                   causal_mask, classify, common_end, refine_spans, sender_positions,
                                   unread_sender, visible_counts)
from latent_transfer.norm import calibrate_rows, l2, mean_norm, scale_factor

try:
    import torch
    HAVE_TORCH = True
except ImportError:
    HAVE_TORCH = False

# "hi <emoji> ok": Phi-3.5 reports the emoji's whole span for each of its four byte tokens.
PHI_EMOJI = [(0, 2), (2, 3), (3, 4), (3, 4), (3, 4), (3, 4), (4, 7)]
# The same text on Granite: a token that ends inside the emoji reports all of it.
GRANITE_EMOJI = [(0, 2), (2, 4), (3, 4), (4, 7)]
QWEN_EMOJI = [(0, 2), (2, 4), (4, 7)]
# "e" + combining acute + "a": Qwen composes the first two and covers only the "e".
QWEN_COMBINING = [(0, 1), (2, 3)]
PHI_COMBINING = [(0, 1), (1, 2), (2, 3)]


def identity(spans):
    size = len(spans)
    return (sender_positions(spans, spans) == [float(i) for i in range(size)] and
            causal_mask(spans, spans) == [[i <= j for i in range(size)] for j in range(size)])


class RefineSpansTest(unittest.TestCase):
    def test_a_clean_partition_comes_back_unchanged(self):
        spans = [(0, 3), (3, 4), (4, 9), (9, 12)]
        refined = refine_spans(spans, 12)
        self.assertEqual(refined, spans)
        self.assertTrue(all(type(value) is int for span in refined for value in span))

    def test_tokens_sharing_one_character_divide_it_in_order(self):
        refined = refine_spans(PHI_EMOJI, 7)
        quarter = Fraction(1, 4)
        self.assertEqual(refined[2:6], [(3, 3 + quarter), (3 + quarter, 3 + 2 * quarter),
                                        (3 + 2 * quarter, 3 + 3 * quarter), (3 + 3 * quarter, 4)])
        self.assertEqual(refined[:2] + refined[6:], [(0, 2), (2, 3), (4, 7)])

    def test_a_token_that_ends_inside_a_character_shares_it_with_the_next(self):
        half = Fraction(1, 2)
        self.assertEqual(refine_spans(GRANITE_EMOJI, 7), [(0, 2), (2, 3 + half), (3 + half, 4), (4, 7)])

    def test_uncovered_characters_join_the_token_before_them(self):
        self.assertEqual(refine_spans(QWEN_COMBINING, 3), [(0, 2), (2, 3)])

    def test_uncovered_characters_at_the_start_and_the_end(self):
        self.assertEqual(refine_spans([(2, 4), (4, 6)], 9), [(0, 4), (4, 9)])
        self.assertEqual(refine_spans([(2, 4), (4, 6)]), [(0, 4), (4, 6)], "without the length the end stays")

    def test_zero_width_tokens_stay_zero_width(self):
        self.assertEqual(refine_spans([(0, 0), (0, 3), (3, 5), (5, 5)], 5), [(0, 0), (0, 3), (3, 5), (5, 5)])

    def test_refined_spans_tile_the_text(self):
        for raw, length in ((PHI_EMOJI, 7), (GRANITE_EMOJI, 7), (QWEN_EMOJI, 7), (QWEN_COMBINING, 3)):
            refined = refine_spans(raw, length)
            self.assertEqual(refined[0][0], 0)
            self.assertEqual(refined[-1][1], length)
            for (_, end), (start, _) in zip(refined, refined[1:]):
                self.assertEqual(end, start)

    def test_spans_out_of_text_order_are_refused(self):
        with self.assertRaises(ValueError):
            refine_spans([(3, 5), (0, 3)])
        with self.assertRaises(ValueError):
            refine_spans([(3, 2)])

    def test_empty(self):
        self.assertEqual(refine_spans([], 0), [])
        self.assertEqual(refine_spans([], 4), [])


class IdentityTest(unittest.TestCase):
    """The same tokenizer on both sides: token i sits at position i and reads tokens 0..i."""

    def test_raw_offsets_break_identity_on_shared_characters(self):
        # The defect: every byte piece of the emoji lands on the last piece's position and
        # the first piece may read the three after it.
        self.assertFalse(identity(PHI_EMOJI))
        self.assertTrue(causal_mask(PHI_EMOJI, PHI_EMOJI)[2][5])

    def test_refined_spans_restore_identity(self):
        for raw, length in ((PHI_EMOJI, 7), (GRANITE_EMOJI, 7), (QWEN_COMBINING, 3),
                            ([(0, 1), (1, 2), (1, 2), (1, 2)], 2),          # thirds: exact, no float drift
                            ([(0, 1), (0, 1), (1, 2), (2, 3), (3, 4)], 4)):  # word marker on a CJK character
            self.assertTrue(identity(refine_spans(raw, length)), raw)

    def test_bos_on_both_sides_keeps_identity(self):
        spans = [(0, 0), (0, 3), (3, 5)]
        self.assertTrue(identity(spans))

    def test_bos_on_one_side_only(self):
        sender, receiver = [(0, 0), (0, 3), (3, 5)], [(0, 3), (3, 5)]
        self.assertEqual(sender_positions(sender, receiver), [0.0, 0.0, 1.0])
        self.assertEqual(causal_mask(sender, receiver), [[True, True, False], [True, True, True]])
        # A receiver BOS reads nothing from a sender without one: it is blind, and counted.
        self.assertEqual(blind_receiver(receiver, sender), [True, False, False])


class CrossTokenizerTest(unittest.TestCase):
    def test_a_receiver_piece_never_reads_a_later_piece_of_the_same_character(self):
        sender, receiver = refine_spans(PHI_EMOJI, 7), refine_spans(GRANITE_EMOJI, 7)
        mask = causal_mask(sender, receiver)
        # Granite's " + three bytes" token ends at 3.5: it reads Phi's first two byte tokens only.
        self.assertEqual(mask[1], [True, True, True, True, False, False, False])
        self.assertEqual(mask[2], [True, True, True, True, True, True, False])
        positions = sender_positions(sender, receiver)
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(len(set(positions)), len(positions), "no two sender tokens share a position")

    def test_the_composed_token_reads_the_combining_mark(self):
        raw = causal_mask(PHI_COMBINING, QWEN_COMBINING)
        self.assertFalse(raw[0][1], "rule 1: Qwen's composed token cannot read the accent it contains")
        refined = causal_mask(refine_spans(PHI_COMBINING, 3), refine_spans(QWEN_COMBINING, 3))
        self.assertEqual(refined, [[True, True, False], [True, True, True]])

    def test_positions_stay_in_range_and_ordered(self):
        sender = [(0, 2), (2, 7), (7, 8), (8, 12), (12, 13)]
        receiver = [(0, 4), (4, 6), (6, 12), (12, 13)]
        positions = sender_positions(sender, receiver)
        self.assertEqual(positions, sorted(positions))
        self.assertTrue(all(0 <= p <= len(receiver) - 0.5 for p in positions))
        self.assertEqual(visible_counts(sender, receiver), [1, 1, 4, 5])

    def test_classify(self):
        sender = [(0, 4), (4, 9), (9, 10), (10, 11), (11, 14), (14, 16), (16, 16)]
        receiver = [(0, 4), (4, 6), (6, 9), (9, 11), (11, 13), (13, 15), (15, 16)]
        self.assertEqual(classify(sender, receiver), ["one_to_one", "one_to_many", "many_to_one", "many_to_one",
                                                      "crossing", "crossing", "unaligned"])
        self.assertEqual(classify([(0, 0), (0, 2)], [(0, 0), (0, 2)]), ["one_to_one", "one_to_one"])
        self.assertEqual(classify([(0, 2), (2, 5)], [(0, 2)]), ["one_to_one", "unaligned"])
        self.assertEqual(classify([(0, 2)], []), ["unaligned"])

    def test_classify_with_divided_characters(self):
        sender, receiver = refine_spans(PHI_EMOJI, 7), refine_spans(QWEN_EMOJI, 7)
        self.assertEqual(classify(sender, receiver), ["one_to_one"] + ["many_to_one"] * 5 + ["one_to_one"])
        self.assertEqual(classify(receiver, sender), ["one_to_one", "one_to_many", "one_to_one"])


class CutTest(unittest.TestCase):
    """Both sides must end over the same characters."""
    SENDER = [(0, 3), (3, 6), (6, 9), (9, 12)]
    RECEIVER = [(0, 2), (2, 7), (7, 9), (9, 12)]

    def test_rule_1_leaves_a_tail_nobody_reads(self):
        # Receiver truncated to two tokens (ends at 7), sender to three (ends at 9).
        keep_s, s_spans, keep_r, r_spans = align_document(self.SENDER[:3], self.RECEIVER[:2], rule=RULE_RAW)
        self.assertEqual((keep_s, keep_r), ([0, 1], [0, 1]))
        # Sender covers 0..6, receiver 0..7: the receiver's last token sits over a character
        # (6) whose sender token was dropped. The mirror case leaves a sender token unread:
        keep_s, s_spans, keep_r, r_spans = align_document(self.RECEIVER[:2], self.SENDER[:3], rule=RULE_RAW)
        self.assertEqual(unread_sender(s_spans, r_spans), [False, True])

    def test_rule_2_cuts_at_a_boundary_both_sides_share(self):
        self.assertEqual(common_end(self.SENDER[:3], self.RECEIVER[:2]), 0)
        self.assertEqual(common_end(self.SENDER, self.RECEIVER), 12)
        keep_s, s_spans, keep_r, r_spans = align_document(self.SENDER, self.RECEIVER, 12, 3, RULE_REFINED)
        self.assertEqual((keep_s, keep_r), ([0, 1, 2], [0, 1, 2]))
        self.assertEqual(s_spans[-1][1], r_spans[-1][1])
        self.assertEqual(unread_sender(s_spans, r_spans), [False] * 3)

    def test_rule_2_without_a_shared_boundary_keeps_nothing(self):
        keep_s, _, keep_r, _ = align_document(self.SENDER, self.RECEIVER, 12, 2, RULE_REFINED)
        self.assertEqual((keep_s, keep_r), ([], []))

    def test_text_ending_in_a_combining_mark(self):
        # "e" + accent: Qwen's last offset is 1, Phi's is 2.
        keep_s, _, keep_r, _ = align_document([(0, 1), (1, 2)], [(0, 1)], rule=RULE_RAW)
        self.assertEqual(keep_s, [0], "rule 1 drops the sender's accent token without a record")
        keep_s, s_spans, keep_r, r_spans = align_document([(0, 1), (1, 2)], [(0, 1)], 2, 384, RULE_REFINED)
        self.assertEqual((keep_s, keep_r), ([0, 1], [0]))
        self.assertEqual(unread_sender(s_spans, r_spans), [False, False])

    def test_untruncated_text_drops_nothing_and_leaves_nothing_unread(self):
        cases = [(PHI_EMOJI, GRANITE_EMOJI, 7), (GRANITE_EMOJI, QWEN_EMOJI, 7), (PHI_COMBINING, QWEN_COMBINING, 3),
                 (QWEN_COMBINING, PHI_COMBINING, 3)]
        for sender, receiver, length in cases:
            keep_s, s_spans, keep_r, r_spans = align_document(sender, receiver, length, 384, RULE_REFINED)
            self.assertEqual((len(keep_s), len(keep_r)), (len(sender), len(receiver)))
            self.assertFalse(any(unread_sender(s_spans, r_spans)))
            self.assertEqual(s_spans[-1][1], r_spans[-1][1])

    def test_empty_side_and_unknown_rule(self):
        self.assertEqual(align_document([], [(0, 2)], 2, 384, RULE_REFINED), ([], [], [], []))
        self.assertEqual(align_document([], [(0, 2)], rule=RULE_RAW), ([], [], [], []))
        with self.assertRaises(ValueError):
            align_document([(0, 2)], [(0, 2)], 2, 384, rule=3)

    def test_new_work_uses_rule_2(self):
        self.assertEqual(ALIGNMENT_RULE, RULE_REFINED)


class NormArithmeticTest(unittest.TestCase):
    ROWS = [[3.0, 4.0], [6.0, 8.0], [0.0, 0.0], [30.0, 40.0]]   # norms 5, 10, 0, 50

    def test_scale_factor(self):
        self.assertEqual(scale_factor(5.0, 10.0), 2.0)
        self.assertEqual(scale_factor(0.0, 10.0), 1.0, "a zero vector is left alone")
        self.assertEqual(scale_factor(1.0, 100.0, max_scale=4), 4.0)
        self.assertEqual(scale_factor(100.0, 1.0, max_scale=4), 0.25)
        with self.assertRaises(ValueError):
            scale_factor(1.0, 1.0, max_scale=0.5)

    def test_group_scale_moves_the_mean_norm_and_keeps_ratios(self):
        mask = [1, 1, 0, 0]
        self.assertEqual(mean_norm(self.ROWS, mask), 7.5)
        out = calibrate_rows(self.ROWS, 15.0, mask)
        self.assertEqual(out[:2], [[6.0, 8.0], [12.0, 16.0]])
        self.assertEqual(out[2:], self.ROWS[2:], "padding is not rescaled")
        self.assertAlmostEqual(mean_norm(out, mask), 15.0)

    def test_per_token_scale_gives_every_real_token_the_target_norm(self):
        out = calibrate_rows(self.ROWS, 1.0, [1, 1, 1, 0], per_token=True)
        self.assertAlmostEqual(l2(out[0]), 1.0)
        self.assertAlmostEqual(l2(out[1]), 1.0)
        self.assertEqual(out[2], [0.0, 0.0])
        self.assertEqual(out[3], [30.0, 40.0])
        self.assertAlmostEqual(out[0][0] / out[0][1], 0.75, msg="direction kept")

    def test_the_cap_bounds_each_scale(self):
        out = calibrate_rows(self.ROWS, 1000.0, per_token=True, max_scale=2)
        self.assertEqual(out[0], [6.0, 8.0])
        self.assertEqual(out[3], [60.0, 80.0])


@unittest.skipUnless(HAVE_TORCH, "torch is needed for the batch and tensor checks")
class NormTensorTest(unittest.TestCase):
    def test_states_match_the_reference(self):
        from latent_transfer.norm import calibrate_states, norm_stats
        torch.manual_seed(0)
        states = torch.randn(2, 5, 8, dtype=torch.float64)
        mask = torch.tensor([[1, 1, 1, 1, 1], [1, 1, 1, 0, 0]])
        for per_token in (False, True):
            for cap in (None, 1.5):
                got = calibrate_states(states, 3.0, mask, per_token=per_token, max_scale=cap)
                for row in range(2):
                    want = calibrate_rows(states[row].tolist(), 3.0, mask[row].tolist(), per_token, cap)
                    self.assertTrue(torch.allclose(got[row], torch.tensor(want, dtype=torch.float64), atol=1e-6))
        stats = norm_stats(calibrate_states(states, 3.0, mask, per_token=True), mask)
        self.assertAlmostEqual(stats["mean"], 3.0, places=5)
        self.assertEqual(stats["count"], 8)

    def test_a_padded_row_matches_the_row_alone(self):
        from latent_transfer.norm import calibrate_states
        torch.manual_seed(1)
        states = torch.randn(2, 4, 6)
        mask = torch.tensor([[1, 1, 1, 1], [1, 1, 0, 0]])
        together = calibrate_states(states, 2.0, mask)
        alone = calibrate_states(states[1:, :2], 2.0, mask[1:, :2])
        self.assertTrue(torch.allclose(together[1, :2], alone[0], atol=1e-6))

    def test_cache_rms_moves_to_sigma_per_layer_and_head(self):
        from latent_transfer.norm import calibrate_cache
        torch.manual_seed(2)
        layers, heads, tokens, dim = 3, 2, 5, 4
        keys = [torch.randn(2, heads, tokens, dim) * (layer + 1) for layer in range(layers)]
        values = [torch.randn(2, heads, tokens, dim) * 0.1 for _ in range(layers)]
        sigma = torch.rand(layers, heads, 2) + 0.5
        mask = torch.tensor([[1, 1, 1, 1, 1], [1, 1, 1, 0, 0]])
        out_keys, out_values = calibrate_cache(keys, values, sigma, mask)
        weight = mask.float()[:, None, :, None]
        for kind, tensors in enumerate((out_keys, out_values)):
            for layer, tensor in enumerate(tensors):
                rms = ((tensor ** 2 * weight).sum((2, 3)) / (mask.sum(-1)[:, None] * dim)).sqrt()
                self.assertTrue(torch.allclose(rms, sigma[layer, :, kind][None].expand(2, heads), atol=1e-5))
        # Direction is untouched: every head is its input times one positive number.
        ratio = out_keys[1][0, 0] / keys[1][0, 0]
        self.assertTrue(torch.allclose(ratio, ratio.flatten()[0].expand_as(ratio), atol=1e-4))
        capped, _ = calibrate_cache(keys, values, sigma, mask, max_scale=1.0)
        self.assertTrue(all(torch.equal(a, b) for a, b in zip(capped, keys)), "a cap of 1 changes nothing")


class FakeTokenizer:
    """Splits text at the given character offsets; honours truncation like a fast tokenizer."""

    def __init__(self, cut):
        self.cut = cut

    def __call__(self, text, add_special_tokens=False, return_offsets_mapping=True, truncation=False,
                 max_length=None, verbose=True):
        spans = self.cut(text)
        if truncation and max_length is not None:
            spans = spans[:max_length]
        return {"input_ids": [1 + (hash(text[int(a):int(b)]) % 50) for a, b in spans], "offset_mapping": spans}


def words(text):
    """One token per run of non-space characters, the space before it included."""
    spans, start = [], 0
    for index in range(1, len(text) + 1):
        if index == len(text) or (text[index] == " " and text[index - 1] != " "):
            spans.append((start, index))
            start = index
    return spans


def pieces(size):
    return lambda text: [(i, min(len(text), i + size)) for i in range(0, len(text), size)]


@unittest.skipUnless(HAVE_TORCH, "torch is needed for the batch and tensor checks")
class MakePairTest(unittest.TestCase):
    TEXTS = ["alpha beta gamma delta", "one two"]

    def test_rule_1_is_the_batch_main_built_before_the_audit(self):
        from latent_transfer.batch import make_pair
        sender, receiver = FakeTokenizer(words), FakeTokenizer(pieces(4))
        batch = make_pair(sender, receiver, self.TEXTS, max_tokens=3, rule=RULE_RAW)
        for row, text in enumerate(self.TEXTS):
            s, r = words(text)[:3], pieces(4)(text)[:3]
            limit = min(s[-1][1], r[-1][1])
            s, r = [x for x in s if x[1] <= limit], [x for x in r if x[1] <= limit]
            self.assertEqual(int(batch.sender_mask[row].sum()), len(s))
            self.assertEqual(int(batch.receiver_mask[row].sum()), len(r))
            self.assertEqual(batch.sender_pos[row, :len(s)].tolist(),
                             torch.tensor(sender_positions(s, r)).tolist())
            self.assertEqual(batch.cross_allowed[row, :len(r), :len(s)].tolist(), causal_mask(s, r))
        self.assertFalse(batch.cross_allowed[1, :, 2:].any(), "padding is never visible")

    def test_rule_2_reports_what_does_not_line_up(self):
        from latent_transfer.batch import make_pair
        sender, receiver = FakeTokenizer(words), FakeTokenizer(pieces(4))
        batch = make_pair(sender, receiver, ["alpha beta gamma delta"], max_tokens=384)
        self.assertEqual(batch.dropped.tolist(), [[0, 0]])
        self.assertFalse(batch.sender_unread.any())
        # "alph" ends before the sender's first token "alpha" does: it reads the sink only.
        self.assertEqual(batch.receiver_blind[0].tolist(), [True, False, False, False, False, False])
        self.assertEqual(batch.receiver_blind[0].tolist(), (~batch.cross_allowed[0].any(-1)).tolist())
        moved = batch.to("cpu")
        self.assertEqual(moved.dropped.tolist(), [[0, 0]])

    def test_rule_2_truncation_ends_both_sides_together(self):
        from latent_transfer.batch import make_pair
        text = "alpha beta gamma delta"       # words end at 5, 10, 16, 22; pieces of 5 at 5, 10, 15, 20, 22
        batch = make_pair(FakeTokenizer(words), FakeTokenizer(pieces(5)), [text], max_tokens=3)
        self.assertEqual(int(batch.sender_mask.sum()), 2)
        self.assertEqual(int(batch.receiver_mask.sum()), 2)
        self.assertEqual(batch.dropped.tolist(), [[1, 1]])
        self.assertFalse(batch.sender_unread.any())

    def test_shared_characters_reach_the_tensors_exactly(self):
        from latent_transfer.batch import make_pair
        emoji = FakeTokenizer(lambda text: list(PHI_EMOJI))
        batch = make_pair(emoji, emoji, ["hi X ok"], max_tokens=384)
        self.assertEqual(batch.sender_pos[0].tolist(), [float(i) for i in range(7)])
        self.assertEqual(batch.cross_allowed[0].tolist(), [[i <= j for i in range(7)] for j in range(7)])
        raw = make_pair(emoji, emoji, ["hi X ok"], max_tokens=384, rule=RULE_RAW)
        self.assertNotEqual(raw.sender_pos[0].tolist(), [float(i) for i in range(7)])

    def test_an_empty_document_is_refused_under_both_rules(self):
        from latent_transfer.batch import make_pair
        for rule in (RULE_RAW, RULE_REFINED):
            with self.assertRaises(ValueError):
                make_pair(FakeTokenizer(words), FakeTokenizer(words), [""], rule=rule)


class AuditHelpersTest(unittest.TestCase):
    def test_vocabulary_entries_compare_as_bytes_across_families(self):
        from latent_transfer.align_audit import EDGE_CASES, surface
        marker, space = chr(0x2581), chr(0x120)
        self.assertEqual(surface(marker + "the", False), b" the")
        self.assertEqual(surface(space + "the", True), b" the")
        self.assertEqual(surface("<0xF0>", False), b"\xf0")
        self.assertEqual(surface(chr(0xC3) + chr(0xA9), True), "é".encode("utf-8"))
        names = [name for name, _ in EDGE_CASES]
        self.assertEqual(len(names), len(set(names)))
        self.assertGreaterEqual(len(names), 30)


def cached_tokenizers():
    try:
        from transformers import AutoTokenizer
        return [AutoTokenizer.from_pretrained(name, local_files_only=True)
                for name in ("Qwen/Qwen2.5-0.5B-Instruct", "HuggingFaceTB/SmolLM2-360M-Instruct")]
    except Exception:  # not installed, or not downloaded on this machine
        return None


class RealTokenizerTest(unittest.TestCase):
    def test_edge_cases_line_up_under_rule_2(self):
        tokenizers = cached_tokenizers()
        if not tokenizers:
            self.skipTest("transformers and locally cached tokenizers are needed")
        from latent_transfer.align_audit import EDGE_CASES
        from latent_transfer.batch import spans
        for name, text in EDGE_CASES:
            raw = [spans(tokenizer, text, 384, RULE_REFINED)[1] for tokenizer in tokenizers]
            for one in raw:
                self.assertTrue(identity(refine_spans(one, len(text))), name)
            for sender, receiver in ((raw[0], raw[1]), (raw[1], raw[0])):
                keep_s, s_spans, keep_r, r_spans = align_document(sender, receiver, len(text), 384, RULE_REFINED)
                self.assertEqual((len(keep_s), len(keep_r)), (len(sender), len(receiver)), name)
                self.assertEqual(s_spans[-1][1], len(text), name)
                self.assertEqual(r_spans[-1][1], len(text), name)
                self.assertFalse(any(unread_sender(s_spans, r_spans)), name)
                self.assertFalse(math.isnan(sum(sender_positions(s_spans, r_spans))), name)


if __name__ == "__main__":
    unittest.main()
