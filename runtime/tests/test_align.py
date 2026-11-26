"""L3: cross-tokenizer alignment on hard text, and the optional norm calibration.

The span arithmetic and the calibration reference need only the standard library. The
batch and tensor checks skip without torch; the real-tokenizer check skips unless
transformers and locally cached tokenizers are present.

Span fixtures are the offsets real tokenizers returned in the audit (docs/evals.md, L3).
"""
import json
import unittest
from fractions import Fraction

from latent_transfer.align import (ALIGNMENT_RULE, RULE_RAW, RULE_REFINED, align_document, blind_receiver,
                                   causal_mask, classify, common_cut, reading_keys, refine_spans,
                                   sender_positions, unread_sender, visible_counts)
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
# A CJK character behind SentencePiece's word marker: both report the character.
PHI_CJK = [(0, 1), (0, 1), (1, 2), (2, 3), (3, 4)]
FIXTURES = [(PHI_EMOJI, 7), (GRANITE_EMOJI, 7), (QWEN_EMOJI, 7), (QWEN_COMBINING, 3), (PHI_COMBINING, 3),
            (PHI_CJK, 4), ([(0, 1), (1, 2), (1, 2), (1, 2)], 2)]


def owners(raw, length):
    """Independent oracle, from raw offsets: for every character, the tokens that touch it.
    A character no token reports belongs to the token before it (the first, at the start)."""
    table = [[i for i, (start, end) in enumerate(raw) if start <= char < end] for char in range(length)]
    first = next((i for i, (start, end) in enumerate(raw) if end > start), None)
    for char in range(length):
        if not table[char]:
            table[char] = [table[char - 1][-1]] if char and table[char - 1] else ([first] if first is not None else [])
    return table


def leak(sender_raw, receiver_raw, length, mask, sender_kept=None, receiver_kept=None):
    """A (receiver, sender) pair where the receiver reads a sender token that has touched a
    character the receiver has not finished; None when the mask is causal."""
    s_owner, r_owner = owners(sender_raw, length), owners(receiver_raw, length)
    sender_kept = len(sender_raw) if sender_kept is None else sender_kept
    receiver_kept = len(receiver_raw) if receiver_kept is None else receiver_kept
    for j in range(receiver_kept):
        finished = next((char for char in range(length) if any(k > j for k in r_owner[char])), length)
        for i in range(sender_kept):
            touched = max((char + 1 for char in range(length) if any(k <= i for k in s_owner[char])), default=0)
            if mask[j][i] and touched > finished:
                return j, i
    return None


