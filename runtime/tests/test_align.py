"""L3: cross-tokenizer alignment on hard text, and the optional norm calibration.

The span arithmetic and the calibration reference need only the standard library. The
batch and tensor checks skip without torch; the real-tokenizer check skips unless
transformers and locally cached tokenizers are present.

Span fixtures are the offsets real tokenizers returned in the audit (docs/evals.md, L3),
plus the counterexamples from the two Codex review rounds.
"""
import json
import unittest
from fractions import Fraction

from latent_transfer.align import (ALIGNMENT_RULE, RULE_RAW, RULE_REFINED, align_document, blind_receiver,
                                   causal_mask, classify, common_cut, ownership, reading_keys, refine_spans,
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
            (PHI_CJK, 4), ([(0, 1), (1, 2), (1, 2), (1, 2)], 2),
            # Shapes no cached tokenizer returns but the rules must still handle (review rounds):
            ([(0, 3), (0, 3)], 3), ([(0, 2), (2, 3)], 3), ([(0, 1), (1, 3)], 3), ([(2, 2), (2, 3)], 3),
            ([(0, 2), (0, 2)], 2), ([(0, 1), (1, 2)], 2), ([(0, 1), (0, 0), (1, 2)], 2), ([(0, 0), (0, 2)], 2),
            ([(0, 3), (1, 4)], 4), ([(0, 4), (0, 4), (0, 0), (0, 4)], 4), ([(0, 1), (1, 1), (2, 4)], 4),
            ([(0, 3), (2, 2), (3, 4)], 4), ([(0, 2), (0, 2), (0, 3), (0, 3), (0, 3)], 3), ([(0, 1), (2, 3), (0, 0)], 3),
            ([(0, 4), (1, 2), (6, 7)], 7), ([(0, 4), (4, 7)], 7), ([(0, 4), (1, 2)], 7), ([(0, 2), (0, 6), (5, 7)], 7),
            ([(0, 4), (1, 2), (6, 7), (7, 7)], 7), ([(0, 3)], 3)]


def owners(raw, length):
    """Independent oracle, from raw offsets: for every character, the tokens that touch it.
    A character no token reports belongs to the token before it (the first, at the start)."""
    table = [[i for i, (start, end) in enumerate(raw) if start <= char < end] for char in range(length)]
    first = next((i for i, (start, end) in enumerate(raw) if end > start), None)
    for char in range(length):
        if not table[char]:
            table[char] = [table[char - 1][-1]] if char and table[char - 1] else ([first] if first is not None else [])
    return table


def oracle(raw, length):
    """(touched, finished) per token, counted character by character from `owners`."""
    table = owners(raw, length)
    touched = [max((char + 1 for char in range(length) if any(k <= i for k in table[char])), default=0)
               for i in range(len(raw))]
    finished = [next((char for char in range(length) if any(k > i for k in table[char])), length)
                for i in range(len(raw))]
    if not any(end > start for start, end in raw):
        finished = [0] * len(raw)     # tokens without characters only: nothing is ever finished
    return touched, finished


def leak(sender_raw, receiver_raw, length, mask, sender_kept=None, receiver_kept=None):
    """A (receiver, sender) pair where the receiver reads a sender token that has touched a
    character the receiver has not finished; None when the mask is causal."""
    touched, _ = oracle(sender_raw, length)
    _, finished = oracle(receiver_raw, length)
    for j in range(len(receiver_raw) if receiver_kept is None else receiver_kept):
        for i in range(len(sender_raw) if sender_kept is None else sender_kept):
            if mask[j][i] and touched[i] > finished[j]:
                return j, i
    return None


def withheld(sender_raw, receiver_raw, length, mask):
    """A (receiver, sender) pair of tokens with characters where the read is safe by the oracle
    and the mask refuses it; None when the mask allows everything it safely can."""
    touched, _ = oracle(sender_raw, length)
    _, finished = oracle(receiver_raw, length)
    for j, (r_start, r_end) in enumerate(receiver_raw):
        for i, (s_start, s_end) in enumerate(sender_raw):
            if r_end > r_start and s_end > s_start and touched[i] <= finished[j] and not mask[j][i]:
                return j, i
    return None


