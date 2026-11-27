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

Rule 2 separates two questions that rule 1 answered with the same number:

- Where does a token sit? `refine_spans` turns the raw offsets into spans that tile the
  text, and the midpoint rule runs on those, so pieces of one character get distinct,
  ordered positions.
- What may be read? That goes by what the raw offsets say each token touched
  (`ownership`), never by the refined geometry: a sender token is readable once the
  receiver has finished every character the sender had touched when it wrote that
  token. A character is finished only when no later token reports it, because how far
  inside a character a token reaches is not in the offsets. Tokens with no characters
  (a BOS) are ordered by their count at that point.
- Truncation: both sides stop at the last point where each has finished exactly what
  it has touched, and the two agree.

A character no token reports belongs to the token before it (to the first token with
characters, at the start of the text).
"""
import bisect
import math
from collections import namedtuple
from fractions import Fraction

RULE_RAW = 1      # raw offsets, cut at the smaller last offset (before the L3 audit)
RULE_REFINED = 2  # refined spans for positions, raw ownership for visibility and cuts
ALIGNMENT_RULE = RULE_REFINED


def _whole(value):
    return int(value) if value == int(value) else value


def _wide(spans):
    """Indexes of the tokens that have characters, after checking they are in text order.
    Zero-width tokens are not checked: a tokenizer may give them any offset."""
    wide = [i for i, (start, end) in enumerate(spans) if end > start]
    previous = 0
    for start, end in spans:
        if end < start:
            raise ValueError("Token spans are not in text order.")
    for i in wide:
        if spans[i][0] < previous:
            raise ValueError("Token spans are not in text order.")
        previous = spans[i][0]
    return wide


def refine_spans(spans, text_length=None):
    """Raw token offsets -> spans that tile the text in token order.

    Each token with characters runs from the boundary before it to the boundary after
    it. The boundary between two neighbours is:
    - where the later one starts, when that is at or after everything before it ends,
      so characters no token covers join the token before them;
    - otherwise the two overlap, and the boundary falls inside their overlap. n
      boundaries in a row over the same overlap divide it into n + 1 equal parts: four
      byte pieces of one character get a quarter each, in token order. A boundary never
      comes before the one ahead of it.
    The first boundary is 0. The last is text_length when given (pass it only when the
    spans are the whole text), else the furthest end.

    Zero-width tokens (a BOS with span (0, 0)) are left as they are. Offsets that are
    already a partition come back unchanged, as the same integers. Divided boundaries
    are exact fractions. Tokens with characters must be in text order (ValueError).
    """
    wide = _wide(spans)
    out = [(start, end) for start, end in spans]
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
        if low == high:
            bounds.append(low)
            index += 1
            continue
        run = 1
        while index + run < len(limits) and limits[index + run] == (low, high):
            run += 1
        low = max(low, bounds[-1])       # an earlier, longer overlap may already reach past `low`
        for step in range(1, run + 1):
            bounds.append(_whole(low + Fraction((high - low) * step, run + 1)))
        index += run
    bounds.append(last)
    for slot, i in enumerate(wide):
        out[i] = (bounds[slot], bounds[slot + 1])
    return out


def ownership(spans, text_length=None):
    """(touched, finished) per token, from raw offsets of a whole text.

    touched[i]: the text up to this character has been touched by tokens 0..i (every
    character one of them reports, and the unreported characters that follow it).
    finished[i]: the text up to this character will not be touched by any token after
    i. A token that completes whole characters has touched == finished; a piece of a
    character has touched > finished until the last piece. Both lists never decrease.
    """
    wide = _wide(spans)
    end_of_text = max([spans[i][1] for i in wide] + [text_length or 0])
    # How far each token with characters reaches once the unreported characters after it
    # are counted in. Those belong to the last token over the character before them,
    # which after a nested overlap is not the token just before the gap.
    extent, reach, holder = {}, 0, None
    for i in wide:
        start, end = spans[i]
        if holder is not None and start > reach:
            extent[holder] = math.floor(start)
        extent[i] = math.ceil(end)
        if holder is None or end >= reach:
            reach, holder = max(reach, end), i
    if holder is not None:
        extent[holder] = max(extent[holder], end_of_text)
    touched, finished = [], []
    far, slot = 0, 0                 # slot: index into `wide` of the next token with characters
    for index in range(len(spans)):
        if slot < len(wide) and wide[slot] == index:
            far = max(far, extent[index])
            slot += 1
        # Nothing with characters yet: a leading gap is the first such token's, so nothing is finished.
        following = 0 if slot == 0 else (math.floor(spans[wide[slot]][0]) if slot < len(wide) else end_of_text)
        touched.append(far)
        finished.append(following)
    return touched, finished


def _keys(bounds, counted, scale):
    """Boundaries plus the number of counted zero-width tokens met at that boundary, as one integer."""
    out, current, empties = [], None, 0
    for bound, count in zip(bounds, counted):
        if bound != current:
            current, empties = bound, 0
        empties += count
        out.append(bound * scale + empties)
    return out


def reading_keys(sender_spans, receiver_spans, rule=ALIGNMENT_RULE, text_length=None):
    """Two lists of integers: receiver token j may read sender token i when
    sender_key[i] <= receiver_key[j].

    Rule 1: the keys are the span ends.

    Rule 2: pass the raw offsets of the whole text. A sender key is what the sender had
    touched when it wrote the token; a receiver key is what the receiver has finished
    (`ownership`). Zero-width tokens count upward at one boundary, so the n-th token
    without characters reads at most the first n on the other side. On the sender side
    only a zero-width token at a clean boundary counts (the sender has finished all it
    has touched); one that sits between the pieces of a character is part of that
    character's run and becomes readable with it.
    """
    if rule == RULE_RAW:
        return [end for _, end in sender_spans], [end for _, end in receiver_spans]
    if rule != RULE_REFINED:
        raise ValueError(f"Unknown alignment rule {rule!r}.")
    scale = len(sender_spans) + len(receiver_spans) + 1
    touched, done = ownership(sender_spans, text_length)
    _, finished = ownership(receiver_spans, text_length)
    sender_counted = [end == start and touched[i] == done[i] for i, (start, end) in enumerate(sender_spans)]
    receiver_counted = [end == start for start, end in receiver_spans]
    return _keys(touched, sender_counted, scale), _keys(finished, receiver_counted, scale)


def sender_positions(sender_spans, receiver_spans, rule=ALIGNMENT_RULE):
    """Fractional receiver-axis position p_i of every sender token.

    m_i is the midpoint of sender token i. j is the last receiver token starting at
    or before m_i. Then p_i = max(0, j + clip((m_i - a_j) / (b_j - a_j), 0, 1) - 1/2).

    Rule 2: pass refined spans. With identical tokenizers p_i == i. Only receiver tokens
    with characters are searched; the n-th zero-width sender token at an offset takes the
    index of the n-th zero-width receiver token at that offset when there is one (BOS to
    BOS), and otherwise sits where its offset falls.
    """
    if rule == RULE_RAW:
        starts = [start for start, _ in receiver_spans]
        positions = []
        for start, end in sender_spans:
            middle = (start + end) / 2
            j = bisect.bisect_right(starts, middle) - 1
            if j < 0:
                positions.append(0.0)
                continue
            a, b = receiver_spans[j]
            fraction = (middle - a) / (b - a) if b > a else 0.5
            fraction = min(1.0, max(0.0, fraction))
            positions.append(max(0.0, j + fraction - 0.5))
        return positions
    if rule != RULE_REFINED:
        raise ValueError(f"Unknown alignment rule {rule!r}.")
    wide = [index for index, (start, end) in enumerate(receiver_spans) if end > start]
    starts = [receiver_spans[index][0] for index in wide]
    # A receiver with any divided character is searched with exact midpoints throughout.
    clean = all(type(value) is int for span in receiver_spans for value in span)
    empty, used = {}, {}
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
        # Whole-character spans use rule 1's own float arithmetic from the midpoint on, so
        # text that needs no refinement gets bit-identical positions under both rules.
        whole = clean and type(start) is int and type(end) is int
        middle = (start + end) / 2 if whole else Fraction(start + end) / 2
        slot = bisect.bisect_right(starts, middle) - 1
        if slot < 0:
            positions.append(0.0)
            continue
        a, b = receiver_spans[wide[slot]]
        if whole and type(a) is int and type(b) is int:
            fraction = min(1.0, max(0.0, (middle - a) / (b - a)))
            positions.append(max(0.0, wide[slot] + fraction - 0.5))
            continue
        middle = Fraction(start + end) / 2
        fraction = min(Fraction(1), max(Fraction(0), (middle - a) / (b - a)))
        positions.append(float(max(Fraction(0), wide[slot] + fraction - Fraction(1, 2))))
    return positions


def causal_mask(sender_spans, receiver_spans, rule=ALIGNMENT_RULE, text_length=None):
    """allowed[j][i] is True when receiver token j may read sender token i (`reading_keys`;
    under rule 2 the spans are raw offsets of the whole text).

    A receiver token never reads text that comes after it, so the mapper stays causal
    and a cache prefix maps to a cache prefix.
    """
    sender_keys, receiver_keys = reading_keys(sender_spans, receiver_spans, rule, text_length)
    return [[key_s <= key_r for key_s in sender_keys] for key_r in receiver_keys]


def visible_counts(sender_spans, receiver_spans, rule=ALIGNMENT_RULE, text_length=None):
    """How many sender tokens each receiver token sees."""
    sender_keys, receiver_keys = reading_keys(sender_spans, receiver_spans, rule, text_length)
    ordered = sorted(sender_keys)
    return [bisect.bisect_right(ordered, key) for key in receiver_keys]


def blind_receiver(sender_spans, receiver_spans, rule=ALIGNMENT_RULE, text_length=None):
    """True for each receiver token that may read no sender token (it gets the sink only)."""
    return [count == 0 for count in visible_counts(sender_spans, receiver_spans, rule, text_length)]


def unread_sender(sender_spans, receiver_spans, rule=ALIGNMENT_RULE, text_length=None):
    """True for each sender token that no receiver token may read."""
    sender_keys, receiver_keys = reading_keys(sender_spans, receiver_spans, rule, text_length)
    last = max(receiver_keys, default=None)
    return [last is None or key > last for key in sender_keys]


def common_cut(sender_spans, receiver_spans, text_length=None, max_tokens=None):
    """How many leading tokens to keep on each side so both cover the same characters.

    Raw offsets of the whole text. A side can stop after token i when it has finished
    exactly what it has touched (no later token reports any of it) and that is more than
    nothing. The cut is the furthest such point within max_tokens (None: no limit) that
    both sides can stop at; tokens without characters that follow it stay with it.
    (0, 0) when the sides share no cut.

    Cutting at the smaller of the two last offsets (rule 1) can leave one side's tail
    over text whose token on the other side was dropped.
    """
    def stops(spans):
        touched, finished = ownership(spans, text_length)
        limit = len(spans) if max_tokens is None else min(len(spans), max_tokens)
        return {touched[i]: i + 1 for i in range(limit) if touched[i] == finished[i] and touched[i] > 0}
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


class Aligned(namedtuple("Aligned", "sender_keep sender_spans receiver_keep receiver_spans "
                                    "sender_keys receiver_keys rule")):
    """One document on both sides after the cut: the indexes of the tokens kept, their
    spans (refined under rule 2), and the integer reading keys of the kept tokens."""

    def positions(self):
        return sender_positions(self.sender_spans, self.receiver_spans, self.rule)

    def mask(self):
        return [[key_s <= key_r for key_s in self.sender_keys] for key_r in self.receiver_keys]

    def unread(self):
        """True for each kept sender token no kept receiver token may read."""
        last = max(self.receiver_keys, default=None)
        return [last is None or key > last for key in self.sender_keys]

    def blind(self):
        """True for each kept receiver token that reads no kept sender token."""
        first = min(self.sender_keys, default=None)
        return [first is None or key < first for key in self.receiver_keys]


def align_document(sender_spans, receiver_spans, text_length=None, max_tokens=None, rule=ALIGNMENT_RULE):
    """One document on both sides, cut so both describe the same characters.

    Rule 2: the spans are the whole text's raw offsets. Both sides stop at the cut they
    share within max_tokens (`common_cut`; None: no limit). Rule 1: the spans are already
    truncated raw offsets; each side keeps tokens ending at or before the smaller last
    offset.
    """
    if rule == RULE_RAW:
        limit = min(sender_spans[-1][1] if sender_spans else 0, receiver_spans[-1][1] if receiver_spans else 0)
        keep_s = [i for i, (_, end) in enumerate(sender_spans) if end <= limit]
        keep_r = [i for i, (_, end) in enumerate(receiver_spans) if end <= limit]
        sender_spans, receiver_spans = [sender_spans[i] for i in keep_s], [receiver_spans[i] for i in keep_r]
        keys = reading_keys(sender_spans, receiver_spans, RULE_RAW)
        return Aligned(keep_s, sender_spans, keep_r, receiver_spans, keys[0], keys[1], rule)
    if rule != RULE_REFINED:
        raise ValueError(f"Unknown alignment rule {rule!r}.")
    count_s, count_r = common_cut(sender_spans, receiver_spans, text_length, max_tokens)
    sender_keys, receiver_keys = reading_keys(sender_spans, receiver_spans, rule, text_length)
    return Aligned(list(range(count_s)), refine_spans(sender_spans, text_length)[:count_s],
                   list(range(count_r)), refine_spans(receiver_spans, text_length)[:count_r],
                   sender_keys[:count_s], receiver_keys[:count_r], rule)