def identity(spans):
    """Same tokenizer on both sides: position i for token i; no token reads a later one."""
    size = len(spans)
    mask = causal_mask(spans, spans)
    return (sender_positions(spans, spans) == [float(i) for i in range(size)] and
            not any(mask[j][i] for j in range(size) for i in range(j + 1, size)))


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

    def test_two_divided_characters_in_a_row(self):
        half = Fraction(1, 2)
        self.assertEqual(refine_spans([(3, 4), (3, 4), (4, 5), (4, 5)]),
                         [(0, 3 + half), (3 + half, 4), (4, 4 + half), (4 + half, 5)])

    def test_uncovered_characters_join_the_token_before_them(self):
        self.assertEqual(refine_spans(QWEN_COMBINING, 3), [(0, 2), (2, 3)])

    def test_uncovered_characters_at_the_start_and_the_end(self):
        self.assertEqual(refine_spans([(2, 4), (4, 6)], 9), [(0, 4), (4, 9)])
        self.assertEqual(refine_spans([(2, 4), (4, 6)]), [(0, 4), (4, 6)], "without the length the end stays")

    def test_zero_width_tokens_stay_zero_width(self):
        self.assertEqual(refine_spans([(0, 0), (0, 3), (3, 5), (5, 5)], 5), [(0, 0), (0, 3), (3, 5), (5, 5)])
        self.assertEqual(refine_spans([(0, 0), (4, 4)], 9), [(0, 0), (4, 4)])

    def test_overlaps_longer_than_one_character_still_tile(self):
        # Review round 1: these came back overlapping, or with decreasing ends.
        self.assertEqual(refine_spans([(0, 3), (1, 4)]), [(0, 2), (2, 4)])
        self.assertEqual(refine_spans([(0, 2), (0, 2)]), [(0, 1), (1, 2)])
        self.assertEqual(refine_spans([(0, 4), (1, 2)]), [(0, Fraction(5, 2)), (Fraction(5, 2), 4)])

    def test_refined_spans_tile_the_text(self):
        extra = [([(0, 3), (1, 4)], 4), ([(0, 2), (0, 2)], 2), ([(0, 4), (1, 2)], 4), ([(1, 2), (1, 2), (4, 6)], 8)]
        for raw, length in FIXTURES + extra:
            refined = [span for span in refine_spans(raw, length) if span[1] > span[0]]
            self.assertEqual(len(refined), len(raw))
            self.assertEqual(refined[0][0], 0)
            self.assertEqual(refined[-1][1], length)
            for (start, end), (following, _) in zip(refined, refined[1:]):
                self.assertEqual(end, following)
                self.assertLess(start, end)

    def test_spans_out_of_text_order_are_refused(self):
        with self.assertRaises(ValueError):
            refine_spans([(3, 5), (0, 3)])
        with self.assertRaises(ValueError):
            refine_spans([(3, 2)])

    def test_empty(self):
        self.assertEqual(refine_spans([], 0), [])
        self.assertEqual(refine_spans([], 4), [])


class IdentityTest(unittest.TestCase):
    """The same tokenizer on both sides: token i sits at position i and reads no later token."""

    def test_raw_offsets_break_identity_on_shared_characters(self):
        # The defect: every byte piece of the emoji lands on the last piece's position and
        # the first piece may read the three after it.
        self.assertEqual(sender_positions(PHI_EMOJI, PHI_EMOJI, RULE_RAW), [0.0, 1.0, 5.0, 5.0, 5.0, 5.0, 6.0])
        self.assertTrue(causal_mask(PHI_EMOJI, PHI_EMOJI, RULE_RAW)[2][5])

    def test_refined_spans_restore_identity(self):
        for raw, length in FIXTURES:
            self.assertTrue(identity(refine_spans(raw, length)), raw)

    def test_whole_character_tokens_read_themselves(self):
        spans = refine_spans(PHI_EMOJI, 7)
        mask = causal_mask(spans, spans)
        self.assertEqual([mask[i][i] for i in range(7)], [True, True, False, False, False, True, True])
        # The piece that completes the character reads all four pieces.
        self.assertEqual(mask[5], [True] * 6 + [False])
        self.assertEqual(blind_receiver(spans, spans), [False] * 7)

    def test_bos_on_both_sides_keeps_identity(self):
        spans = [(0, 0), (0, 3), (3, 5)]
        self.assertTrue(identity(spans))
        self.assertEqual(causal_mask(spans, spans), [[True, False, False], [True, True, False], [True, True, True]])

    def test_several_tokens_without_characters_keep_their_order(self):
        # Review round 1: both took position 0 and the first read the second.
        spans = [(0, 0), (0, 0), (0, 1), (1, 1)]
        self.assertEqual(sender_positions(spans, spans), [0.0, 1.0, 2.0, 3.0])
        self.assertEqual(causal_mask(spans, spans), [[i <= j for i in range(4)] for j in range(4)])

    def test_bos_on_one_side_only(self):
        sender, receiver = [(0, 0), (0, 3), (3, 5)], [(0, 3), (3, 5)]
        self.assertEqual(sender_positions(sender, receiver), [0.0, 0.0, 1.0])
        self.assertEqual(causal_mask(sender, receiver), [[True, True, False], [True, True, True]])
        # A receiver BOS reads nothing from a sender without one: it is blind, and counted.
        self.assertEqual(blind_receiver(receiver, sender), [True, False, False])


