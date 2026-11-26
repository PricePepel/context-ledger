"""Scoring and intervals for the cross-model harness. Standard library only."""
import random

from latent_transfer.data import f1, normalize

from .prompts import ABSTAIN_REPLY

BOOTSTRAP_ROUNDS = 10000


def exact(prediction, answers):
    """SQuAD exact match: 1.0 when the normalized prediction equals a normalized answer."""
    pred = normalize(prediction)
    return float(any(pred == normalize(answer) for answer in answers))


def hit(prediction, answers):
    """1.0 when a gold answer appears in the prediction, ignoring case, ASCII punctuation
    and all whitespace. Unlike token F1 this works for scripts written without spaces
    (Chinese, Japanese), where a whole sentence is one whitespace token."""
    pred = "".join(normalize(prediction).split())
    golds = ["".join(normalize(answer).split()) for answer in answers]
    return float(any(gold and gold in pred for gold in golds))


def abstained(prediction):
    """Whether the reply is the abstain phrase the prompt asked for."""
    return float(ABSTAIN_REPLY in " ".join(normalize(prediction).split()))


def score(prediction, item):
    """Per-item scores. An unanswerable item is right only when the model abstains."""
    answers = item.get("answers") or []
    if not item.get("answerable", True):
        value = abstained(prediction)
        return {"f1": value, "em": value, "hit": value, "abstained": value}
    return {"f1": f1(prediction, answers), "em": exact(prediction, answers), "hit": hit(prediction, answers),
            "abstained": abstained(prediction)}


def mean(values):
    values = list(values)
    return sum(values) / len(values) if values else None


def _percentiles(samples):
    samples = sorted(samples)
    rounds = len(samples)
    return samples[int(0.025 * rounds)], samples[min(rounds - 1, int(0.975 * rounds))]


def mean_interval(values, rounds=BOOTSTRAP_ROUNDS, seed=0):
    """Bootstrap 95% interval of the mean over resampled items."""
    n = len(values)
    if n == 0:
        return None
    rng = random.Random(seed)
    return _percentiles(sum(values[rng.randrange(n)] for _ in range(n)) / n for _ in range(rounds))


def paired_interval(values_a, values_b, rounds=BOOTSTRAP_ROUNDS, seed=0):
    """Bootstrap 95% interval of mean(a - b), resampling items so each pair stays together."""
    if len(values_a) != len(values_b):
        raise ValueError("Paired arms must cover the same items.")
    return mean_interval([a - b for a, b in zip(values_a, values_b)], rounds, seed)


def compare(values_a, values_b, rounds=BOOTSTRAP_ROUNDS, seed=0):
    """{diff, low, high, n} for arm a minus arm b on the same items."""
    if not values_a:
        return None
    low, high = paired_interval(values_a, values_b, rounds, seed)
    return {"diff": round(mean(values_a) - mean(values_b), 4), "low": round(low, 4), "high": round(high, 4),
            "n": len(values_a)}


def kv_bytes(layers, kv_heads, head_dim, tokens, bytes_per_value=2):
    """Size of a KV cache as raw tensors: keys and values for every layer and token."""
    return layers * 2 * kv_heads * head_dim * tokens * bytes_per_value
