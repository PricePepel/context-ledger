"""The L5 table: every trained pair against its controls, the verdict by the rule fixed
before the runs, and what each mapper cost. Standard library only.

    python -m latent_pairs.report --root ~/l5-mappers --compare ~/l5-mappers/compare \
        --repro ~/l5-mappers/compare-repro --out ~/l5-mappers/report

Reads latent_compare's phase files (the per-item results stay on the GPU machine) and the
training logs, and writes summary.json and report.md with aggregates only.

A pair gets a verdict only from the result the batch runner recorded for it: the pair is
`measured`, the result file is byte for byte the one written for its checkpoint file, and it
was made from L2's item set. Anything else is shown as not verified, with the reason.
"""
import argparse
import contextlib
import hashlib
import json
import os

from latent_compare import report as harness_report
from latent_compare import run as harness
from latent_compare.models import MAPPERS, MODELS

from .plan import BATCH, FULL_STEPS, ITEMS_ID, MAIN_ITEMS, RECIPE, ordered_pairs, pair_name, trainable_pairs, untrainable
from .run import load_json, load_status, read_log, result_path, sha256_file

CARD = "L5"
PASS_ARMS = ("mismatched", "zeroed")
BETTER, WORSE, SAME, UNMEASURED = "better", "worse", "no detectable difference", "not measured"
RECIPE_MARGIN = -0.05


def word(interval, items=None):
    """How `swat` compares with another arm, from the paired 95% interval of the difference.
    With `items`, an interval over fewer items is not a comparison of the set and says so."""
    if not interval:
        return UNMEASURED
    if items is not None and interval.get("n") != items:
        return f"{UNMEASURED} ({interval.get('n', 0)} of {items} items)"
    if interval["low"] > 0:
        return BETTER
    if interval["high"] < 0:
        return WORSE
    return SAME


def verdict(pair, items=MAIN_ITEMS):
    """The pass rule of docs/evals.md (L5), applied to one pair of latent_compare's latent section.

    Pass needs `swat`, `mismatched` and `zeroed` to have run on every main item without an
    error, and both paired intervals of the F1 difference above zero.
    """
    arms, intervals = pair["arms"], pair["intervals"]
    reasons = []
    if pair.get("items") != items:
        reasons.append(f"the main set has {pair.get('items')} items, not {items}")
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
        "vsSummary": word((intervals.get("swat-t2t_m2b") or {}).get("f1"), items),
        "vsPassage": word((intervals.get("swat-text_m2b") or {}).get("f1"), items),
        "vsPassageHit": word((intervals.get("swat-text_m2b") or {}).get("hit"), items),
        "vsHarnessText": word((intervals.get("swat-harness_text") or {}).get("f1"), items),
        "vsHarnessTextHit": word((intervals.get("swat-harness_text") or {}).get("hit"), items),
    }


