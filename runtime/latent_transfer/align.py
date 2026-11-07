"""Cross-tokenizer alignment through character spans (SwaT, Sec. 3.2).

Both tokenizers keep their own tokens. Each sender token gets a fractional position
on the receiver's token axis, used as its RoPE position in cross-attention, and a
causal mask says which sender tokens each receiver token may read.

Spans are half-open [start, end) character offsets, as returned by a fast
tokenizer's offset mapping.
"""
import bisect


def sender_positions(sender_spans, receiver_spans):
    """Fractional receiver-axis position p_i of every sender token.

    m_i is the midpoint of sender token i. j is the last receiver token starting at
    or before m_i. Then p_i = max(0, j + clip((m_i - a_j) / (b_j - a_j), 0, 1) - 1/2).
    With identical tokenizers p_i == i.
    """
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
