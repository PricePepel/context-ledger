"""W3: the confidence score of a released answer (docs/watchdog-security.md, W3).

The score is the log-probability the solver gave to the final number it wrote: the sum of
the log-probabilities of the tokens that spell the number after the last "answer is" (or,
without that phrase, the last number in the text), read from the decode's own token
probabilities. It needs no extra model call. An answer with no number has no score, so on
a calibrated kind of task it is never released as an answer.

This is one simple score, chosen before calibrating. The threshold on it comes from
abstain.choose_threshold on a calibration set; the probe of eval 13 joins it only if it
adds on held-back data.

Standard library only.
"""
import re

NUMBER = re.compile(r"-?\d[\d,]*(?:\.\d+)?")


def _trimmed(match):
    """A match's span without trailing commas ("7, not 72" ends the number at 7)."""
    start, end = match.span()
    while end > start + 1 and match.string[end - 1] == ",":
        end -= 1
    return start, end


def number_span(text):
    """(start, end) of the final answer's number in text, the way evaluate.predicted_number
    picks it: the first number after the last "answer is", else in the last \\boxed{}, else
    the last number. None when there is none."""
    lowered = text.lower()
    clean = text.replace("$", " ")
    if "answer is" in lowered:
        at = lowered.rindex("answer is")
        match = NUMBER.search(clean, at)
        if match:
            return _trimmed(match)
    boxed = list(re.finditer(r"\\boxed\{([^}]*)\}", text))
    if boxed:
        match = NUMBER.search(clean, boxed[-1].start(1), boxed[-1].end(1))
        if match:
            return _trimmed(match)
    found = list(NUMBER.finditer(clean))
    return _trimmed(found[-1]) if found else None


def answer_logprob(pieces, logprobs):
    """The log-probability of the final number, from the decoded text of each generated token
    (pieces, concatenated in order) and each token's log-probability. None without a number."""
    if len(pieces) != len(logprobs) or not pieces:
        return None
    text = "".join(pieces)
    span = number_span(text)
    if span is None:
        return None
    start, end = span
    total, at, used = 0.0, 0, False
    for piece, value in zip(pieces, logprobs):
        piece_start, piece_end = at, at + len(piece)
        if piece_end > start and piece_start < end:   # the token overlaps the number
            total += value
            used = True
        at = piece_end
    return total if used else None
