"""W3: the confidence score of a released answer (docs/watchdog-security.md, W3).

The score is the log-probability the solver gave to the final number it wrote: the sum of
the log-probabilities of the tokens that spell the number the grader reads
(evaluate.predicted_span: after the last "answer is", else in the last \\boxed{}, else the
last number), read from the decode's own token probabilities. It needs no extra model call.

The number is found on the released answer itself, and its tokens are found by the decoded
text of each generated token. When those pieces do not join into exactly the text the
answer was cut from (a character split across tokens, for example), there is no score: an
answer with no score is never released on a calibrated kind of task, so a score is never of
a different number from the one graded.

This is one simple score, chosen before calibrating. The threshold on it comes from
abstain.choose_threshold; the probe of eval 13 is reported, not used.

Standard library only.
"""
import math

from .evaluate import predicted_span


def number_span(text):
    """(start, end) of the graded number in text, or None."""
    found = predicted_span(text)
    return None if found is None else (found[1], found[2])


def answer_logprob(pieces, logprobs, raw=None):
    """The log-probability of the graded number. pieces: the decoded text of each generated
    token, in order; logprobs: each token's log-probability; raw: the decode of all of them
    before the answer was stripped (team.decode gives it), which the pieces must join into
    exactly. None without a number, without an exact alignment, or with a value that is not
    a finite log-probability."""
    if not pieces or len(pieces) != len(logprobs):
        return None
    text = "".join(pieces)
    if raw is not None and text != raw:
        return None
    lead = len(text) - len(text.lstrip())
    span = number_span(text.strip())
    if span is None:
        return None
    start, end = span[0] + lead, span[1] + lead
    total, at, used = 0.0, 0, False
    for piece, value in zip(pieces, logprobs):
        piece_start, piece_end = at, at + len(piece)
        if piece_end > start and piece_start < end:   # the token overlaps the number
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) \
                    or value > 0:
                return None
            total += value
            used = True
        at = piece_end
    return total if used else None
