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

`refine_spans` turns raw offsets into a partition; alignment rule 2 uses it. Rule 1
is the raw offsets, kept so mappers trained before the audit load as they trained.
"""
import bisect
from fractions import Fraction

RULE_RAW = 1      # raw offsets, cut at the smaller last offset (before the L3 audit)
RULE_REFINED = 2  # refined spans, cut at a boundary both sides share
ALIGNMENT_RULE = RULE_REFINED


def refine_spans(spans, text_length=None):
    """Raw token offsets -> spans that tile the text in token order.

    1. Characters no token covers join the token before them (the first token, when
       they come before every token). With text_length, the last token is extended to
       the end of the text; pass it only when the spans are the whole text.
    2. A character that several tokens report is divided equally among them in token
       order, so sub-character pieces get distinct, ordered, fractional spans. The
       fractions are exact (`fractions.Fraction`), so two tokenizers that divide a
       character the same way agree on the boundary.

    Zero-width tokens (a BOS with span (0, 0)) are left as they are. Offsets that are
    already a partition come back unchanged, as the same integers.
    """
    out = [[start, end] for start, end in spans]
    wide = [i for i, (start, end) in enumerate(out) if end > start]
    previous_start = 0
    for start, end in out:
        if end < start or start < previous_start:
            raise ValueError("Token spans are not in text order.")
        previous_start = start
    # 1. Close gaps.
    covered, last = 0, None
    for i in wide:
        if out[i][0] > covered:
            if last is None:
                out[i][0] = covered
            else:
                out[last][1] = out[i][0]
        if out[i][1] >= covered:
            covered, last = out[i][1], i
    if text_length is not None and last is not None and covered < text_length:
        out[last][1] = text_length
    # 2. Divide shared characters.
    clean, reach = True, 0
    for i in wide:
        if out[i][0] < reach:
            clean = False
            break
        reach = out[i][1]
    if not clean:
        total, rank_first, rank_last = {}, {}, {}
        for i in wide:
            start, end = out[i]
            for char in range(start, end):
                seen = total.get(char, 0)
                if char == start:
                    rank_first[i] = seen
                if char == end - 1:
                    rank_last[i] = seen
                total[char] = seen + 1
        for i in wide:
            start, end = out[i]
            if total[start] > 1:
                out[i][0] = start + Fraction(rank_first[i], total[start])
            if total[end - 1] > 1:
                out[i][1] = (end - 1) + Fraction(rank_last[i] + 1, total[end - 1])
            for side in (0, 1):
                if out[i][side] == int(out[i][side]):
                    out[i][side] = int(out[i][side])
    return [(start, end) for start, end in out]


def common_end(sender_spans, receiver_spans):
    """The last offset at which both sides have a token boundary (0 when there is none).

    Cutting both sides there leaves them over exactly the same characters; cutting at
    the smaller of the two last offsets (rule 1) can leave one side's tail over text
    whose token on the other side was dropped.
    """
    receiver_ends = {end for _, end in receiver_spans}
    return max((end for _, end in sender_spans if end in receiver_ends), default=0)


def sender_positions(sender_spans, receiver_spans):
    """Fractional receiver-axis position p_i of every sender token.

    m_i is the midpoint of sender token i. j is the last receiver token starting at
    or before m_i. Then p_i = max(0, j + clip((m_i - a_j) / (b_j - a_j), 0, 1) - 1/2).
    With identical tokenizers and spans that tile the text p_i == i. A zero-width
    sender token takes the index of a zero-width receiver token at the same offset
    when there is one (BOS to BOS).
    """
    starts = [start for start, _ in receiver_spans]
    empty = {}
    for index, (start, end) in enumerate(receiver_spans):
        if end == start:
            empty.setdefault(start, index)
    positions = []
    for start, end in sender_spans:
        if end == start and start in empty:
            positions.append(float(empty[start]))
            continue
        middle = (start + end) / 2
        j = bisect.bisect_right(starts, middle) - 1
        if j < 0:
            positions.append(0.0)
            continue
        a, b = receiver_spans[j]
        fraction = (middle - a) / (b - a) if b > a else 0.5
        fraction = min(1.0, max(0.0, fraction))
        positions.append(float(max(0, j + fraction - 0.5)))
    return positions


def causal_mask(sender_spans, receiver_spans):
    """allowed[j][i] is True when sender token i ends no later than receiver token j.

    A receiver token never reads text that comes after it, so the mapper stays causal
    and a cache prefix maps to a cache prefix.
    """
    sender_ends = [end for _, end in sender_spans]
    return [[end_s <= end_r for end_s in sender_ends] for _, end_r in receiver_spans]


def visible_counts(sender_spans, receiver_spans):
    """How many sender tokens each receiver token sees (spans are sorted by end)."""
    ends = sorted(end for _, end in sender_spans)
    return [bisect.bisect_right(ends, end_r) for _, end_r in receiver_spans]


def blind_receiver(sender_spans, receiver_spans):
    """True for each receiver token that may read no sender token (it gets the sink only)."""
    return [count == 0 for count in visible_counts(sender_spans, receiver_spans)]


def unread_sender(sender_spans, receiver_spans):
    """True for each sender token that no receiver token may read."""
    last = max((end for _, end in receiver_spans), default=None)
    return [last is None or end > last for _, end in sender_spans]


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
    cut to max_tokens, and both stop at the last boundary they share. Rule 1: the spans
    are already truncated raw offsets; each side keeps tokens ending at or before the
    smaller last offset.

    Returns (sender_keep, sender_spans, receiver_keep, receiver_spans): the indexes of
    the tokens kept on each side and their spans.
    """
    if rule == RULE_RAW:
        limit = min(sender_spans[-1][1] if sender_spans else 0, receiver_spans[-1][1] if receiver_spans else 0)
    elif rule == RULE_REFINED:
        sender_spans = refine_spans(sender_spans, text_length)[:max_tokens]
        receiver_spans = refine_spans(receiver_spans, text_length)[:max_tokens]
        limit = common_end(sender_spans, receiver_spans)
    else:
        raise ValueError(f"Unknown alignment rule {rule!r}.")
    keep_s = [i for i, (_, end) in enumerate(sender_spans) if end <= limit]
    keep_r = [i for i, (_, end) in enumerate(receiver_spans) if end <= limit]
    return keep_s, [sender_spans[i] for i in keep_s], keep_r, [receiver_spans[i] for i in keep_r]
