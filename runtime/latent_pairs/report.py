"""The L5 table: every trained pair against its controls, the verdict by the rule fixed
before the runs, and what each mapper cost. Standard library only.

    python -m latent_pairs.report --root ~/l5-mappers --compare ~/l5-mappers/compare \
        --repro ~/l5-mappers/compare-repro --out ~/l5-mappers/report

Reads latent_compare's phase files (the per-item results stay on the GPU machine) and the
training logs, and writes summary.json and report.md with aggregates only.
"""
import argparse
import json
import os

from latent_compare import report as harness_report
from latent_compare.models import MAPPERS, MODELS

from .evaluate import register
from .plan import BATCH, ordered_pairs, pair_name, trainable_pairs, untrainable
from .run import load_status

PASS_ARMS = ("mismatched", "zeroed")
BETTER, WORSE, SAME, UNMEASURED = "better", "worse", "no detectable difference", "not measured"


def word(interval):
    """How `swat` compares with another arm, from the paired 95% interval of the difference."""
    if not interval:
        return UNMEASURED
    if interval["low"] > 0:
        return BETTER
    if interval["high"] < 0:
        return WORSE
    return SAME


def verdict(pair, items):
    """The pass rule of docs/evals.md (L5), applied to one pair of latent_compare's latent section.

    Pass needs `swat`, `mismatched` and `zeroed` to have run on every main item without an
    error, and both paired intervals of the F1 difference above zero.
    """
    arms, intervals = pair["arms"], pair["intervals"]
    reasons = []
    for arm in ("swat",) + PASS_ARMS:
        ran = arms.get(arm, {})
        if ran.get("n") != items or ran.get("errors") or ran.get("missing"):
            reasons.append(f"`{arm}` ran on {ran.get('n', 0)} of {items} items")
    for arm in PASS_ARMS:
        interval = (intervals.get(f"swat-{arm}") or {}).get("f1")
        if not interval or interval["n"] != items:
            reasons.append(f"`swat − {arm}` has no interval over all {items} items")
        elif interval["low"] <= 0:
            reasons.append(f"`swat − {arm}` interval reaches zero ({interval['low']:+.3f})")
    return {
        "pass": not reasons, "reasons": reasons,
        "vsSummary": word((intervals.get("swat-t2t_m2b") or {}).get("f1")),
        "vsPassage": word((intervals.get("swat-text_m2b") or {}).get("f1")),
        "vsPassageHit": word((intervals.get("swat-text_m2b") or {}).get("hit")),
        "vsHarnessText": word((intervals.get("swat-harness_text") or {}).get("f1")),
    }


def read_log(folder):
    try:
        with open(os.path.join(folder, "log.jsonl"), encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]
    except FileNotFoundError:
        return []


def cost(rows, status=None):
    """What one mapper cost, from its training log: seconds per step in each stage, wall
    hours, peak GPU memory, and the best dev F1 with its step."""
    result = {}
    for stage in ("stage1", "stage2"):
        steps = [row for row in rows if row.get("event") == stage and "secPerStep" in row]
        if steps:
            result[f"{stage}SecPerStep"] = steps[-1]["secPerStep"]
            result[f"{stage}Steps"] = steps[-1]["step"]
    for key in ("peakAllocatedGiB", "peakReservedGiB"):
        peaks = [row[key] for row in rows if key in row]
        if peaks:
            result[key] = max(peaks)
    evals = [row for row in rows if row.get("event") == "stage2-eval" and row.get("step")]
    if evals:
        best = max(evals, key=lambda row: row["devF1"])
        result.update({"bestDevF1": best["devF1"], "bestStep": best["step"]})
    starts = [row for row in rows if row.get("event") == "start"]
    if starts:
        result["mapperParams"] = starts[-1].get("mapperParams")
        result["alignmentRule"] = starts[-1].get("alignmentRule")
    if status:
        if "trainSeconds" in status:
            result["trainHours"] = round(status["trainSeconds"] / 3600, 2)
        if "evalSeconds" in status:
            result["measureHours"] = round(status["evalSeconds"] / 3600, 2)
        result["smallBatches"] = bool(status.get("smallBatches"))
        result["fullSteps"] = bool(status.get("fullSteps"))
    return result


def estimate_hours(costs, stage1_steps, stage2_steps):
    """Hours for one more pair at the given step counts, from the measured pairs: the mean
    seconds per step of each stage plus the mean overhead (dev evaluations, loading, measuring)."""
    measured = [c for c in costs if "stage1SecPerStep" in c and "stage2SecPerStep" in c and "trainHours" in c]
    if not measured:
        return None
    total = 0.0
    for c in measured:
        stepping = (c["stage1SecPerStep"] * c["stage1Steps"] + c["stage2SecPerStep"] * c["stage2Steps"]) / 3600
        overhead = c["trainHours"] + c.get("measureHours", 0) - stepping
        total += (c["stage1SecPerStep"] * stage1_steps + c["stage2SecPerStep"] * stage2_steps) / 3600 + max(0.0, overhead)
    return round(total / len(measured), 1)