def identity(raw, length):
    """Same tokenizer on both sides: position i for token i; no token reads a later one."""
    size = len(raw)
    spans = refine_spans(raw, length)
    mask = causal_mask(raw, raw, text_length=length)
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

    def test_zero_width_tokens_stay_as_they_are(self):
        self.assertEqual(refine_spans([(0, 0), (0, 3), (3, 5), (5, 5)], 5), [(0, 0), (0, 3), (3, 5), (5, 5)])
        self.assertEqual(refine_spans([(0, 0), (4, 4)], 9), [(0, 0), (4, 4)])
        # Review round 2: a sentinel offset after the text is not an ordering error.
        self.assertEqual(refine_spans([(0, 1), (2, 3), (0, 0)]), [(0, 2), (2, 3), (0, 0)])

    def test_overlaps_longer_than_one_character_still_tile(self):
        # Review round 1: these came back overlapping, or with decreasing ends.
        self.assertEqual(refine_spans([(0, 3), (1, 4)]), [(0, 2), (2, 4)])
        self.assertEqual(refine_spans([(0, 2), (0, 2)]), [(0, 1), (1, 2)])
        self.assertEqual(refine_spans([(0, 4), (1, 2)]), [(0, Fraction(5, 2)), (Fraction(5, 2), 4)])
        # Review round 2: neighbouring overlaps of different lengths raised.
        third, ninth = Fraction(1, 3), Fraction(1, 9)
        self.assertEqual(refine_spans([(0, 2), (0, 2), (0, 3), (0, 3), (0, 3)]),
                         [(0, 2 * third), (2 * third, 4 * third), (4 * third, 17 * ninth), (17 * ninth, 22 * ninth),
                          (22 * ninth, 3)])
        # Review round 3: every boundary stays inside the overlap it divides.
        self.assertEqual(refine_spans([(0, 2), (0, 100), (99, 101)]), [(0, 1), (1, Fraction(199, 2)), (Fraction(199, 2), 101)])

    def test_refined_spans_tile_the_text(self):
        for raw, length in FIXTURES:
            refined = [span for span in refine_spans(raw, length) if span[1] > span[0]]
            self.assertEqual(len(refined), sum(1 for start, end in raw if end > start))
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

    def test_rule_2_restores_identity(self):
        for raw, length in FIXTURES:
            self.assertTrue(identity(raw, length), raw)

    def test_whole_character_tokens_read_themselves(self):
        mask = causal_mask(PHI_EMOJI, PHI_EMOJI, text_length=7)
        self.assertEqual([mask[i][i] for i in range(7)], [True, True, False, False, False, True, True])
        # The piece that completes the character reads all four pieces.
        self.assertEqual(mask[5], [True] * 6 + [False])
        self.assertEqual(blind_receiver(PHI_EMOJI, PHI_EMOJI, text_length=7), [False] * 7)

    def test_bos_on_both_sides_keeps_identity(self):
        spans = [(0, 0), (0, 3), (3, 5)]
        self.assertTrue(identity(spans, 5))
        self.assertEqual(causal_mask(spans, spans, text_length=5),
                         [[True, False, False], [True, True, False], [True, True, True]])

    def test_several_tokens_without_characters_keep_their_order(self):
        # Review round 1: both took position 0 and the first read the second.
        spans = [(0, 0), (0, 0), (0, 1), (1, 1)]
        self.assertEqual(sender_positions(spans, spans), [0.0, 1.0, 2.0, 3.0])
        self.assertEqual(causal_mask(spans, spans, text_length=1), [[i <= j for i in range(4)] for j in range(4)])

    def test_a_token_without_characters_never_takes_a_neighbours_position(self):
        # Review round 2: after the gap was closed the first token's midpoint hit the empty token.
        raw = [(0, 1), (1, 1), (2, 3)]
        spans = refine_spans(raw, 3)
        self.assertEqual(sender_positions(spans, spans), [0.0, 1.0, 2.0])
        raw = [(0, 4), (0, 4), (0, 0), (0, 4)]
        spans = refine_spans(raw, 4)
        self.assertEqual(sender_positions(spans, spans), [0.0, 1.0, 2.0, 3.0])
        self.assertEqual(sender_positions([(2, 2)], [(0, 4), (4, 6)]), [0.0], "no match: where the offset falls")
        self.assertEqual(sender_positions([(0, 2)], [(0, 0)]), [0.0], "no receiver token with characters")

    def test_bos_on_one_side_only(self):
        sender, receiver = [(0, 0), (0, 3), (3, 5)], [(0, 3), (3, 5)]
        self.assertEqual(sender_positions(sender, receiver), [0.0, 0.0, 1.0])
        self.assertEqual(causal_mask(sender, receiver, text_length=5), [[True, True, False], [True, True, True]])
        # A receiver BOS reads nothing from a sender without one: it is blind, and counted.
        self.assertEqual(blind_receiver(receiver, sender, text_length=5), [True, False, False])


