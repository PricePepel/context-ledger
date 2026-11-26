"""Intervals, the pass rule and the result tables for card L4 (standard library only).

    python -m latent_transfer.statebridge_stats report-a.json report-b.json

prints the Markdown tables of docs/evals.md from the files `statebridge_eval` wrote.
"""
import json
import random
import sys

VARIANTS = ("anchor/summary", "calibrated/summary", "anchor/passage", "calibrated/passage")
PRIMARY = "anchor/summary"
# A secondary variant whose interval starts this close to zero needs a repeat (four tries per pair).
NEAR_ZERO = 0.02


def mean(values):
    values = list(values)
    return sum(values) / len(values) if values else 0.0


def paired_bootstrap(values_a, values_b, rounds=10000, seed=0):
    """(mean of a - b, low, high): a paired 95% percentile interval over resampled items."""
    if len(values_a) != len(values_b) or not values_a:
        raise ValueError("Paired values need the same, non-zero length.")
    diffs = [a - b for a, b in zip(values_a, values_b)]
    n = len(diffs)
    rng = random.Random(seed)
    means = sorted(sum(diffs[rng.randrange(n)] for _ in range(n)) / n for _ in range(rounds))
    return sum(diffs) / n, means[int(0.025 * rounds)], means[min(rounds - 1, int(0.975 * rounds))]


def pass_rule(aligned, mismatched, summary, rounds=10000, seed=0, primary=True):
    """The card's rule for one variant, from per-item F1 lists.

    Passes when aligned beats mismatched with the interval above zero, and the mean of
    aligned is at least the mean of the text summary.
    """
    over_mismatched = paired_bootstrap(aligned, mismatched, rounds, seed)
    over_summary = paired_bootstrap(aligned, summary, rounds, seed)
    beats = over_mismatched[1] > 0
    at_least = over_summary[0] >= 0
    passed = beats and at_least
    return {"beatsMismatched": beats, "atLeastSummary": at_least,
            "clearlyBetterThanSummary": over_summary[1] > 0, "passed": passed,
            "needsRepeat": bool(passed and not primary and over_mismatched[1] < NEAR_ZERO),
            "minusMismatched": [round(value, 4) for value in over_mismatched],
            "minusSummary": [round(value, 4) for value in over_summary]}


def summarize(results, arms, rounds=10000, seed=0):
    """Aggregates of a run: per-arm means, and for every aligned arm its paired differences."""
    def column(arm, field):
        return [row[arm][field] for row in results]

    summary = {"items": len(results), "arms": {}, "differences": {}, "rule": {}}
    for arm in arms:
        entry = {"f1": round(mean(column(arm, "f1")), 4), "contains": round(mean(column(arm, "contains")), 4),
                 "words": round(mean(len(row[arm]["answer"].split()) for row in results), 1)}
        times = [row[arm]["ms"] for row in results if row[arm].get("ms") is not None]
        if times:
            entry["ms"] = round(mean(times), 1)
        hits = [row[arm]["hit"] for row in results if row[arm].get("hit") is not None]
        if hits:
            entry["nearestIsExpected"] = round(mean(hits), 4)
        summary["arms"][arm] = entry

    def difference(a, b):
        if a in arms and b in arms:
            value = paired_bootstrap(column(a, "f1"), column(b, "f1"), rounds, seed)
            summary["differences"][f"{a} - {b}"] = [round(x, 4) for x in value]

    for variant in VARIANTS + ("per-message",):
        difference(variant, f"{variant} mismatched")
        difference(variant, "t2t")
        difference(variant, "closed")
        if variant in arms and f"{variant} mismatched" in arms and "t2t" in arms:
            summary["rule"][variant] = pass_rule(column(variant, "f1"), column(f"{variant} mismatched", "f1"),
                                                 column("t2t", "f1"), rounds, seed, primary=variant == PRIMARY)
    difference(PRIMARY, f"{PRIMARY} zeroed")
    difference("per-message", "per-message, states swapped")
    difference("per-message", "tokens")
    difference("tokens", "t2t")
    difference("swat", PRIMARY)
    difference("swat", "t2t")
    difference("text", "t2t")
    return summary


def _interval(value):
    return f"{value[0]:+.3f} [{value[1]:+.3f}, {value[2]:+.3f}]"


def arms_table(report):
    lines = ["| Arm | F1 | Containment | Answer words | Mean ms |", "| --- | --- | --- | --- | --- |"]
    for arm, entry in report["summary"]["arms"].items():
        ms = f"{entry['ms']:,.0f}" if "ms" in entry else "–"
        lines.append(f"| `{arm}` | {entry['f1']:.3f} | {entry['contains']:.3f} | {entry['words']} | {ms} |")
    return "\n".join(lines)


def rule_table(report):
    lines = ["| Variant | minus mismatched | minus `t2t` | Beats mismatched | At least `t2t` | Result |",
             "| --- | --- | --- | --- | --- | --- |"]
    for variant, rule in report["summary"]["rule"].items():
        result = "needs a repeat" if rule["needsRepeat"] else ("**pass**" if rule["passed"] else "fail")
        lines.append(f"| `{variant}` | {_interval(rule['minusMismatched'])} | {_interval(rule['minusSummary'])} | "
                     f"{'yes' if rule['beatsMismatched'] else 'no'} | {'yes' if rule['atLeastSummary'] else 'no'} | "
                     f"{result} |")
    return "\n".join(lines)


def render(report):
    meta = report["meta"]
    parts = [f"#### {meta['sender']} to {meta['receiver']} ({report['summary']['items']} items, {meta['items']})",
             "", arms_table(report), "", rule_table(report), ""]
    extra = [f"`{name}` {_interval(value)}" for name, value in report["summary"]["differences"].items()
             if " mismatched" not in name and not name.endswith("- t2t")]
    if extra:
        parts += ["Other paired F1 differences: " + "; ".join(extra) + ".", ""]
    parts.append("Fit: " + json.dumps(meta.get("fit", {}), sort_keys=True))
    return "\n".join(parts)


def main(paths):
    for path in paths:
        with open(path, encoding="utf-8") as handle:
            print(render(json.load(handle)))
            print()


if __name__ == "__main__":
    main(sys.argv[1:])
