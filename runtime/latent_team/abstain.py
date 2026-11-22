"""W3: calibrated abstention (docs/watchdog-security.md, "What we can and cannot say").

No one can promise that a model does not hallucinate. What can be promised, per kind of
task, is a measured ceiling on the error rate of the answers that are released, with the
system declining to answer when its confidence is low:

    "On [kind of task], at most X% of released answers are wrong, measured on N labelled
     examples; the system declines to answer Y% of the time."

The threshold is chosen by learn then test (Angelopoulos et al. 2021; selective risk as in
Geifman and El-Yaniv 2017) with the candidates fixed before the test data is looked at:
GRID candidate thresholds at the scores that release 5%, 10%, ... 100% of a separate
proposal set (its scores alone; which answers are wrong is never used), each then tested on
a certification set at delta / GRID (Bonferroni). A candidate passes when the one-sided
Clopper-Pearson upper bound of the error among the certification answers it releases is at
or under the target; the loosest passing candidate is kept. Because each candidate is fixed
before the certification rows are seen, each test is an ordinary binomial test of a fixed
release rule, and the Bonferroni correction covers the whole grid. With no passing
candidate the kind of task is not certified: nothing about it is claimed, and no
calibration is written.

A grid rather than a fixed sequence from the strictest threshold, because fallback answers
are always released, so the risk is not monotone in the threshold.

The guarantee holds only while live questions are exchangeable with the certification set
(same kind of task, same weights and settings), and it is about the policy tested: W1's
supervisor first (holds release nothing, fallbacks are always released), then the
threshold. A kind of task with no calibration for these weights and settings is marked
uncalibrated and no ceiling is claimed (supervisor row 7). A calibration file that matches
this task and model but is malformed or not certified is refused, and the run is held.

Standard library only.
"""
import json
import math
import os

CALIBRATION_DIR = os.path.join(os.path.dirname(__file__), "calibration")
GRID = 20


class CalibrationInvalid(ValueError):
    """A calibration for this task and model exists but cannot be trusted: hold the run."""


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _refuse_constant(word):
    raise CalibrationInvalid(f"{word} is not a number")   # NaN, Infinity and -Infinity


def validate(data):
    """Raise CalibrationInvalid unless data is a certified, held-out-passed calibration with a
    finite threshold and every field the binding needs."""
    if not isinstance(data, dict):
        raise CalibrationInvalid("not an object")
    if data.get("certified") is not True:
        raise CalibrationInvalid("not certified")
    held_out = data.get("heldOut")
    if not isinstance(held_out, dict) or held_out.get("passed") is not True:
        raise CalibrationInvalid("did not pass on held-out data")
    if not _finite(data.get("threshold")):
        raise CalibrationInvalid("threshold is not a finite number")
    for name in ("target", "delta"):
        if not _finite(data.get(name)) or not 0 < data[name] < 1:
            raise CalibrationInvalid(f"{name} is not a rate")
    for name in ("task", "model", "weightsHash", "thresholdSet", "score"):
        if not isinstance(data.get(name), str) or not data[name]:
            raise CalibrationInvalid(f"{name} is missing")
    for name in ("steps", "maxNewTokens"):
        if not isinstance(data.get(name), int) or isinstance(data[name], bool) or data[name] <= 0:
            raise CalibrationInvalid(f"{name} is not a positive count")
    if not isinstance(data.get("reference"), bool):
        raise CalibrationInvalid("reference is not a boolean")
    return data


def load_calibration(model_name, weights_hash, task, *, steps, max_new_tokens, threshold_set, reference,
                     directory=CALIBRATION_DIR):
    """The committed calibration for this task, model and weights, measured with these
    settings (latent steps, the solver's token budget, W1's threshold set and whether the
    distance reference was on), or None: the run is then uncalibrated (released, marked so,
    no ceiling claimed). Raises CalibrationInvalid when a file names this task and model but
    cannot be read or trusted, or when a file cannot be read at all: the guard then holds."""
    if not task or not os.path.isdir(directory):
        return None
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(directory, name), encoding="utf-8") as handle:
                data = json.load(handle, parse_constant=_refuse_constant)
        except (OSError, ValueError) as error:
            raise CalibrationInvalid(f"{name} cannot be read") from error
        if not isinstance(data, dict) or (data.get("task"), data.get("model")) != (task, model_name):
            continue
        validate(data)
        if (data["weightsHash"], data["steps"], data["maxNewTokens"], data["thresholdSet"], data["reference"]) == \
                (weights_hash, steps, max_new_tokens, threshold_set, bool(reference)):
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


def candidates(scores, grid=GRID):
    """The grid: thresholds at the finite scores of the proposal set that release 1/grid,
    2/grid, ... of them. Set from those scores alone (math.inf scores, always released, and
    None, never released, are left out)."""
    finite = sorted((s for s in scores if s is not None and s != math.inf), reverse=True)
    if not finite:
        return []
    picks = []
    for step in range(1, grid + 1):
        value = finite[max(0, math.ceil(step * len(finite) / grid) - 1)]
        if value not in picks:
            picks.append(value)
    return picks


def released(scores, wrong, threshold):
    """The wrong flags of the answers a threshold releases: score at or above it (math.inf
    always; None never). threshold None (not certified) releases only math.inf scores."""
    return [w for s, w in zip(scores, wrong)
            if s is not None and (s == math.inf or (threshold is not None and s >= threshold))]


def choose_threshold(proposal_scores, certify_scores, certify_wrong, target=0.10, delta=0.05, grid=GRID):
    """The loosest candidate (from the proposal scores) whose released certification answers
    keep the upper bound of their error at or under target, each tested at delta / grid.
    Returns (threshold, steps, chosen): threshold None when no candidate passes (nothing is
    certified); steps lists every candidate's test; chosen is the kept candidate's step."""
    level = delta / grid
    threshold, steps, chosen = None, [], None
    for value in candidates(proposal_scores, grid):
        picked = released(certify_scores, certify_wrong, value)
        step = {"threshold": value, "released": len(picked), "errors": sum(picked),
                "upper": upper_bound(sum(picked), len(picked), level)}
        steps.append(step)
        if step["upper"] <= target and (threshold is None or value < threshold):
            threshold, chosen = value, step
    return threshold, steps, chosen


def score_threshold(scores, wrong, threshold, target=0.10):
    """What a threshold does on held-out questions: released share, error among released
    with its 95% Wilson interval, and eval 11's pass rule (a certified threshold, error at or
    under target plus 1.645 standard errors for the number released, and at least half
    released). threshold None (not certified) never passes."""
    n = len(scores)
    picked = released(scores, wrong, threshold)
    k, m = sum(picked), len(picked)
    error = k / m if m else 0.0
    allowance = target + 1.645 * math.sqrt(target * (1 - target) / m) if m else target
    return {"questions": n, "released": m, "releasedShare": round(m / n, 4) if n else 0.0,
            "notReleased": n - m, "notReleasedShare": round((n - m) / n, 4) if n else 0.0,
            "errors": k, "error": round(error, 4), "error95": [round(x, 4) for x in wilson(k, m)],
            "allowance": round(allowance, 4), "certified": threshold is not None,
            "passed": bool(threshold is not None and m and error <= allowance and m >= n / 2)}


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