def cost(rows, status=None):
    """What one mapper cost, from its training log: seconds per step in each stage, wall
    hours, peak GPU memory, and the dev F1 of the checkpoint that was kept.

    A log holds one part per start of the trainer. Stage 2 and the kept checkpoint are read
    from the last part only, so the score of a run that was cut off and started again is
    never credited to the checkpoint that replaced its own.
    """
    parts, result = [[]], {}
    for row in rows:
        if row.get("event") == "start":
            parts.append([])
        parts[-1].append(row)
    last = parts[-1]
    with_stage1 = [part for part in parts if any(row.get("event") == "stage1" and "secPerStep" in row for row in part)]
    for stage, part in (("stage1", with_stage1[-1] if with_stage1 else []), ("stage2", last)):
        steps = [row for row in part if row.get("event") == stage and "secPerStep" in row]
        if steps:
            result[f"{stage}SecPerStep"] = steps[-1]["secPerStep"]
            result[f"{stage}Steps"] = steps[-1]["step"]
    for key in ("peakAllocatedGiB", "peakReservedGiB", "calibrationPeakAllocatedGiB", "calibrationPeakReservedGiB"):
        peaks = [row[key] for part in (with_stage1[-1:] + [last]) for row in part if key in row]
        if peaks:
            result[key] = max(peaks)
    # What has to fit on the card: the larger of the calibration and the training peak.
    for kind in ("Allocated", "Reserved"):
        both = [result[key] for key in (f"peak{kind}GiB", f"calibrationPeak{kind}GiB") if key in result]
        if both:
            result[f"runPeak{kind}GiB"] = max(both)
    saved = [row for row in last if row.get("event") == "saved" and row.get("path") == "best.pt"]
    evals = {row["step"]: row for row in last if row.get("event") == "stage2-eval" and row.get("step")}
    if saved and "devF1" in saved[-1]:
        result["bestDevF1"] = saved[-1]["devF1"]
        result["bestCheckpoint"] = saved[-1].get("id")
        # The step the trainer wrote with the save. A log from before it did has only the
        # evaluations: the save follows its own evaluation, so that is the last one before it.
        before = [step for step, row in evals.items() if row["time"] <= saved[-1]["time"]]
        result["bestStep"] = saved[-1].get("step") or (max(before) if before else None)
    starts = [row for row in last if row.get("event") == "start"]
    if starts:
        result["mapperParams"] = starts[-1].get("mapperParams")
        result["alignmentRule"] = starts[-1].get("alignmentRule")
    result["trainerStarts"] = len(parts) - 1
    if status:
        if "trainSeconds" in status:
            result["trainHours"] = round(status["trainSeconds"] / 3600, 2)
        if "evalSeconds" in status:
            result["measureHours"] = round(status["evalSeconds"] / 3600, 2)
        result["smallBatches"] = bool(status.get("smallBatches"))
        result["fullSteps"] = bool(status.get("fullSteps"))
        result["interrupted"] = status.get("interrupted", 0)
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


@contextlib.contextmanager
def registered(entries):
    """latent_compare's table with some pairs' checkpoints put in, for the length of the block.
    The table is put back whatever happens inside."""
    kept = dict(MAPPERS)
    try:
        for (sender, receiver), checkpoint_id in entries.items():
            MAPPERS[(sender, receiver)] = {"checkpoint": None, "card": CARD, "id": checkpoint_id}
        yield
    finally:
        MAPPERS.clear()
        MAPPERS.update(kept)


def load_groups(compare, items_id=ITEMS_ID, main_items=MAIN_ITEMS):
    """A run folder's item sets, refused unless they are the pinned ones."""
    groups = load_json(os.path.join(compare, "items.json"))
    if not groups:
        raise ValueError(f"{compare} has no readable items.json")
    found = harness.fingerprint(groups)
    if found != items_id:
        raise ValueError(f"{compare} holds item set {found}, not L2's {items_id}")
    ids = [item["id"] for item in groups["main"]]
    if len(ids) != main_items or len(set(ids)) != main_items:
        raise ValueError(f"{compare} has {len(set(ids))} distinct main items, not {main_items}")
    return groups


def receive_of(compare, receiver, items_id):
    """A receiver's harness answers (its own template), when they are from the pinned item set."""
    data = load_json(os.path.join(compare, "receive", f"{receiver}.json"))
    return data if data and data.get("itemsId") == items_id else None