class CausalityTest(unittest.TestCase):
    def test_a_piece_of_a_character_reads_no_piece_of_it_until_the_character_is_complete(self):
        sender, receiver = refine_spans(PHI_EMOJI, 7), refine_spans(GRANITE_EMOJI, 7)
        mask = causal_mask(sender, receiver)
        # Granite's " + three bytes" token has not finished the emoji: it reads none of Phi's bytes.
        self.assertEqual(mask[1], [True, True, False, False, False, False, False])
        self.assertEqual(mask[2], [True, True, True, True, True, True, False])
        positions = sender_positions(sender, receiver)
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(len(set(positions)), len(positions), "no two sender tokens share a position")

    def test_pieces_split_differently_never_leak_bytes(self):
        # Review round 1: one emoji as 3 + 1 bytes (sender) and 1 + 1 + 2 bytes (receiver), every
        # token reporting (0, 1). By token count the receiver's second piece (two bytes read)
        # would read the sender's first (three bytes read).
        sender, receiver = refine_spans([(0, 1), (0, 1)], 1), refine_spans([(0, 1), (0, 1), (0, 1)], 1)
        self.assertEqual(causal_mask(sender, receiver), [[False, False], [False, False], [True, True]])

    def test_a_token_without_characters_carries_what_came_before_it(self):
        # Review round 1: the sender's zero-width token was written after it read character 0,
        # so a receiver BOS must not read it.
        sender, receiver = [(0, 1), (0, 0), (1, 2)], [(0, 0), (0, 2)]
        self.assertEqual(causal_mask(sender, receiver), [[False, False, False], [True, True, True]])
        self.assertEqual(blind_receiver(sender, receiver), [True, False])

    def test_the_composed_token_reads_the_combining_mark(self):
        raw = causal_mask(PHI_COMBINING, QWEN_COMBINING, RULE_RAW)
        self.assertFalse(raw[0][1], "rule 1: Qwen's composed token cannot read the accent it contains")
        refined = causal_mask(refine_spans(PHI_COMBINING, 3), refine_spans(QWEN_COMBINING, 3))
        self.assertEqual(refined, [[True, True, False], [True, True, True]])
        # And the other way: Phi's bare "e" must not read Qwen's composed token.
        back = causal_mask(refine_spans(QWEN_COMBINING, 3), refine_spans(PHI_COMBINING, 3))
        self.assertEqual(back, [[False, False], [True, False], [True, True]])

    def test_no_fixture_pair_leaks_under_rule_2(self):
        for sender, s_length in FIXTURES:
            for receiver, r_length in FIXTURES:
                if s_length != r_length:
                    continue
                s_spans, r_spans = refine_spans(sender, s_length), refine_spans(receiver, r_length)
                mask = causal_mask(s_spans, r_spans)
                self.assertIsNone(leak(sender, receiver, s_length, mask), (sender, receiver))
                self.assertFalse(any(unread_sender(s_spans, r_spans)), (sender, receiver))

    def test_the_oracle_catches_rule_1_leaks(self):
        self.assertIsNotNone(leak(PHI_EMOJI, PHI_EMOJI, 7, causal_mask(PHI_EMOJI, PHI_EMOJI, RULE_RAW)))
        self.assertIsNotNone(leak(QWEN_COMBINING, PHI_COMBINING, 3,
                                  causal_mask(QWEN_COMBINING, PHI_COMBINING, RULE_RAW)))

    def test_keys_are_ordered_integers(self):
        for raw, length in FIXTURES:
            spans = refine_spans(raw, length)
            for keys in reading_keys(spans, spans):
                self.assertEqual(keys, sorted(keys))
                self.assertTrue(all(type(key) is int for key in keys))
        with self.assertRaises(ValueError):
            reading_keys([(0, 1)], [(0, 1)], rule=3)

    def test_positions_stay_in_range_and_ordered(self):
        sender = [(0, 2), (2, 7), (7, 8), (8, 12), (12, 13)]
        receiver = [(0, 4), (4, 6), (6, 12), (12, 13)]
        for rule in (RULE_RAW, RULE_REFINED):
            positions = sender_positions(sender, receiver, rule)
            self.assertEqual(positions, sorted(positions))
            self.assertTrue(all(0 <= p <= len(receiver) - 0.5 for p in positions))
            self.assertEqual(visible_counts(sender, receiver, rule), [1, 1, 4, 5])
            self.assertEqual(causal_mask(sender, receiver, rule),
                             [[s_end <= r_end for _, s_end in sender] for _, r_end in receiver])


