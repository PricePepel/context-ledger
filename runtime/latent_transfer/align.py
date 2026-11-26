"""Cross-tokenizer alignment through character spans (SwaT, Sec. 3.2).

Both tokenizers keep their own tokens. Each sender token gets a fractional position
on the receiver's token axis, used as its RoPE position in cross-attention, and a
causal mask says which sender tokens each receiver token may read.

Spans are half-open [start, end) character offsets, as returned by a fast
tokenizer's offset mapping. Real tokenizers do not always return a clean partition
of the text (L3 audit, docs/evals.md):

- the byte pieces of one character (an emoji, a rare CJK character) all report that
  character's whole span, so several tokens share one span;
- a token that ends inside a character reports the whole character, so it overlaps
  the next token;
- a tokenizer that normalizes the text (Qwen composes "e" + combining accent) leaves
  characters that no token covers.

Two rules:

Rule 1 (before the audit) uses the raw offsets as they are. It is kept, unchanged, so a
mapper trained with it sees the batches it trained on.

Rule 2 refines the offsets into spans that tile the text (`refine_spans`), and then:
- position: the midpoint rule on the refined spans, so pieces of one character get
  distinct, ordered positions;
- visibility: a sender token is readable once the receiver has finished every
  character the sender had touched when it wrote that token. A character counts as
  finished only by the token that completes it, because how far inside a character a
  token reaches is not in the offsets. Tokens with no characters (a BOS) are ordered
  by their count at that offset;
- truncation: both sides stop at the last whole-character boundary they share.
"""
import bisect
import math
from fractions import Fraction

RULE_RAW = 1      # raw offsets, cut at the smaller last offset (before the L3 audit)
RULE_REFINED = 2  # refined spans, cut at a boundary both sides share
ALIGNMENT_RULE = RULE_REFINED


def _whole(value):
    return int(value) if value == int(value) else value


def refine_spans(spans, text_length=None):
    """Raw token offsets -> spans that tile the text in token order.

    Each token with characters runs from the boundary before it to the boundary after
    it. The boundary between two neighbours is:
    - where the later one starts, when that is at or after everything before it ends,
      so characters no token covers join the token before them;
    - otherwise the two overlap, and the boundary falls inside the overlap. A run of n
      boundaries over the same overlap divides it into n + 1 equal parts: four byte
      pieces of one character get a quarter each, in token order.
    The first boundary is 0. The last is text_length when given (pass it only when the
    spans are the whole text), else the furthest end.

    Zero-width tokens (a BOS with span (0, 0)) are left as they are. Offsets that are
    already a partition come back unchanged, as the same integers. Divided boundaries
    are exact fractions. Offsets that cannot be put in order raise ValueError.
    """
    previous = 0
    for start, end in spans:
        if end < start or start < previous:
            raise ValueError("Token spans are not in text order.")
        previous = start
    out = [(start, end) for start, end in spans]
    wide = [i for i, (start, end) in enumerate(spans) if end > start]
    if not wide:
        return out
    # (low, high) of the stretch each interior boundary may fall in; low == high when exact.
    reach, limits = spans[wide[0]][1], []
    for i in wide[1:]:
        start, end = spans[i]
        limits.append((start, start) if start >= reach else (start, reach))
        reach = max(reach, end)
    last = reach if text_length is None else max(reach, text_length)
    bounds, index = [0], 0
    while index < len(limits):
        low, high = limits[index]
        run = 1
        while low < high and index + run < len(limits) and limits[index + run] == (low, high):
            run += 1
        for step in range(1, run + 1):
            bounds.append(low if low == high else _whole(low + Fraction((high - low) * step, run + 1)))
        index += run
    bounds.append(last)
    for before, after in zip(bounds, bounds[1:]):
        if after <= before:
            raise ValueError("Token spans overlap in a way that cannot be put in order.")
    for slot, i in enumerate(wide):
        out[i] = (bounds[slot], bounds[slot + 1])
    return out