def measured_pair(root, compare, sender, receiver, items_id, not_checkpoint=None):
    """(result file, None) for a pair whose recorded measurement stands, else (None, reason).

    The bytes that are checked against the recorded digest are the bytes that are parsed.
    `not_checkpoint` is a checkpoint id the result must not be from: the registered M2b-S
    checkpoint is the baseline of the first pair, never its L5 row.
    """
    folder = os.path.join(root, pair_name(sender, receiver))
    status = load_status(folder)
    if status.get("state") != "measured":
        return None, None   # not a result yet; its state says why
    result, target, checkpoint = status.get("result") or {}, result_path(compare, sender, receiver), os.path.join(folder, "best.pt")
    mismatch = "the result file is not the one recorded for this pair's checkpoint"
    if result.get("path") != os.path.abspath(target) or result.get("itemsId") != items_id:
        return None, mismatch
    try:
        with open(target, "rb") as handle:
            raw = handle.read()
    except OSError:
        return None, mismatch
    if hashlib.sha256(raw).hexdigest() != result.get("sha256"):
        return None, mismatch
    if not os.path.exists(checkpoint) or sha256_file(checkpoint) != result.get("checkpointSha256"):
        return None, "best.pt is not the checkpoint file the result was made from"
    data = json.loads(raw.decode("utf-8"))
    if data.get("itemsId") != items_id:
        return None, f"the result is from item set {data.get('itemsId')}"
    if not_checkpoint is not None and data.get("checkpoint") == not_checkpoint:
        return None, f"the result is from the registered checkpoint {not_checkpoint}, which is the baseline, not a retrained mapper"
    return data, None


def hit_against_harness(groups, data, receive):
    """Paired hit rate of `swat` minus the receiver reading the passage in its own template."""
    answers = (receive or {}).get("results", {})
    joined = [{"swat": data["results"].get(item["id"], {}).get("swat"), "text": answers.get(item["id"], {}).get("text")}
              for item in groups["main"]]
    return harness_report.paired(joined, "swat", "text", "hit")


def pair_section(groups, compare, sender, receiver, data, items_id):
    """latent_compare's latent section for one verified result, with the hit-rate comparison
    against the harness `text` arm added."""
    receive = receive_of(compare, receiver, items_id)
    with registered({(sender, receiver): data["checkpoint"]}):
        section = harness_report.latent_section(groups, {receiver: receive} if receive else {},
                                                {(sender, receiver): data})[f"{sender}>{receiver}"]
    section["intervals"]["swat-harness_text"]["hit"] = hit_against_harness(groups, data, receive)
    return section


def recipe_check(root, compare, repro, first, registered_id, items_id=ITEMS_ID, main_items=MAIN_ITEMS):
    """The retrained first pair against the registered checkpoint, on the same items.
    Raises ValueError when either side is not a complete, verified result."""
    groups = load_groups(repro, items_id, main_items)
    load_groups(compare, items_id, main_items)
    if os.path.realpath(compare) == os.path.realpath(repro):
        raise ValueError("the compare and repro folders are the same folder")
    new, reason = measured_pair(root, repro, *first, items_id, not_checkpoint=registered_id)
    if not new:
        raise ValueError(f"the retrained {first[0]}>{first[1]} is not measured" + (f": {reason}" if reason else ""))
    baseline = result_path(compare, *first)
    old = load_json(baseline)
    if not old or old.get("itemsId") != items_id:
        raise ValueError("the registered checkpoint has no result from L2's item set in the compare folder")
    if old.get("checkpoint") != registered_id:
        raise ValueError(f"the compare folder's result is from checkpoint {old.get('checkpoint')}, not the registered {registered_id}")
    joined = [{"new": new["results"].get(item["id"], {}).get("swat"),
               "registered": old["results"].get(item["id"], {}).get("swat")} for item in groups["main"]]
    difference = harness_report.paired(joined, "new", "registered")
    if not difference or difference["n"] != main_items:
        raise ValueError(f"only {difference['n'] if difference else 0} of {main_items} items ran with both checkpoints")
    values = [record["new"]["f1"] for record in joined]
    recorded = load_status(os.path.join(root, pair_name(*first)))["result"]
    return {"pair": f"{first[0]}>{first[1]}", "registeredCheckpoint": registered_id, "retrainedCheckpoint": new["checkpoint"],
            # What the decision was made from: the runner keeps a saved decision only while these still hold.
            "itemsId": items_id, "registeredResultSha256": sha256_file(baseline),
            "retrainedResultSha256": recorded["sha256"], "retrainedCheckpointSha256": recorded["checkpointSha256"],
            "retrainedF1": round(sum(values) / len(values), 4), "retrainedMinusRegistered": difference,
            "margin": RECIPE_MARGIN, "adequate": difference["low"] > RECIPE_MARGIN}