class CausalityTest(unittest.TestCase):
    def test_ownership(self):
        self.assertEqual(ownership(PHI_EMOJI, 7), ([2, 3, 4, 4, 4, 4, 7], [2, 3, 3, 3, 3, 4, 7]))
        self.assertEqual(ownership(GRANITE_EMOJI, 7), ([2, 4, 4, 7], [2, 3, 4, 7]))
        self.assertEqual(ownership(QWEN_COMBINING, 3), ([2, 3], [2, 3]), "the uncovered accent is the first token's")
        self.assertEqual(ownership([(2, 2), (2, 3)], 3), ([0, 3], [0, 3]), "a leading gap is the first token's")
        self.assertEqual(ownership([(0, 3), (0, 3)], 3), ([3, 3], [0, 3]))
        self.assertEqual(ownership([], 4), ([], []))
        # Tokens without characters only: nothing touched, nothing finished, nothing to keep.
        self.assertEqual(ownership([(3, 3)], 3), oracle([(3, 3)], 3))
        self.assertEqual(ownership([(3, 3)], 3), ([0], [0]))
        aligned = align_document([(0, 3)], [(3, 3)], 3)
        self.assertEqual((aligned.sender_keep, aligned.receiver_keep), ([], []))

    def test_ownership_matches_the_oracle(self):
        for raw, length in FIXTURES:
            self.assertEqual(ownership(raw, length), oracle(raw, length), raw)

    def test_a_piece_of_a_character_reads_no_piece_of_it_until_the_character_is_complete(self):
        mask = causal_mask(PHI_EMOJI, GRANITE_EMOJI, text_length=7)
        # Granite's " + three bytes" token has not finished the emoji: it reads none of Phi's bytes.
        self.assertEqual(mask[1], [True, True, False, False, False, False, False])
        self.assertEqual(mask[2], [True, True, True, True, True, True, False])
        positions = sender_positions(refine_spans(PHI_EMOJI, 7), refine_spans(GRANITE_EMOJI, 7))
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(len(set(positions)), len(positions), "no two sender tokens share a position")

    def test_pieces_split_differently_never_leak_bytes(self):
        # Review round 1: one emoji as 3 + 1 bytes (sender) and 1 + 1 + 2 bytes (receiver), every
        # token reporting (0, 1). By token count the receiver's second piece (two bytes read)
        # would read the sender's first (three bytes read).
        self.assertEqual(causal_mask([(0, 1), (0, 1)], [(0, 1), (0, 1), (0, 1)], text_length=1),
                         [[False, False], [False, False], [True, True]])

    def test_overlaps_longer_than_one_character_never_leak(self):
        # Review round 2: the refined end said two characters where the raw span touches three,
        # and the other way round a receiver token got credit for a character a later one touches.
        self.assertEqual(causal_mask([(0, 3), (0, 3)], [(0, 2), (2, 3)], text_length=3),
                         [[False, False], [True, True]])
        self.assertEqual(causal_mask([(0, 1), (1, 3)], [(0, 3), (0, 3)], text_length=3),
                         [[False, False], [True, True]])

    def test_a_gap_after_a_nested_overlap_belongs_to_the_token_that_reaches_it(self):
        # Review round 3: characters 4 and 5 are reported by no sender token. They follow
        # character 3, which token 0 covers, not the nested token 1; token 0 was credited with
        # four characters and a receiver token ending at 4 read it.
        sender, receiver = [(0, 4), (1, 2), (6, 7)], [(0, 4), (4, 7)]
        self.assertEqual(ownership(sender, 7), ([6, 6, 7], [1, 6, 7]))
        self.assertEqual(ownership(sender), ([6, 6, 7], [1, 6, 7]))
        self.assertEqual(causal_mask(sender, receiver, text_length=7), [[False, False, False], [True, True, True]])
        self.assertEqual(ownership([(0, 4), (1, 2)], 7), ([7, 7], [1, 7]), "and a trailing gap")
        # The read must not survive truncation either.
        aligned = align_document(sender + [(7, 8)], receiver + [(7, 8)], 8, 3)
        self.assertEqual((aligned.sender_keep, aligned.receiver_keep), ([0, 1, 2], [0, 1]))
        self.assertEqual(aligned.mask(), [[False, False, False], [True, True, True]])

    def test_a_token_without_characters_carries_what_came_before_it(self):
        # Review round 1: the sender's zero-width token was written after it read character 0,
        # so a receiver BOS must not read it.
        sender, receiver = [(0, 1), (0, 0), (1, 2)], [(0, 0), (0, 2)]
        self.assertEqual(causal_mask(sender, receiver, text_length=2), [[False, False, False], [True, True, True]])
        self.assertEqual(blind_receiver(sender, receiver, text_length=2), [True, False])

    def test_an_empty_token_between_the_pieces_of_a_character_belongs_to_that_run(self):
        # Found by the fixtures after review round 2: counted like a token at a clean boundary,
        # it stopped the piece that completes the character from reading its own run.
        spans = [(0, 4), (0, 4), (0, 0), (0, 4)]
        self.assertEqual(causal_mask(spans, spans, text_length=4),
                         [[False] * 4, [False] * 4, [False] * 4, [True] * 4])
        self.assertEqual(causal_mask(spans, [(0, 4)], text_length=4), [[True] * 4])
        # At a clean boundary the count still orders them: A, then two empty tokens.
        clean = [(0, 3), (3, 3), (3, 3)]
        self.assertEqual(causal_mask(clean, clean, text_length=3), [[i <= j for i in range(3)] for j in range(3)])

    def test_a_token_without_characters_finishes_nothing(self):
        # Review round 2: a receiver's empty token at offset 2, ahead of its first real token,
        # read a sender token over characters 0 and 1.
        self.assertEqual(causal_mask([(0, 2), (2, 3)], [(2, 2), (2, 3)], text_length=3),
                         [[False, False], [True, True]])

    def test_a_sender_only_trailing_empty_token_is_reported_unread(self):
        # Review round 2. It is kept, in order, and counted; nothing on the receiver comes after it.
        aligned = align_document([(0, 1), (1, 1)], [(0, 1)], 1)
        self.assertEqual((aligned.sender_keep, aligned.unread()), ([0, 1], [False, True]))
        self.assertEqual(unread_sender([(0, 1), (1, 1)], [(0, 1)], text_length=1), [False, True])

    def test_the_composed_token_reads_the_combining_mark(self):
        raw = causal_mask(PHI_COMBINING, QWEN_COMBINING, RULE_RAW)
        self.assertFalse(raw[0][1], "rule 1: Qwen's composed token cannot read the accent it contains")
        self.assertEqual(causal_mask(PHI_COMBINING, QWEN_COMBINING, text_length=3),
                         [[True, True, False], [True, True, True]])
        # And the other way: Phi's bare "e" must not read Qwen's composed token.
        self.assertEqual(causal_mask(QWEN_COMBINING, PHI_COMBINING, text_length=3),
                         [[False, False], [True, False], [True, True]])

    def test_no_fixture_pair_leaks_and_none_is_refused_a_safe_read(self):
        for sender, s_length in FIXTURES:
            for receiver, r_length in FIXTURES:
                if s_length != r_length:
                    continue
                mask = causal_mask(sender, receiver, text_length=s_length)
                self.assertIsNone(leak(sender, receiver, s_length, mask), (sender, receiver))
                self.assertIsNone(withheld(sender, receiver, s_length, mask), (sender, receiver))
                unread = unread_sender(sender, receiver, text_length=s_length)
                self.assertFalse(any(flag for flag, (start, end) in zip(unread, sender) if end > start),
                                 "a sender token with characters is always read by the end of the text")

    def test_the_oracle_catches_rule_1_leaks(self):
        self.assertIsNotNone(leak(PHI_EMOJI, PHI_EMOJI, 7, causal_mask(PHI_EMOJI, PHI_EMOJI, RULE_RAW)))
        self.assertIsNotNone(leak(QWEN_COMBINING, PHI_COMBINING, 3,
                                  causal_mask(QWEN_COMBINING, PHI_COMBINING, RULE_RAW)))
        self.assertIsNotNone(withheld(PHI_COMBINING, QWEN_COMBINING, 3,
                                      causal_mask(PHI_COMBINING, QWEN_COMBINING, RULE_RAW)))

    def test_keys_are_ordered_integers(self):
        for raw, length in FIXTURES:
            for keys in reading_keys(raw, raw, text_length=length):
                self.assertEqual(keys, sorted(keys))
                self.assertTrue(all(type(key) is int for key in keys))
        with self.assertRaises(ValueError):
            reading_keys([(0, 1)], [(0, 1)], rule=3)
        with self.assertRaises(ValueError):
            sender_positions([(0, 1)], [(0, 1)], rule=3)

    def test_clean_spans_give_the_same_mask_under_both_rules(self):
        sender = [(0, 2), (2, 7), (7, 8), (8, 12), (12, 13)]
        receiver = [(0, 4), (4, 6), (6, 12), (12, 13)]
        for rule in (RULE_RAW, RULE_REFINED):
            positions = sender_positions(sender, receiver, rule)
            self.assertEqual(positions, [0.0, 0.75, 1.75, 2.1666666666666665, 3.0])
            # Found by the audit after review round 2: exact fractions gave rule 2 a different
            # last digit than rule 1 on clean text (thirds and sevenths show it).
            odd_s, odd_r = [(0, 1), (1, 3), (3, 10), (10, 21)], [(0, 3), (3, 6), (6, 13), (13, 21)]
            self.assertEqual(sender_positions(odd_s, odd_r, rule), sender_positions(odd_s, odd_r, RULE_RAW))
            # Review round 3: offsets too large for a float midpoint chose a different token.
            far = 2 ** 55
            huge = [(0, far)] + [(far + i, far + i + 1) for i in range(8)]
            self.assertEqual(sender_positions(huge, huge, rule), sender_positions(huge, huge, RULE_RAW))
        # Confirmation round: with a divided character on the receiver the float midpoint rounded
        # across its fractional boundaries; the search is exact there.
        far = 2 ** 55
        divided = refine_spans([(0, far), (far, far + 2), (far + 1, far + 2), (far + 1, far + 2)])
        self.assertEqual(sender_positions(refine_spans([(0, far + 1), (far + 1, far + 2)]), divided)[-1], 2.0)
        for rule in (RULE_RAW, RULE_REFINED):
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

    def kept(self, *arguments, **options):
        aligned = align_document(*arguments, **options)
        return aligned.sender_keep, aligned.receiver_keep

    def test_rule_1_leaves_a_tail_nobody_reads(self):
        # Receiver truncated to two tokens (ends at 7), sender to three (ends at 9).
        self.assertEqual(self.kept(self.SENDER[:3], self.RECEIVER[:2], rule=RULE_RAW), ([0, 1], [0, 1]))
        # Sender covers 0..6, receiver 0..7: the receiver's last token sits over a character
        # (6) whose sender token was dropped. The mirror case leaves a sender token unread:
        aligned = align_document(self.RECEIVER[:2], self.SENDER[:3], rule=RULE_RAW)
        self.assertEqual(aligned.unread(), [False, True])

    def test_rule_2_cuts_where_both_sides_can_stop(self):
        self.assertEqual(common_cut(self.SENDER, self.RECEIVER, 12, 2), (0, 0))
        self.assertEqual(common_cut(self.SENDER, self.RECEIVER, 12, 3), (3, 3))
        self.assertEqual(common_cut(self.SENDER, self.RECEIVER, 12), (4, 4))
        aligned = align_document(self.SENDER, self.RECEIVER, 12, 3)
        self.assertEqual((aligned.sender_keep, aligned.receiver_keep), ([0, 1, 2], [0, 1, 2]))
        self.assertEqual(aligned.sender_spans[-1][1], aligned.receiver_spans[-1][1])
        self.assertEqual(aligned.unread(), [False] * 3)
        self.assertEqual(aligned.mask(), [[False, False, False], [True, True, False], [True, True, True]])
        self.assertEqual(self.kept(self.SENDER, self.RECEIVER, 12, 2), ([], []))

    def test_a_cut_never_falls_inside_a_character(self):
        # Both sides cut to four tokens end inside the emoji (Phi after two of its four bytes).
        self.assertEqual(self.kept(PHI_EMOJI, PHI_EMOJI, 7, 4), ([0, 1], [0, 1]))
        self.assertEqual(self.kept(PHI_EMOJI, GRANITE_EMOJI, 7, 2), ([0], [0]))
        # Review round 2: a boundary the refinement placed inside an overlap is no cut either.
        self.assertEqual(self.kept([(0, 2), (0, 2)], [(0, 1), (1, 2)], 2, 1), ([], []))

    def test_a_token_without_characters_is_not_a_place_to_cut(self):
        # Review round 1: both sides share the offset 2 of a zero-width token, yet their kept
        # tokens cover 0..3 and 0..4.
        self.assertEqual(self.kept([(0, 3), (2, 2), (3, 5)], [(0, 4), (2, 2), (4, 5)], 5, 2), ([], []))
        # Review round 2: an empty token ahead of the receiver's first real token.
        self.assertEqual(self.kept([(0, 2), (2, 3)], [(2, 2), (2, 3)], 3, 1), ([], []))
        # Tokens without characters right after the cut stay with it; a lone BOS is no cut.
        self.assertEqual(common_cut([(0, 3), (3, 3), (3, 5)], [(0, 3), (3, 4)]), (2, 1))
        self.assertEqual(common_cut([(0, 0), (0, 3)], [(0, 0), (0, 2)]), (0, 0))

    def test_text_ending_in_a_combining_mark(self):
        # "e" + accent: Qwen's last offset is 1, Phi's is 2.
        self.assertEqual(self.kept([(0, 1), (1, 2)], [(0, 1)], rule=RULE_RAW)[0], [0],
                         "rule 1 drops the sender's accent token without a record")
        aligned = align_document([(0, 1), (1, 2)], [(0, 1)], 2, 384)
        self.assertEqual((aligned.sender_keep, aligned.receiver_keep), ([0, 1], [0]))
        self.assertEqual(aligned.unread(), [False, False])

    def test_untruncated_text_drops_nothing(self):
        for sender, s_length in FIXTURES:
            for receiver, r_length in FIXTURES:
                if s_length != r_length:
                    continue
                for budget in (384, None):
                    aligned = align_document(sender, receiver, s_length, budget)
                    self.assertEqual((len(aligned.sender_keep), len(aligned.receiver_keep)),
                                     (len(sender), len(receiver)), (sender, receiver))
                    self.assertEqual(aligned.mask(), causal_mask(sender, receiver, text_length=s_length))

    def test_every_truncation_of_every_fixture_pair_is_causal_and_fully_read(self):
        for sender, s_length in FIXTURES:
            for receiver, r_length in FIXTURES:
                if s_length != r_length:
                    continue
                for budget in range(0, 8):
                    aligned = align_document(sender, receiver, s_length, budget)
                    where = (sender, receiver, budget)
                    self.assertLessEqual(max(len(aligned.sender_keep), len(aligned.receiver_keep)), budget, where)
                    if not aligned.sender_keep or not aligned.receiver_keep:
                        self.assertEqual((aligned.sender_keep, aligned.receiver_keep), ([], []), where)
                        continue
                    kept_s, kept_r = len(aligned.sender_keep), len(aligned.receiver_keep)
                    # Both sides have touched and finished exactly the same text.
                    self.assertEqual(oracle(sender, s_length)[0][kept_s - 1], oracle(receiver, s_length)[1][kept_r - 1])
                    self.assertEqual(oracle(sender, s_length)[1][kept_s - 1], oracle(receiver, s_length)[0][kept_r - 1])
                    unread = aligned.unread()
                    self.assertFalse(any(flag for flag, (start, end) in zip(unread, sender) if end > start), where)
                    self.assertIsNone(leak(sender, receiver, s_length, aligned.mask(), kept_s, kept_r), where)

    def test_empty_side_and_unknown_rule(self):
        self.assertEqual(self.kept([], [(0, 2)], 2, 384), ([], []))
        self.assertEqual(self.kept([], [(0, 2)], rule=RULE_RAW), ([], []))
        self.assertEqual(align_document([], [(0, 2)], rule=RULE_RAW).unread(), [])
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
                    self.assertTrue(torch.allclose(got[row], torch.tensor(want, dtype=torch.float64), atol=1e-12))
        stats = norm_stats(calibrate_states(states, 3.0, mask, per_token=True), mask)
        self.assertAlmostEqual(stats["mean"], 3.0, places=9)
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

    def test_a_nan_in_a_real_token_is_not_hidden(self):
        # Review round 2: a NaN energy counted as zero, so the other tokens were scaled by a
        # wrong mean and nothing showed.
        from latent_transfer.norm import calibrate_cache, calibrate_states
        states = torch.tensor([[[float("nan")], [2.0]]])
        self.assertTrue(torch.isnan(calibrate_states(states, 2.0)).all())
        per_token = calibrate_states(states, 2.0, per_token=True)
        self.assertTrue(torch.isnan(per_token[0, 0, 0]))
        self.assertEqual(float(per_token[0, 1, 0]), 2.0)
        keys = [torch.tensor([[[[float("nan")], [2.0]]]])]
        out_keys, _ = calibrate_cache(keys, keys, torch.ones(1, 1, 2), torch.tensor([[1, 1]]))
        self.assertTrue(torch.isnan(out_keys[0]).all())

    def test_double_precision_input_stays_double(self):
        # Review round 2: fp64 states went through fp32 and a large finite value became infinite.
        from latent_transfer.norm import calibrate_cache, calibrate_states
        out = calibrate_states(torch.tensor([[[1e100]]], dtype=torch.float64), 1.0)
        self.assertEqual((out.dtype, float(out)), (torch.float64, 1.0))
        keys = [torch.tensor([[[[1e100]]]], dtype=torch.float64)]
        out_keys, _ = calibrate_cache(keys, keys, torch.ones(1, 1, 2), torch.tensor([[1]]))
        self.assertEqual((out_keys[0].dtype, float(out_keys[0])), (torch.float64, 1.0))

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
        self.assertEqual((batch.sender_pos.dtype, batch.cross_allowed.dtype), (torch.float32, torch.bool))

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

    def test_the_mask_compares_integers_not_floats(self):
        # Offsets one apart above 2**53 are the same float64; the mask must still tell them apart.
        from latent_transfer.batch import make_pair
        big = 2 ** 53
        sender = FakeTokenizer(lambda text: [(0, big), (big, big + 1), (big + 1, big + 2)])
        receiver = FakeTokenizer(lambda text: [(0, big), (big, big + 2)])
        for rule in (RULE_RAW, RULE_REFINED):
            batch = make_pair(sender, receiver, ["x"], max_tokens=384, rule=rule)
            self.assertEqual(batch.cross_allowed.tolist(), [[[True, False, False], [True, True, True]]], rule)

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
        self.assertEqual(batch.cross_allowed[0].tolist(), causal_mask(PHI_EMOJI, PHI_EMOJI, text_length=7))
        self.assertFalse(batch.cross_allowed[0].triu(1).any(), "nothing above the diagonal")
        self.assertEqual(batch.receiver_blind[0].tolist(), [False] * 7)
        raw = make_pair(emoji, emoji, ["hi X ok"], max_tokens=384, rule=RULE_RAW)
        self.assertTrue(raw.cross_allowed[0].triu(1).any(), "rule 1 lets a piece read later pieces")

    def test_a_sender_only_trailing_empty_token_shows_as_unread(self):
        from latent_transfer.batch import make_pair
        batch = make_pair(FakeTokenizer(lambda text: [(0, 1), (1, 1)]), FakeTokenizer(lambda text: [(0, 1)]), ["a"])
        self.assertEqual(batch.sender_unread.tolist(), [[False, True]])

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
        for budget in (None, 0, 1, 2):
            json.dumps(pair_stats(shared, shared, ["ab"], max_tokens=budget))
        # Review round 2: a side with no tokens is a refusal under both rules, and a budget of
        # zero drops nothing because nothing entered it.
        none = pair_stats(FakeAudited(lambda text: []), shared, ["ab"])
        self.assertEqual((none["texts"], none["noTokens"]), (0, 1))
        self.assertEqual((none["rule1"]["emptyTexts"], none["rule2"]["emptyTexts"]), (1, 1))
        zero = pair_stats(shared, shared, ["ab"], max_tokens=0)
        self.assertEqual((zero["rule1"]["dropped"], zero["rule2"]["dropped"]), (0, 0))


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
            size = len(text)
            raw = {name: spans(tokenizers[name], text, 384, RULE_REFINED)[1] for name in names}
            for name in names:
                self.assertTrue(raw[name], (label, name))
                self.assertTrue(identity(raw[name], size), (label, name))
                self.assertEqual(ownership(raw[name], size), oracle(raw[name], size), (label, name))
            for sender in names:
                for receiver in names:
                    where = (label, sender, receiver)
                    aligned = align_document(raw[sender], raw[receiver], size, 384)
                    self.assertEqual((len(aligned.sender_keep), len(aligned.receiver_keep)),
                                     (len(raw[sender]), len(raw[receiver])), where)
                    self.assertEqual((aligned.sender_spans[-1][1], aligned.receiver_spans[-1][1]), (size, size), where)
                    self.assertFalse(any(aligned.unread()), where)
                    self.assertIsNone(leak(raw[sender], raw[receiver], size, aligned.mask()), where)
                    self.assertIsNone(withheld(raw[sender], raw[receiver], size, aligned.mask()), where)
                    for budget in (3, 9):
                        cut = align_document(raw[sender], raw[receiver], size, budget)
                        if cut.sender_keep:
                            self.assertFalse(any(cut.unread()), where)
                            self.assertIsNone(leak(raw[sender], raw[receiver], size, cut.mask(),
                                                   len(cut.sender_keep), len(cut.receiver_keep)), where)
        for name in names:
            self.assertEqual(spans(tokenizers[name], "", 384, RULE_REFINED)[1], [], name)


if __name__ == "__main__":
    unittest.main()