def reading_keys(sender_spans, receiver_spans, rule=ALIGNMENT_RULE):
    """Two lists of integers: receiver token j may read sender token i when
    sender_key[i] <= receiver_key[j].

    Rule 1: the keys are the raw span ends.

    Rule 2: a sender key says how much text the sender had touched when it wrote the
    token (whole characters, over every token so far); a receiver key says how much
    text the receiver has finished (whole characters its later tokens will not touch
    again). Zero-width tokens count upward within one boundary, so the n-th token
    without characters reads at most the first n on the other side.
    """
    if rule == RULE_RAW:
        return [end for _, end in sender_spans], [end for _, end in receiver_spans]
    if rule != RULE_REFINED:
        raise ValueError(f"Unknown alignment rule {rule!r}.")
    scale = len(sender_spans) + len(receiver_spans) + 1

    def keys(spans, whole):
        out, boundary, empties = [], 0, 0
        for start, end in spans:
            if end > start:
                reached = whole(end)
                if reached > boundary:
                    boundary, empties = reached, 0
            else:
                # A token without characters can sit ahead of the text read so far (after
                # a leading gap); it never moves the boundary back.
                if start > boundary:
                    boundary, empties = math.floor(start), 0
                empties += 1
            out.append(boundary * scale + empties)
        return out
    return keys(sender_spans, math.ceil), keys(receiver_spans, math.floor)


def sender_positions(sender_spans, receiver_spans, rule=ALIGNMENT_RULE):
    """Fractional receiver-axis position p_i of every sender token.

    m_i is the midpoint of sender token i. j is the last receiver token starting at
    or before m_i. Then p_i = max(0, j + clip((m_i - a_j) / (b_j - a_j), 0, 1) - 1/2).
    With identical tokenizers and spans that tile the text p_i == i.

    Rule 2 only: the n-th zero-width sender token at an offset takes the index of the
    n-th zero-width receiver token at that offset when there is one (BOS to BOS).
    """
    starts = [start for start, _ in receiver_spans]
    empty, used = {}, {}
    if rule != RULE_RAW:
        for index, (start, end) in enumerate(receiver_spans):
            if end == start:
                empty.setdefault(start, []).append(index)
    positions = []
    for start, end in sender_spans:
        if end == start and start in empty:
            seen = used.get(start, 0)
            used[start] = seen + 1
            positions.append(float(empty[start][min(seen, len(empty[start]) - 1)]))
            continue
        middle = (start + end) / 2
        j = bisect.bisect_right(starts, middle) - 1
        if j < 0:
            positions.append(0.0)
            continue
        a, b = receiver_spans[j]
        fraction = (middle - a) / (b - a) if b > a else 0.5
        fraction = min(1.0, max(0.0, fraction))
        positions.append(float(max(0.0, j + fraction - 0.5)))
    return positions


def causal_mask(sender_spans, receiver_spans, rule=ALIGNMENT_RULE):
    """allowed[j][i] is True when receiver token j may read sender token i (`reading_keys`).

    A receiver token never reads text that comes after it, so the mapper stays causal
    and a cache prefix maps to a cache prefix.
    """
    sender_keys, receiver_keys = reading_keys(sender_spans, receiver_spans, rule)
    return [[key_s <= key_r for key_s in sender_keys] for key_r in receiver_keys]


def visible_counts(sender_spans, receiver_spans, rule=ALIGNMENT_RULE):
    """How many sender tokens each receiver token sees."""
    sender_keys, receiver_keys = reading_keys(sender_spans, receiver_spans, rule)
    ordered = sorted(sender_keys)
    return [bisect.bisect_right(ordered, key) for key in receiver_keys]


def blind_receiver(sender_spans, receiver_spans, rule=ALIGNMENT_RULE):
    """True for each receiver token that may read no sender token (it gets the sink only)."""
    return [count == 0 for count in visible_counts(sender_spans, receiver_spans, rule)]