class RuleOneTest(unittest.TestCase):
    """Rule 1 is what main computed before the audit. The expected values below were produced
    by align.py at origin/main (6fa6249), not by the code under test."""
    SENDER = [(0, 0), (0, 3), (3, 4), (3, 4), (4, 7), (7, 7)]
    RECEIVER = [(0, 0), (0, 2), (2, 4), (3, 4), (4, 7)]

    def test_positions(self):
        self.assertEqual(sender_positions(self.SENDER, self.RECEIVER, RULE_RAW), [0.5, 1.25, 3.0, 3.0, 4.0, 4.5])
        self.assertEqual(sender_positions(self.SENDER, self.SENDER, RULE_RAW), [0.5, 1.0, 3.0, 3.0, 4.0, 5.0])
        self.assertEqual(sender_positions(self.RECEIVER, self.SENDER, RULE_RAW),
                         [0.5, 0.8333333333333333, 2.5, 3.0, 4.0])
        self.assertEqual(sender_positions([(0, 0), (0, 2)], [(0, 0), (0, 2)], RULE_RAW), [0.5, 1.0])

    def test_mask_and_counts(self):
        self.assertEqual(causal_mask(self.SENDER, self.RECEIVER, RULE_RAW),
                         [[True, False, False, False, False, False], [True, False, False, False, False, False],
                          [True, True, True, True, False, False], [True, True, True, True, False, False],
                          [True, True, True, True, True, True]])
        self.assertEqual(visible_counts(self.SENDER, self.RECEIVER, RULE_RAW), [1, 1, 4, 4, 6])

    def test_rule_2_differs_on_the_same_spans(self):
        self.assertEqual(sender_positions(self.SENDER, self.SENDER)[0], 0.0)