def recipe_decision(root, compare, repro, batch=None, items_id=ITEMS_ID, main_items=MAIN_ITEMS):
    """What the batch runner needs before the second pair: the recipe check, and whether the
    rest of the batch uses the full M2b-S step counts. Raises ValueError when it cannot be made."""
    first = (batch or BATCH)[0]
    check = recipe_check(root, compare, repro, first, MAPPERS[first]["id"], items_id, main_items)
    return {**check, "fullSteps": not check["adequate"]}


def build(root, compare, repro, batch=None, items_id=ITEMS_ID, main_items=MAIN_ITEMS):
    """Everything the record needs, as one dict."""
    batch = list(batch or BATCH)
    first = batch[0]
    groups = load_groups(compare, items_id, main_items)
    summary = {"items": main_items, "itemsId": items_id, "pairs": {}, "notTrained": {}, "batch": [list(pair) for pair in batch]}
    try:
        summary["recipeCheck"] = recipe_check(root, compare, repro, first, MAPPERS[first]["id"], items_id, main_items)
    except ValueError as error:
        summary["recipeCheck"] = {"pair": f"{first[0]}>{first[1]}", "notMade": str(error)}
    summary["recipeDecision"] = load_json(os.path.join(root, "recipe.json"))
    for sender, receiver in batch:
        name, folder = f"{sender}>{receiver}", os.path.join(root, pair_name(sender, receiver))
        where = repro if (sender, receiver) == first else compare
        status = load_status(folder)
        entry = {"sender": MODELS[sender]["id"], "receiver": MODELS[receiver]["id"],
                 "state": status.get("state", "not started"), "reason": status.get("reason"),
                 "cost": cost(read_log(folder), status)}
        data, reason = measured_pair(root, where, sender, receiver, items_id,
                                     not_checkpoint=MAPPERS[first]["id"] if (sender, receiver) == first else None)
        if data:
            section = pair_section(groups, where, sender, receiver, data, items_id)
            entry.update({"checkpoint": section["checkpoint"], "arms": section["arms"], "intervals": section["intervals"],
                          "edge": section["edge"], "verdict": verdict(section, main_items)})
        elif reason:
            entry["notVerified"] = reason
        summary["pairs"][name] = entry
    done = [entry["cost"] for entry in summary["pairs"].values() if "arms" in entry]
    summary["estimateHoursPerPair"] = {
        "recipe": estimate_hours(done, RECIPE["stage1_steps"], RECIPE["stage2_steps"]),
        "m2bS": estimate_hours(done, FULL_STEPS["stage1_steps"], FULL_STEPS["stage2_steps"])}
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


def diff(interval, items=None):
    """A paired difference with its interval, and how many items it covers when not all."""
    if not interval:
        return "—"
    text = f"{interval['diff']:+.3f} [{interval['low']:+.3f}, {interval['high']:+.3f}]"
    return text if items is None or interval["n"] == items else f"{text} (n = {interval['n']})"


def table(header, rows):
    lines = ["| " + " | ".join(header) + " |", "| " + " | ".join("---" for _ in header) + " |"]
    lines += ["| " + " | ".join(str(cell) for cell in row) + " |" for row in rows]
    return "\n".join(lines)


def state_text(entry):
    text = entry["state"] + (f": {entry['reason']}" if entry.get("reason") else "")
    return text + (f" (not verified: {entry['notVerified']})" if entry.get("notVerified") else "")