def latent_file(compare, sender, receiver):
    try:
        with open(os.path.join(compare, "latent", f"{pair_name(sender, receiver)}.json"), encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None


def section(compare, pairs):
    """latent_compare's latent section for the given pairs, read from one run folder.
    A pair is registered from its own file when the table does not have it yet."""
    with open(os.path.join(compare, "items.json"), encoding="utf-8") as handle:
        groups = json.load(handle)
    receive, latent = {}, {}
    for sender, receiver in pairs:
        data = latent_file(compare, sender, receiver)
        if not data:
            continue
        if (sender, receiver) not in MAPPERS or MAPPERS[(sender, receiver)]["id"] != data["checkpoint"]:
            register(sender, receiver, None, data["checkpoint"])
        latent[(sender, receiver)] = data
        target = os.path.join(compare, "receive", f"{receiver}.json")
        if receiver not in receive and os.path.exists(target):
            with open(target, encoding="utf-8") as handle:
                receive[receiver] = json.load(handle)
    return groups, harness_report.latent_section(groups, receive, latent), latent


def against_registered(groups, new, registered):
    """Paired `swat` F1 of a retrained mapper minus the registered one, on the same main items."""
    if not new or not registered:
        return None
    joined = [{"new": new["results"].get(item["id"], {}).get("swat"),
               "registered": registered["results"].get(item["id"], {}).get("swat")} for item in groups["main"]]
    return harness_report.paired(joined, "new", "registered")


def build(root, compare, repro=None, batch=None):
    """Everything the record needs, as one dict."""
    batch = list(batch or BATCH)
    first = batch[0]
    kept = dict(MAPPERS)   # section() registers pairs for its own reading; the table is put back
    try:
        groups, pairs, _ = section(compare, [pair for pair in batch if pair != first or not repro])
        summary = {"items": len(groups["main"]), "pairs": {}, "notTrained": {}, "batch": [list(pair) for pair in batch]}
        if repro:
            registered = latent_file(compare, *first)
            _, again, files = section(repro, [first])
            pairs.update(again)
            name = f"{first[0]}>{first[1]}"
            if name in again:
                summary["recipeCheck"] = {
                    "pair": name, "retrainedF1": again[name]["arms"]["swat"].get("f1"),
                    "registeredCheckpoint": registered["checkpoint"] if registered else None,
                    "retrainedMinusRegistered": against_registered(groups, files.get(first), registered)}
                check = summary["recipeCheck"]["retrainedMinusRegistered"]
                summary["recipeCheck"]["adequate"] = bool(check and check["low"] > -0.05)
    finally:
        MAPPERS.clear()
        MAPPERS.update(kept)
    for sender, receiver in batch:
        name, folder = f"{sender}>{receiver}", os.path.join(root, pair_name(sender, receiver))
        status = load_status(folder)
        entry = {"sender": MODELS[sender]["id"], "receiver": MODELS[receiver]["id"],
                 "state": status.get("state", "not started"), "reason": status.get("reason"),
                 "cost": cost(read_log(folder), status)}
        if name in pairs and "skipped" not in pairs[name]:
            entry.update({"checkpoint": pairs[name]["checkpoint"], "arms": pairs[name]["arms"],
                          "intervals": pairs[name]["intervals"], "edge": pairs[name]["edge"],
                          "verdict": verdict(pairs[name], summary["items"])})
        summary["pairs"][name] = entry
    done = [entry["cost"] for entry in summary["pairs"].values() if entry["state"] == "measured"]
    summary["estimateHoursPerPair"] = {"recipe": estimate_hours(done, 8000, 10000), "m2bS": estimate_hours(done, 15000, 20000)}
    in_batch = set(batch)
    summary["trainableNotInBatch"] = [f"{s}>{r}" for s, r in trainable_pairs() if (s, r) not in in_batch]
    for sender, receiver in ordered_pairs():
        reason = untrainable(sender, receiver)
        if reason:
            summary["notTrained"][f"{sender}>{receiver}"] = reason
    return summary


def num(value, digits=3):
    return "—" if value is None else f"{value:.{digits}f}"


def with_interval(arm):
    if not arm or arm.get("f1") is None:
        return "—"
    return f"{arm['f1']:.3f} [{arm['f1Low']:.3f}, {arm['f1High']:.3f}]"


def diff(interval):
    if not interval:
        return "—"
    return f"{interval['diff']:+.3f} [{interval['low']:+.3f}, {interval['high']:+.3f}]"


def table(header, rows):
    lines = ["| " + " | ".join(header) + " |", "| " + " | ".join("---" for _ in header) + " |"]
    lines += ["| " + " | ".join(str(cell) for cell in row) + " |" for row in rows]
    return "\n".join(lines)


def render(summary):
    """Markdown of the summary: F1 table, differences, verdicts, cost, and what was not trained."""
    measured = {name: entry for name, entry in summary["pairs"].items() if "arms" in entry}
    parts = [f"Main set: {summary['items']} SQuAD items. F1 with its bootstrap 95% interval."]
    parts.append(table(
        ["Pair", "`swat` (mapper)", "`mismatched`", "`zeroed`", "`t2t_m2b` (text summary)", "`text_m2b` (passage)"],
        [[name] + [with_interval(entry["arms"].get(arm)) for arm in ("swat", "mismatched", "zeroed", "t2t_m2b", "text_m2b")]
         for name, entry in measured.items()]))
    parts.append(table(
        ["Pair", "`swat − mismatched`", "`swat − zeroed`", "`swat − t2t_m2b`", "`swat − text_m2b`", "`swat − text` (harness)",
         "hit: `swat − text_m2b`"],
        [[name] + [diff((entry["intervals"].get(key) or {}).get(metric)) for key, metric in (
            ("swat-mismatched", "f1"), ("swat-zeroed", "f1"), ("swat-t2t_m2b", "f1"), ("swat-text_m2b", "f1"),
            ("swat-harness_text", "f1"), ("swat-text_m2b", "hit"))] for name, entry in measured.items()]))
    parts.append(table(
        ["Pair", "Carries the passage", "Against the text summary", "Against the passage (F1 / hit)", "Against harness `text`",
         "`swat` ms", "`t2t_m2b` ms"],
        [[name, "**Pass**" if entry["verdict"]["pass"] else "**Fail**: " + "; ".join(entry["verdict"]["reasons"]),
          entry["verdict"]["vsSummary"], f"{entry['verdict']['vsPassage']} / {entry['verdict']['vsPassageHit']}",
          entry["verdict"]["vsHarnessText"], num(entry["arms"]["swat"].get("ms"), 0), num(entry["arms"]["t2t_m2b"].get("ms"), 0)]
         for name, entry in measured.items()]))
    parts.append(table(
        ["Pair", "State", "Stage 1 s/step", "Stage 2 s/step", "Train h", "Measure h", "Peak GPU GiB (reserved / allocated)",
         "Best dev F1 (step)", "Batches"],
        [[name, entry["state"] + (f": {entry['reason']}" if entry.get("reason") else ""),
          num(entry["cost"].get("stage1SecPerStep")), num(entry["cost"].get("stage2SecPerStep")),
          num(entry["cost"].get("trainHours"), 2), num(entry["cost"].get("measureHours"), 2),
          f"{num(entry['cost'].get('peakReservedGiB'), 2)} / {num(entry['cost'].get('peakAllocatedGiB'), 2)}",
          f"{num(entry['cost'].get('bestDevF1'), 4)} ({entry['cost'].get('bestStep', '—')})",
          "2 and 1" if entry["cost"].get("smallBatches") else "4 and 2"] for name, entry in summary["pairs"].items()]))
    check = summary.get("recipeCheck")
    if check:
        parts.append(f"Recipe check on {check['pair']}: retrained `swat` F1 {num(check['retrainedF1'])}; retrained − registered "
                     f"({check['registeredCheckpoint']}) {diff(check['retrainedMinusRegistered'])}; "
                     f"{'adequate' if check['adequate'] else 'not adequate'} by the −0.05 rule.")
    estimate = summary["estimateHoursPerPair"]
    parts.append(f"Trainable here and not in the batch ({len(summary['trainableNotInBatch'])}): "
                 + ", ".join(summary["trainableNotInBatch"]) + f". Estimate per pair: {estimate['recipe']} h with this recipe, "
                 f"{estimate['m2bS']} h with the M2b-S step counts.")
    reasons = {}
    for name, reason in summary["notTrained"].items():
        reasons.setdefault(reason.split(" ", 1)[1] if " " in reason else reason, []).append(name)
    parts.append(f"Cannot be trained on this machine ({len(summary['notTrained'])} ordered pairs): "
                 + "; ".join(f"{len(names)} because a model {reason}" for reason, names in reasons.items()) + ".")
    return "\n\n".join(parts) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--root", required=True)
    parser.add_argument("--compare", required=True)
    parser.add_argument("--repro", help="run folder the retrained M2b-S pair was measured into")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = os.path.expanduser(args.out)
    os.makedirs(out, exist_ok=True)
    summary = build(os.path.expanduser(args.root), os.path.expanduser(args.compare),
                    os.path.expanduser(args.repro) if args.repro else None)
    with open(os.path.join(out, "summary.json"), "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=1)
    with open(os.path.join(out, "report.md"), "w", encoding="utf-8") as handle:
        handle.write(render(summary))
    print(render(summary))


if __name__ == "__main__":
    main()