class ClassifyTest(unittest.TestCase):
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
        self.assertEqual(unread_sender(s_spans, r_spans, RULE_RAW), [False, True])

    def test_rule_2_cuts_where_both_sides_can_stop(self):
        self.assertEqual(common_cut(self.SENDER[:3], self.RECEIVER[:2]), (0, 0))
        self.assertEqual(common_cut(self.SENDER, self.RECEIVER), (4, 4))
        keep_s, s_spans, keep_r, r_spans = align_document(self.SENDER, self.RECEIVER, 12, 3, RULE_REFINED)
        self.assertEqual((keep_s, keep_r), ([0, 1, 2], [0, 1, 2]))
        self.assertEqual(s_spans[-1][1], r_spans[-1][1])
        self.assertEqual(unread_sender(s_spans, r_spans), [False] * 3)

    def test_rule_2_without_a_shared_cut_keeps_nothing(self):
        keep_s, _, keep_r, _ = align_document(self.SENDER, self.RECEIVER, 12, 2, RULE_REFINED)
        self.assertEqual((keep_s, keep_r), ([], []))

    def test_a_cut_never_falls_inside_a_character(self):
        # Both sides cut to four tokens end inside the emoji (Phi after two of its four bytes).
        keep_s, s_spans, keep_r, r_spans = align_document(PHI_EMOJI, PHI_EMOJI, 7, 4, RULE_REFINED)
        self.assertEqual((keep_s, keep_r), ([0, 1], [0, 1]))
        keep_s, _, keep_r, _ = align_document(PHI_EMOJI, GRANITE_EMOJI, 7, 2, RULE_REFINED)
        self.assertEqual((keep_s, keep_r), ([0], [0]))

    def test_a_token_without_characters_is_not_a_place_to_cut(self):
        # Review round 1: both sides share the offset 2 of a zero-width token, yet their kept
        # tokens cover 0..3 and 0..4.
        cut = align_document([(0, 3), (2, 2), (3, 5)], [(0, 4), (2, 2), (4, 5)], 5, 2, RULE_REFINED)
        self.assertEqual(cut, ([], [], [], []))
        # Tokens without characters right after the cut stay with it; a lone BOS is no cut.
        self.assertEqual(common_cut([(0, 3), (3, 3), (3, 5)], [(0, 3), (3, 4)]), (2, 1))
        self.assertEqual(common_cut([(0, 0), (0, 3)], [(0, 0), (0, 2)]), (0, 0))

    def test_text_ending_in_a_combining_mark(self):
        # "e" + accent: Qwen's last offset is 1, Phi's is 2.
        keep_s, _, keep_r, _ = align_document([(0, 1), (1, 2)], [(0, 1)], rule=RULE_RAW)
        self.assertEqual(keep_s, [0], "rule 1 drops the sender's accent token without a record")
        keep_s, s_spans, keep_r, r_spans = align_document([(0, 1), (1, 2)], [(0, 1)], 2, 384, RULE_REFINED)
        self.assertEqual((keep_s, keep_r), ([0, 1], [0]))
        self.assertEqual(unread_sender(s_spans, r_spans), [False, False])

    def test_untruncated_text_drops_nothing_and_leaves_nothing_unread(self):
        for sender, s_length in FIXTURES:
            for receiver, r_length in FIXTURES:
                if s_length != r_length:
                    continue
                for budget in (384, None):
                    keep_s, s_spans, keep_r, r_spans = align_document(sender, receiver, s_length, budget)
                    self.assertEqual((len(keep_s), len(keep_r)), (len(sender), len(receiver)))
                    self.assertFalse(any(unread_sender(s_spans, r_spans)))
                    self.assertEqual(s_spans[-1][1], r_spans[-1][1])

    def test_every_truncation_of_every_fixture_pair_is_causal_and_fully_read(self):
        for sender, s_length in FIXTURES:
            for receiver, r_length in FIXTURES:
                if s_length != r_length:
                    continue
                for budget in range(1, 8):
                    keep_s, s_spans, keep_r, r_spans = align_document(sender, receiver, s_length, budget)
                    if not keep_s:
                        self.assertEqual(keep_r, [])
                        continue
                    self.assertEqual(max(end for _, end in s_spans), max(end for _, end in r_spans))
                    self.assertFalse(any(unread_sender(s_spans, r_spans)))
                    mask = causal_mask(s_spans, r_spans)
                    self.assertIsNone(leak(sender, receiver, s_length, mask, len(keep_s), len(keep_r)))

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

    def test_padding_is_returned_untouched_and_never_counted(self):
        # Review round 1: padding was rescaled, and a NaN in it reached the real tokens.
        from latent_transfer.norm import calibrate_cache, calibrate_states
        mask = torch.tensor([[1, 0]])
        keys = [torch.tensor([[[[2.0], [7.0]]]])]                 # one head, tokens 2 (real) and 7 (padding)
        out_keys, out_values = calibrate_cache(keys, keys, torch.full((1, 1, 2), 4.0), mask)
        self.assertEqual(out_keys[0].flatten().tolist(), [4.0, 7.0])
        self.assertEqual(out_values[0].flatten().tolist(), [4.0, 7.0])
        poisoned = [torch.tensor([[[[2.0], [float("nan")]]]])]
        out_keys, _ = calibrate_cache(poisoned, poisoned, torch.full((1, 1, 2), 4.0), mask)
        self.assertEqual(float(out_keys[0][0, 0, 0, 0]), 4.0)
        states = torch.tensor([[[3.0, 4.0], [float("nan"), 1.0]]])
        for per_token in (False, True):
            out = calibrate_states(states, 10.0, mask, per_token=per_token)
            self.assertEqual(out[0, 0].tolist(), [6.0, 8.0])
            self.assertEqual(float(out[0, 1, 1]), 1.0)

    def test_zero_energy_gives_finite_gradients(self):
        # Review round 1: sqrt(0) sent NaN gradients back for an all-zero head or an all-padding row.
        from latent_transfer.norm import calibrate_cache, calibrate_states
        keys = [torch.zeros(2, 1, 3, 2, requires_grad=True)]
        values = [torch.ones(2, 1, 3, 2, requires_grad=True)]
        mask = torch.tensor([[1, 1, 0], [0, 0, 0]])
        out_keys, out_values = calibrate_cache(keys, values, torch.ones(1, 1, 2), mask)
        (out_keys[0].sum() + out_values[0].sum()).backward()
        self.assertTrue(torch.isfinite(keys[0].grad).all() and torch.isfinite(values[0].grad).all())
        self.assertTrue(torch.equal(out_keys[0], keys[0]), "a zero head is left alone")
        states = torch.zeros(1, 2, 3, requires_grad=True)
        for per_token in (False, True):
            calibrate_states(states, 5.0, per_token=per_token).sum().backward()
        self.assertTrue(torch.isfinite(states.grad).all())

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
        for kind, (tensors, before) in enumerate(((out_keys, keys), (out_values, values))):
            for layer, tensor in enumerate(tensors):
                rms = ((tensor ** 2 * weight).sum((2, 3)) / (mask.sum(-1)[:, None] * dim)).sqrt()
                self.assertTrue(torch.allclose(rms, sigma[layer, :, kind][None].expand(2, heads), atol=1e-5))
                self.assertTrue(torch.equal(tensor[1, :, 3:], before[layer][1, :, 3:]), "padding untouched")
        # Direction is untouched: every head is its input times one positive number.
        ratio = out_keys[1][0, 0] / keys[1][0, 0]
        self.assertTrue(torch.allclose(ratio, ratio.flatten()[0].expand_as(ratio), atol=1e-4))
        capped, _ = calibrate_cache(keys, values, sigma, mask, max_scale=1.0)
        self.assertTrue(all(torch.allclose(a, b) for a, b in zip(capped, keys)), "a cap of 1 changes nothing")
        half = [k.to(torch.bfloat16) for k in keys]
        self.assertEqual(calibrate_cache(half, half, sigma, mask)[0][0].dtype, torch.bfloat16)