def render(summary):
    """Markdown of the summary: F1 table, differences, verdicts, cost, and what was not trained."""
    items = summary["items"]
    measured = {name: entry for name, entry in summary["pairs"].items() if "arms" in entry}
    parts = [f"Main set: {items} SQuAD items (item set `{summary['itemsId']}`). F1 with its bootstrap 95% interval."]
    parts.append(table(
        ["Pair", "`swat` (mapper)", "`mismatched`", "`zeroed`", "`t2t_m2b` (text summary)", "`text_m2b` (passage)"],
        [[name] + [with_interval(entry["arms"].get(arm)) for arm in ("swat", "mismatched", "zeroed", "t2t_m2b", "text_m2b")]
         for name, entry in measured.items()]))
    parts.append("Paired differences with their 95% intervals (F1 unless the column says hit rate).")
    parts.append(table(
        ["Pair", "`swat − mismatched`", "`swat − zeroed`", "`swat − t2t_m2b`", "`swat − text_m2b`", "`swat − text` (harness)",
         "hit: `swat − text_m2b`", "hit: `swat − text` (harness)"],
        [[name] + [diff((entry["intervals"].get(key) or {}).get(metric), items) for key, metric in (
            ("swat-mismatched", "f1"), ("swat-zeroed", "f1"), ("swat-t2t_m2b", "f1"), ("swat-text_m2b", "f1"),
            ("swat-harness_text", "f1"), ("swat-text_m2b", "hit"), ("swat-harness_text", "hit"))]
         for name, entry in measured.items()]))
    parts.append(table(
        ["Pair", "Carries the passage", "Against the text summary", "Against the passage, `text_m2b` (F1 / hit)",
         "Against the passage, harness `text` (F1 / hit)", "`swat` ms", "`t2t_m2b` ms"],
        [[name, "**Pass**" if entry["verdict"]["pass"] else "**Fail**: " + "; ".join(entry["verdict"]["reasons"]),
          entry["verdict"]["vsSummary"], f"{entry['verdict']['vsPassage']} / {entry['verdict']['vsPassageHit']}",
          f"{entry['verdict']['vsHarnessText']} / {entry['verdict']['vsHarnessTextHit']}",
          num(entry["arms"]["swat"].get("ms"), 0), num(entry["arms"]["t2t_m2b"].get("ms"), 0)]
         for name, entry in measured.items()]))
    parts.append(table(
        ["Pair", "State", "Stage 1 s/step", "Stage 2 s/step", "Train h", "Measure h", "Peak GPU GiB (reserved / allocated)",
         "Kept checkpoint: dev F1 (step)", "Batches", "Steps"],
        [[name, state_text(entry),
          num(entry["cost"].get("stage1SecPerStep")), num(entry["cost"].get("stage2SecPerStep")),
          num(entry["cost"].get("trainHours"), 2), num(entry["cost"].get("measureHours"), 2),
          f"{num(entry['cost'].get('runPeakReservedGiB'), 2)} / {num(entry['cost'].get('runPeakAllocatedGiB'), 2)}",
          f"{num(entry['cost'].get('bestDevF1'), 4)} ({entry['cost'].get('bestStep') or '—'})",
          "2 and 1" if entry["cost"].get("smallBatches") else "4 and 2",
          "M2b-S" if entry["cost"].get("fullSteps") else "half"] for name, entry in summary["pairs"].items()]))
    check = summary["recipeCheck"]
    if "notMade" in check:
        parts.append(f"Recipe check on {check['pair']}: not made, {check['notMade']}.")
    else:
        parts.append(f"Recipe check on {check['pair']}: retrained `swat` F1 {num(check['retrainedF1'])} (checkpoint "
                     f"`{check['retrainedCheckpoint']}`); retrained − registered (`{check['registeredCheckpoint']}`) "
                     f"{diff(check['retrainedMinusRegistered'], items)}; "
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
    parser.add_argument("--repro", required=True, help="run folder the retrained M2b-S pair was measured into")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = os.path.expanduser(args.out)
    os.makedirs(out, exist_ok=True)
    summary = build(os.path.expanduser(args.root), os.path.expanduser(args.compare), os.path.expanduser(args.repro))
    with open(os.path.join(out, "summary.json"), "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=1)
    with open(os.path.join(out, "report.md"), "w", encoding="utf-8") as handle:
        handle.write(render(summary))
    print(render(summary))


if __name__ == "__main__":
    main()
