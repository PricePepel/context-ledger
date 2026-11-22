"""W3: calibrated abstention (docs/watchdog-security.md, "What we can and cannot say").

No one can promise that a model does not hallucinate. What can be promised, per kind of
task, is a measured ceiling on the error rate of the answers that are released, with the
system declining to answer when its confidence is low:

    "On [kind of task], at most X% of released answers are wrong, measured on N labelled
     examples; the system declines to answer Y% of the time."

The threshold is chosen on a calibration set by learn then test (Angelopoulos et al. 2021;
selective risk as in Geifman and El-Yaniv 2017) over a fixed grid: GRID candidate
thresholds at the scores that release 5%, 10%, ... 100% of the calibration answers (set
from the scores alone, never from which answers are wrong), each tested at delta / GRID
(Bonferroni). A candidate passes when the one-sided Clopper-Pearson upper bound of the error
among the answers it releases is at or under the target; the loosest passing candidate is
kept, and with none, nothing is released for that kind of task. A grid with a Bonferroni
correction is used rather than a fixed sequence from the strictest threshold because the
risk is not monotone here: fallback answers are always released, so a few fallback errors
can fail the strictest candidates while looser ones pass.

The guarantee holds only while live questions resemble the calibration set, and only for
the weights the scores were measured on. A kind of task with no calibration set is marked
uncalibrated and no ceiling is claimed (supervisor row 7).

Standard library only.
"""
import json
import math
import os

CALIBRATION_DIR = os.path.join(os.path.dirname(__file__), "calibration")


def load_calibration(model_name, weights_hash, steps, task, directory=CALIBRATION_DIR):
    """The committed calibration for this task on these weights and steps, or None (the run
    is then uncalibrated: released, marked so, with no ceiling claimed)."""
    if not task or not os.path.isdir(directory):
        return None
    for name in sorted(os.listdir(directory)):
        if name.endswith(".json"):
            with open(os.path.join(directory, name), encoding="utf-8") as handle:
                data = json.load(handle)
            if (data.get("task"), data.get("model"), data.get("weightsHash"), data.get("steps")) == \
                    (task, model_name, weights_hash, steps) and isinstance(data.get("threshold"), (int, float)):
                return data
    return None


def _binomial_cdf(k, n, p):
    """P(X <= k) for X ~ Binomial(n, p), summed in log space."""
    if p <= 0:
        return 1.0
    if p >= 1:
        return 0.0 if k < n else 1.0
    log_p, log_q = math.log(p), math.log1p(-p)
    terms = [math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * log_p + (n - i) * log_q
             for i in range(k + 1)]
    top = max(terms)
    return min(1.0, math.exp(top) * sum(math.exp(t - top) for t in terms))


def upper_bound(errors, n, delta=0.05):
    """One-sided Clopper-Pearson upper bound on an error rate: the largest p with
    P(X <= errors | n, p) >= delta. 1.0 when n is 0."""
    if n == 0:
        return 1.0
    if errors >= n:
        return 1.0
    low, high = errors / n, 1.0
    for _ in range(100):
        middle = (low + high) / 2
        if _binomial_cdf(errors, n, middle) > delta:
            low = middle
        else:
            high = middle
    return high


def wilson(errors, n, z=1.959964):
    """A two-sided 95% Wilson interval for an error rate (for reporting)."""
    if n == 0:
        return (0.0, 1.0)
    p = errors / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return (max(0.0, centre - half), min(1.0, centre + half))


GRID = 20


def candidates(scores, grid=GRID):
    """The grid: thresholds at the finite scores that release 1/grid, 2/grid, ... of them.
    Set from the scores alone (math.inf scores, always released, are left out)."""
    finite = sorted((s for s in scores if s is not None and s != math.inf), reverse=True)
    if not finite:
        return []
    picks = []
    for step in range(1, grid + 1):
        value = finite[max(0, math.ceil(step * len(finite) / grid) - 1)]
        if value not in picks:
            picks.append(value)
    return picks


def choose_threshold(scores, wrong, target=0.10, delta=0.05, grid=GRID):
    """The loosest grid threshold whose released answers (score >= threshold) keep the upper
    bound of their error at or under target, each candidate tested at delta / grid.

    scores: a confidence per calibration question (higher is more confident; math.inf always
    releases; None never does). wrong: whether each question's answer is wrong. Returns
    (threshold, steps): threshold is math.inf when no candidate passes, so nothing but the
    always-released answers is released."""
    level = delta / grid
    threshold, steps = math.inf, []
    for value in candidates(scores, grid):
        chosen = [w for s, w in zip(scores, wrong) if s is not None and s >= value]
        bound = upper_bound(sum(chosen), len(chosen), level)
        steps.append({"threshold": value, "released": len(chosen), "errors": sum(chosen), "upper": bound})
        if bound <= target and (threshold == math.inf or value < threshold):
            threshold = value
    return threshold, steps


def score_threshold(scores, wrong, threshold, target=0.10):
    """What a threshold does on held-out questions: released share, error among released
    with its 95% Wilson interval, and eval 11's pass rule (error at or under target plus
    1.645 standard errors for the number released, and at least half released)."""
    n = len(scores)
    released = [w for s, w in zip(scores, wrong) if s is not None and s >= threshold]
    k, m = sum(released), len(released)
    error = k / m if m else 0.0
    allowance = target + 1.645 * math.sqrt(target * (1 - target) / m) if m else target
    return {"questions": n, "released": m, "releasedShare": round(m / n, 4) if n else 0.0,
            "abstained": n - m, "abstainedShare": round((n - m) / n, 4) if n else 0.0,
            "errors": k, "error": round(error, 4), "error95": [round(x, 4) for x in wilson(k, m)],
            "allowance": round(allowance, 4),
            "passed": bool(m and error <= allowance and m >= n / 2)}


def auroc(scores, labels):
    """P(score of a positive > score of a negative), ties counted half; None without both."""
    pos = [s for s, y in zip(scores, labels) if y and s is not None]
    neg = [s for s, y in zip(scores, labels) if not y and s is not None]
    if not pos or not neg:
        return None
    order = sorted([(s, 1) for s in pos] + [(s, 0) for s in neg])
    rank, wins, i = 0, 0.0, 0
    while i < len(order):
        j = i
        while j < len(order) and order[j][0] == order[i][0]:
            j += 1
        positives = sum(label for _, label in order[i:j])
        negatives_below = rank - sum(1 for _, label in order[:i] if label)
        wins += positives * negatives_below + 0.5 * positives * ((j - i) - positives)
        rank += j - i
        i = j
    return wins / (len(pos) * len(neg))