class FakeTokenizer:
    """Splits text at the given character offsets; honours truncation like a fast tokenizer."""

    def __init__(self, cut):
        self.cut = cut

    def __call__(self, text, add_special_tokens=False, return_offsets_mapping=True, truncation=False,
                 max_length=None, verbose=True):
        spans = self.cut(text)
        if truncation and max_length is not None:
            spans = spans[:max_length]
        return {"input_ids": [1 + index for index in range(len(spans))], "offset_mapping": spans}


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
    def test_rule_1_builds_the_batch_main_built(self):
        # Expected tensors written out from batch.py and align.py at origin/main (6fa6249)
        # for these two tokenizers; the zero-width token and the shared span are where a
        # change to the position or the mask arithmetic would show.
        from latent_transfer.batch import make_pair
        sender = FakeTokenizer(lambda text: [(0, 0), (0, 3), (3, 4), (3, 4), (4, 7), (7, 7)])
        receiver = FakeTokenizer(lambda text: [(0, 0), (0, 2), (2, 4), (3, 4), (4, 7)])
        batch = make_pair(sender, receiver, ["abcdefg"], max_tokens=384, rule=RULE_RAW)
        self.assertEqual(batch.sender_ids.tolist(), [[1, 2, 3, 4, 5, 6]])
        self.assertEqual(batch.receiver_ids.tolist(), [[1, 2, 3, 4, 5]])
        self.assertEqual(batch.sender_mask.tolist(), [[1] * 6])
        self.assertEqual(batch.receiver_mask.tolist(), [[1] * 5])
        self.assertEqual(batch.sender_pos.tolist(), [[0.5, 1.25, 3.0, 3.0, 4.0, 4.5]])
        self.assertEqual(batch.cross_allowed.tolist(),
                         [[[True, False, False, False, False, False], [True, False, False, False, False, False],
                           [True, True, True, True, False, False], [True, True, True, True, False, False],
                           [True, True, True, True, True, True]]])

    def test_rule_1_truncation_and_padding_as_on_main(self):
        from latent_transfer.batch import make_pair
        texts = ["alpha beta gamma delta", "one two"]
        batch = make_pair(FakeTokenizer(words), FakeTokenizer(pieces(4)), texts, max_tokens=3, rule=RULE_RAW)
        # Row 0: words end at 5, 10, 16 and pieces at 4, 8, 12, so main kept two words (limit 12).
        self.assertEqual(batch.sender_mask.tolist(), [[1, 1], [1, 1]])
        self.assertEqual(batch.receiver_mask.tolist(), [[1, 1, 1], [1, 1, 0]])
        self.assertEqual(batch.sender_pos.tolist(), [[0.125, 1.375], [0.0, 0.8333333134651184]])
        self.assertEqual(batch.cross_allowed.tolist(),
                         [[[False, False], [True, False], [True, True]],
                          [[True, False], [True, True], [False, False]]])
        self.assertEqual(batch.dropped.tolist(), [[1, 0], [0, 0]])

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

    def test_no_token_budget(self):
        # Review round 1: max_tokens=None raised TypeError.
        from latent_transfer.batch import make_pair
        batch = make_pair(FakeTokenizer(words), FakeTokenizer(pieces(5)), ["alpha beta gamma"], max_tokens=None)
        self.assertEqual((int(batch.sender_mask.sum()), int(batch.receiver_mask.sum())), (3, 4))
        self.assertEqual(batch.dropped.tolist(), [[0, 0]])

    def test_shared_characters_reach_the_tensors(self):
        from latent_transfer.batch import make_pair
        emoji = FakeTokenizer(lambda text: list(PHI_EMOJI))
        batch = make_pair(emoji, emoji, ["hi X ok"], max_tokens=384)
        self.assertEqual(batch.sender_pos[0].tolist(), [float(i) for i in range(7)])
        spans = refine_spans(PHI_EMOJI, 7)
        self.assertEqual(batch.cross_allowed[0].tolist(), causal_mask(spans, spans))
        self.assertFalse(batch.cross_allowed[0].triu(1).any(), "nothing above the diagonal")
        self.assertEqual(batch.receiver_blind[0].tolist(), [False] * 7)
        raw = make_pair(emoji, emoji, ["hi X ok"], max_tokens=384, rule=RULE_RAW)
        self.assertTrue(raw.cross_allowed[0].triu(1).any(), "rule 1 lets a piece read later pieces")

    def test_an_empty_document_is_refused_under_both_rules(self):
        from latent_transfer.batch import make_pair
        for rule in (RULE_RAW, RULE_REFINED):
            with self.assertRaises(ValueError):
                make_pair(FakeTokenizer(words), FakeTokenizer(words), [""], rule=rule)