def unread_sender(sender_spans, receiver_spans, rule=ALIGNMENT_RULE):
    """True for each sender token that no receiver token may read."""
    sender_keys, receiver_keys = reading_keys(sender_spans, receiver_spans, rule)
    last = max(receiver_keys, default=None)
    return [last is None or key > last for key in sender_keys]


def common_cut(sender_spans, receiver_spans):
    """How many leading tokens to keep on each side so both cover the same characters.

    A side can stop after token i when the tokens up to i cover whole characters only.
    The cut is the furthest such coverage that both sides can stop at; tokens without
    characters that follow it stay with it. (0, 0) when the sides share no cut.

    Cutting at the smaller of the two last offsets (rule 1) can leave one side's tail
    over text whose token on the other side was dropped.
    """
    def stops(spans):
        table, covered = {}, 0
        for index, (_, end) in enumerate(spans):
            covered = max(covered, end)
            if covered > 0 and covered == int(covered):
                table[int(covered)] = index + 1
        return table
    sender, receiver = stops(sender_spans), stops(receiver_spans)
    shared = set(sender) & set(receiver)
    if not shared:
        return 0, 0
    cut = max(shared)
    return sender[cut], receiver[cut]


KINDS = ("one_to_one", "one_to_many", "many_to_one", "crossing", "unaligned")


def classify(sender_spans, receiver_spans):
    """How each sender token sits on the receiver's tokens, by shared characters.

    one_to_one   a receiver token has the same span
    one_to_many  the sender token covers two or more receiver tokens exactly
    many_to_one  the sender token lies inside one longer receiver token
    crossing     its boundaries cut through receiver tokens
    unaligned    no receiver token shares a character with it
    """
    wide = [(start, end) for start, end in receiver_spans if end > start]
    starts = [start for start, _ in wide]
    empty = {start for start, end in receiver_spans if end == start}
    kinds = []
    for start, end in sender_spans:
        if end == start:
            kinds.append("one_to_one" if start in empty else "unaligned")
            continue
        low = bisect.bisect_right(starts, start) - 1
        if low < 0 or wide[low][1] <= start:
            low += 1
        high = bisect.bisect_left(starts, end)
        over = wide[low:high]
        if not over:
            kinds.append("unaligned")
        elif len(over) == 1 and over[0] == (start, end):
            kinds.append("one_to_one")
        elif over[0][0] == start and over[-1][1] == end and len(over) > 1:
            kinds.append("one_to_many")
        elif len(over) == 1 and over[0][0] <= start and end <= over[0][1]:
            kinds.append("many_to_one")
        else:
            kinds.append("crossing")
    return kinds


def align_document(sender_spans, receiver_spans, text_length=None, max_tokens=None, rule=ALIGNMENT_RULE):
    """Spans of one document on both sides, cut so both describe the same characters.

    Rule 2: the spans are the whole text's raw offsets; they are refined, each side is
    cut to max_tokens (None: no limit), and both stop at the cut they share
    (`common_cut`). Rule 1: the spans are already truncated raw offsets; each side
    keeps tokens ending at or before the smaller last offset.

    Returns (sender_keep, sender_spans, receiver_keep, receiver_spans): the indexes of
    the tokens kept on each side and their spans.
    """
    if rule == RULE_RAW:
        limit = min(sender_spans[-1][1] if sender_spans else 0, receiver_spans[-1][1] if receiver_spans else 0)
        keep_s = [i for i, (_, end) in enumerate(sender_spans) if end <= limit]
        keep_r = [i for i, (_, end) in enumerate(receiver_spans) if end <= limit]
    elif rule == RULE_REFINED:
        sender_spans = refine_spans(sender_spans, text_length)[:max_tokens]
        receiver_spans = refine_spans(receiver_spans, text_length)[:max_tokens]
        count_s, count_r = common_cut(sender_spans, receiver_spans)
        keep_s, keep_r = list(range(count_s)), list(range(count_r))
    else:
        raise ValueError(f"Unknown alignment rule {rule!r}.")
    return keep_s, [sender_spans[i] for i in keep_s], keep_r, [receiver_spans[i] for i in keep_r]