class FakeAudited:
    def __init__(self, cut):
        self.cut = cut

    def encode(self, text):
        spans = self.cut(text)
        return ["t"] * len(spans), spans


class AuditTest(unittest.TestCase):
    def test_vocabulary_entries_compare_as_bytes_across_families(self):
        from latent_transfer.align_audit import EDGE_CASES, surface
        marker, space = chr(0x2581), chr(0x120)
        self.assertEqual(surface(marker + "the", False), b" the")
        self.assertEqual(surface(space + "the", True), b" the")
        self.assertEqual(surface("<0xF0>", False), b"\xf0")
        self.assertEqual(surface(chr(0xC3) + chr(0xA9), True), chr(0xE9).encode("utf-8"))
        names = [name for name, _ in EDGE_CASES]
        self.assertEqual(len(names), len(set(names)))
        self.assertGreaterEqual(len(names), 30)
        self.assertNotIn("", [text for _, text in EDGE_CASES], "the empty text is checked on its own")

    def test_pair_stats_count_holes_refusals_and_write_json(self):
        from latent_transfer.align_audit import pair_stats
        # Review round 1: a hole in one side's raw coverage was not a coverage loss, a refused
        # text hid its unread tokens, and a cut inside a character broke the JSON report.
        holes = pair_stats(FakeAudited(lambda text: [(0, 1), (2, 3)]), FakeAudited(lambda text: [(0, 3)]), ["abc"])
        self.assertEqual(holes["rule1"]["lostCoverageChars"], 1)
        self.assertEqual(holes["rule2"]["lostCoverageChars"], 0)
        refused = pair_stats(FakeAudited(lambda text: [(0, 2), (2, 3)]), FakeAudited(lambda text: [(0, 3)]),
                             ["abc"], max_tokens=1)
        self.assertEqual(refused["rule1"]["emptyTexts"], 1)
        self.assertEqual(refused["rule1"]["unreadSender"], 1)
        self.assertEqual(refused["rule2"]["emptyTexts"], 1)
        shared = FakeAudited(lambda text: [(0, 1), (0, 1), (1, 2)])
        for budget in (None, 1, 2):
            json.dumps(pair_stats(shared, shared, ["ab"], max_tokens=budget))
        none = pair_stats(FakeAudited(lambda text: []), shared, ["ab"])
        self.assertEqual((none["texts"], none["noTokens"]), (0, 1))


def cached_tokenizers():
    try:
        from transformers import AutoTokenizer
    except ImportError:
        return {}
    from latent_transfer.align_audit import TOKENIZERS
    names = dict(TOKENIZERS, qwen05="Qwen/Qwen2.5-0.5B-Instruct", smol="HuggingFaceTB/SmolLM2-360M-Instruct")
    loaded = {}
    for name, model in names.items():
        try:
            loaded[name] = AutoTokenizer.from_pretrained(model, local_files_only=True)
        except Exception:  # not downloaded on this machine
            continue
    return loaded


class RealTokenizerTest(unittest.TestCase):
    def test_edge_cases_line_up_under_rule_2(self):
        tokenizers = cached_tokenizers()
        if len(tokenizers) < 2:
            self.skipTest("transformers and two locally cached tokenizers are needed")
        from latent_transfer.align_audit import EDGE_CASES
        from latent_transfer.batch import spans
        names = sorted(tokenizers)
        for label, text in EDGE_CASES:
            raw = {name: spans(tokenizers[name], text, 384, RULE_REFINED)[1] for name in names}
            for name in names:
                self.assertTrue(raw[name], (label, name))
                self.assertTrue(identity(refine_spans(raw[name], len(text))), (label, name))
            for sender in names:
                for receiver in names:
                    where = (label, sender, receiver)
                    keep_s, s_spans, keep_r, r_spans = align_document(raw[sender], raw[receiver], len(text), 384)
                    self.assertEqual((len(keep_s), len(keep_r)), (len(raw[sender]), len(raw[receiver])), where)
                    self.assertEqual((s_spans[-1][1], r_spans[-1][1]), (len(text), len(text)), where)
                    self.assertFalse(any(unread_sender(s_spans, r_spans)), where)
                    mask = causal_mask(s_spans, r_spans)
                    self.assertIsNone(leak(raw[sender], raw[receiver], len(text), mask), where)
                    for budget in (3, 9):
                        keep_s, s_cut, keep_r, r_cut = align_document(raw[sender], raw[receiver], len(text), budget)
                        if keep_s:
                            self.assertEqual(max(e for _, e in s_cut), max(e for _, e in r_cut), where)
                            self.assertFalse(any(unread_sender(s_cut, r_cut)), where)
                            self.assertIsNone(leak(raw[sender], raw[receiver], len(text),
                                                   causal_mask(s_cut, r_cut), len(keep_s), len(keep_r)), where)
        for name in names:
            self.assertEqual(spans(tokenizers[name], "", 384, RULE_REFINED)[1], [], name)


if __name__ == "__main__":
    unittest.main()
