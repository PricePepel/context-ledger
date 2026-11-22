"""W1 evals 1 to 4 and 6 on the GPU (docs/evals.md, "W1").

    python -m latent_team.watch_eval --part reference --out ~/w1     # block 2: distance reference
    python -m latent_team.watch_eval --part thresholds --out ~/w1    # block 0: thresholds, eval 4
    python -m latent_team.watch_eval --part score --out ~/w1         # block 1: evals 1 to 4
    python -m latent_team.watch_eval --part cost --out ~/w1          # eval 6

Pinned setting: Qwen2.5-3B-Instruct in bf16, soft thoughts, no adapter, m = 40, GSM8K test,
seed 0, blocks of 200, batches of 32, greedy decoding with up to 512 solver tokens.

Everything written to --out stays on this machine: per-question numbers (correct or not, the
final number each system gave, scores, check results) and the reference statistics. No
question or answer text, thought record or cache is written anywhere. `--part thresholds` also writes the committed threshold set
(aggregate quantiles only) into latent_team/thresholds/.
"""
import argparse
import hashlib
import json
import math
import os
import statistics
import time

MODEL = "Qwen/Qwen2.5-3B-Instruct"
STEPS, TOKENS, BATCH, COUNT, SEED = 40, 512, 32, 200, 0
QUANTILES = (0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99, 0.995)
FAULT_QUESTIONS = 64
THRESHOLD_FILE = "qwen2.5-3b-instruct-soft-m40.json"


def quantile(values, q):
    values = sorted(values)
    position = q * (len(values) - 1)
    low = int(position)
    high = min(low + 1, len(values) - 1)
    return values[low] + (values[high] - values[low]) * (position - low)


def auroc(scores, labels):
    """P(score of a positive > score of a negative), ties counted half."""
    pos = [s for s, y in zip(scores, labels) if y]
    neg = [s for s, y in zip(scores, labels) if not y]
    if not pos or not neg:
        return None
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return round(wins / (len(pos) * len(neg)), 4)


def rate(flags):
    flags = list(flags)
    return round(sum(flags) / len(flags), 4) if flags else None


def load(args):
    from .evaluate import gsm8k, sample_block
    from .team import LatentTeam
    items = gsm8k("test")
    team = LatentTeam(MODEL)
    warm = [item["question"] for item in items[:BATCH]]
    team.single(warm, max_new_tokens=8)
    team.latent_mas(warm, steps=2, max_new_tokens=8)
    return team, lambda block: sample_block(items, COUNT, SEED, block)


def batches(items, size=BATCH):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def write(path, data):
    with open(path, "w") as handle:
        json.dump(data, handle, indent=1)
    print(f"wrote {path}", flush=True)


REFERENCE_SPLIT = {"model": MODEL, "block": 2, "seed": SEED, "steps": STEPS, "batch": BATCH, "mode": "soft"}


def check_reference_split(reference):
    """The reference must be the block-2 build of the pinned setting (block 0 sets thresholds,
    block 1 is scored)."""
    wrong = {k: reference.meta.get(k) for k, v in REFERENCE_SPLIT.items() if reference.meta.get(k) != v}
    if wrong:
        raise SystemExit(f"the reference was not built on the pinned split and setting: {wrong}")


def checked_reference(args, team, thresholds):
    """The reference the threshold set names: its bytes hashed and loaded once, and built on
    these weights. A run with no matching threshold set or reference refuses to start."""
    from .watchdog import Reference, team_weights
    if thresholds is None:
        raise SystemExit("no threshold set for these weights: run --part thresholds first")
    with open(os.path.join(args.out, "reference.pt"), "rb") as handle:
        blob = handle.read()
    if hashlib.sha256(blob).hexdigest() != thresholds["distance"]["reference"]:
        raise SystemExit("the reference file is not the one the threshold set names")
    measured = thresholds.get("measuredOn", {})
    if (measured.get("block"), measured.get("seed"), measured.get("count"), thresholds["distance"].get("referenceBlock")) \
            != (0, SEED, COUNT, 2):
        raise SystemExit("the threshold set was not fitted on the pinned split (block 0, reference block 2)")
    reference = Reference.from_bytes(blob, device=team.device, weights_hash=team_weights(team)[0])
    check_reference_split(reference)
    return reference


def flagged(raw, thresholds):
    """Per row: (degenerate flag, distance flag, weak signals) by the threshold set."""
    from .supervisor import WEAK_BUCKET
    from .watchdog import bucket
    out = []
    for row in range(len(raw["degenerate"])):
        flags, weak = [], 0
        for name in ("degenerate", "distance"):
            spec, value = thresholds.get(name), raw[name][row]
            if spec is None or value is None:
                flags.append(None)   # not measured: neither a catch nor a miss
                continue
            flags.append(value >= spec["flag"])
            weak += bucket(value, spec["edges"]) >= WEAK_BUCKET
        out.append((flags[0], flags[1], weak))
    return out


def catch(flags, which):
    """{rate, measured, unmeasured} of one score (0, 1) or of the supervisor's rule ("rule")
    over the rows where it was measured."""
    if which == "rule":
        values = [None if f[0] is None and f[1] is None else bool(f[0] or f[1] or f[2] >= 2) for f in flags]
    else:
        values = [f[which] for f in flags]
    measured = [v for v in values if v is not None]
    return {"rate": rate(measured), "measured": len(measured), "unmeasured": len(values) - len(measured)}


def clean_batch(team, guard, chunk, thresholds, reference, tolerance):
    """One clean batch with every audit. Per-row numbers only."""
    from .evaluate import correct, predicted_number
    from .guard import agreement
    questions = [item["question"] for item in chunk]
    watch = guard.watch(questions, STEPS, TOKENS, thresholds=thresholds, reference=reference, keep_memory=True)
    started = time.perf_counter()
    answers, receipt = team.latent_mas(questions, steps=STEPS, max_new_tokens=TOKENS, watch=watch)
    results = watch.finish(answers, receipt.generated_tokens, receipt.seconds)
    words, alone, measured = guard.audit(questions, STEPS, TOKENS, watch, answers, tolerance)
    rows = []
    for r, item in enumerate(chunk):
        team_n, alone_n = predicted_number(answers[r]), predicted_number(alone[r])
        other_n = predicted_number(measured["mismatchedAnswers"][r]) if "mismatchedAnswers" in measured else None
        rows.append({
            "checks": {k: v[r] for k, v in results["checks"].items()},
            "degenerate": results["raw"]["degenerate"][r], "distance": results["raw"]["distance"][r],
            "teamCorrect": correct(answers[r], item["gold"]), "aloneCorrect": correct(alone[r], item["gold"]),
            "agreement": agreement(answers[r], alone[r]), "teamNumber": team_n, "aloneNumber": alone_n,
            "mismatchedNumber": other_n, "mismatchedChanged": words[r]["mismatchedMemory"] == "changed",
            "replaySameAnswer": measured["sameAnswer"][r], "replaySameTopShare": measured["sameTopShare"][r],
            "replayMemoryDiff": measured["memoryDiff"][r], "replayMaskDiffers": measured["maskDiffers"][r],
            "replayClean": measured["replayClean"][r],
            "replayWord": words[r]["replay"],
            "legibilityError": float(watch.legibility_error[r]),
        })
    timing = {"teamSeconds": receipt.seconds, "replaySeconds": measured["replaySeconds"],
              "replayRows": measured["replayRows"], "mismatchedSeconds": measured.get("mismatchedSeconds"),
              "mismatchedRows": measured.get("mismatchedRows"), "aloneSeconds": measured["aloneSeconds"],
              "rows": len(chunk), "wall": time.perf_counter() - started}
    watch.drop()
    return rows, timing


def summarize_clean(rows, timings, thresholds=None):
    from .reports import EXACT_CHECKS
    n = len(rows)
    out = {"questions": n,
           "exactCheckFailures": {k: sum(not r["checks"][k] for r in rows) for k in EXACT_CHECKS},
           "anyExactFailure": sum(not all(r["checks"].values()) for r in rows),
           "maxLegibilityError": max(r["legibilityError"] for r in rows),
           "teamAccuracy": rate(r["teamCorrect"] for r in rows),
           "aloneAccuracy": rate(r["aloneCorrect"] for r in rows)}
    agree = [r for r in rows if r["agreement"] == "agree"]
    disagree = [r for r in rows if r["agreement"] == "disagree"]
    out["solverAlone"] = {
        "agree": len(agree), "disagree": len(disagree), "notComparable": n - len(agree) - len(disagree),
        "agreementRate": rate(r["agreement"] == "agree" for r in rows),
        # One definition everywhere (as Supervisor.stats): disagree / (agree + disagree).
        "squadChangedAnswerRate": rate(r["agreement"] == "disagree" for r in agree + disagree),
        "teamAccuracyWhenAgree": rate(r["teamCorrect"] for r in agree),
        "teamAccuracyWhenDisagree": rate(r["teamCorrect"] for r in disagree),
        "aloneAccuracyWhenDisagree": rate(r["aloneCorrect"] for r in disagree)}
    out["mismatchedMemory"] = {"answerChangedRate": rate(r["mismatchedChanged"] for r in rows),
                               "changed": sum(r["mismatchedChanged"] for r in rows)}
    diffs = [max(r["replayMemoryDiff"]) for r in rows]
    matched = [r for r in rows if r["replaySameAnswer"] and r["replaySameTopShare"] == 1 and not r["replayMaskDiffers"]]
    out["replay"] = {"diverged": len(rows) - len(matched),
                     "matchedMemoryDiffMax": max((max(r["replayMemoryDiff"]) for r in matched), default=None),"sameAnswerRate": rate(r["replaySameAnswer"] for r in rows),
                     "allTopTokensSameRate": rate(r["replaySameTopShare"] == 1 for r in rows),
                     "meanSameTopShare": round(statistics.mean(r["replaySameTopShare"] for r in rows), 6),
                     "memoryEqualAtSharedPositionsRate": rate(d == 0 for d in diffs),
                     "replayExactChecksCleanRate": rate(r["replayClean"] for r in rows),
                     "memoryDiffMax": max(diffs), "memoryDiffMedian": statistics.median(diffs),
                     "memoryDiffP99": quantile(diffs, 0.99),
                     "matchWordRate": rate(r["replayWord"] == "match" for r in rows)}
    if thresholds is not None:
        flags = flagged({"degenerate": [r["degenerate"] for r in rows], "distance": [r["distance"] for r in rows]},
                        thresholds)
        wrong = [not r["teamCorrect"] for r in rows]
        out["statistical"] = {
            "falseAlarm": {"degenerate": catch(flags, 0), "distance": catch(flags, 1),
                           "supervisorRule": catch(flags, "rule")},
            "aurocWrongAnswer": {name: auroc([r[name] for r in rows if r[name] is not None],
                                             [w for r, w in zip(rows, wrong) if r[name] is not None])
                                 for name in ("degenerate", "distance")},
            "wrongAnswers": sum(wrong)}
    out["secondsPerQuestion"] = {}
    for key, rows_key in (("teamSeconds", "rows"), ("replaySeconds", "replayRows"),
                          ("mismatchedSeconds", "mismatchedRows"), ("aloneSeconds", "rows")):
        audited = sum(t.get(rows_key) or 0 for t in timings if t.get(key) is not None)
        out["secondsPerQuestion"][key] = round(sum(t[key] for t in timings if t.get(key) is not None) / audited, 3) \
            if audited else None
    return out


def part_reference(args, team, block):
    from .team import chain_roles
    from .watchdog import ReferenceBuilder, Watch
    import torch
    from .watchdog import team_weights
    builder = ReferenceBuilder()
    started = time.perf_counter()
    torch.set_grad_enabled(False)   # chain() can train; here it must keep no autograd graph
    for chunk in batches(block(2)):
        questions = [item["question"] for item in chunk]
        watch = Watch(team, questions, steps=STEPS, max_new_tokens=TOKENS, collect=builder)
        watch.attach(team, roles=chain_roles(3), mode="soft", steps=STEPS, max_new_tokens=TOKENS)
        try:
            team.chain(questions, STEPS, "soft", watch=watch)
        finally:
            watch.detach()
        watch.drop()
    reference = builder.build(meta={"model": MODEL, "block": 2, "seed": SEED, "steps": STEPS, "batch": BATCH,
                                    "weightsHash": team_weights(team)[0], "mode": "soft"})
    path = os.path.join(args.out, "reference.pt")
    reference.save(path)
    with open(path, "rb") as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()
    write(os.path.join(args.out, "reference.json"), {"sha256": digest, "samples": reference.meta["samples"],
                                                      "seconds": round(time.perf_counter() - started, 1)})


def part_thresholds(args, team, block):
    from .guard import Guard
    from .watchdog import LEGIBILITY_TOLERANCE, MODE, TEMPERATURE, TOP_K, Reference, names_digest, team_weights
    with open(os.path.join(args.out, "reference.pt"), "rb") as handle:
        blob = handle.read()
    reference_digest = hashlib.sha256(blob).hexdigest()
    reference = Reference.from_bytes(blob, device=team.device, weights_hash=team_weights(team)[0])
    check_reference_split(reference)
    guard = Guard(team, thresholds=None)
    rows, timings = [], []
    for chunk in batches(block(0)):
        got, timing = clean_batch(team, guard, chunk, None, reference, tolerance=float("inf"))
        rows += got
        timings.append(timing)
    degenerate = [r["degenerate"] for r in rows]
    distance = [r["distance"] for r in rows]
    # The tolerance comes from the clean replays whose answer and top tokens matched: one
    # near-tie flip makes a run diverge, and its difference must not set the tolerance. How
    # often that happens is the divergence rate, reported on its own.
    matched = [max(r["replayMemoryDiff"]) for r in rows
               if r["replaySameAnswer"] and r["replaySameTopShare"] == 1 and not r["replayMaskDiffers"]
               and r["replayClean"] and all(math.isfinite(d) for d in r["replayMemoryDiff"])]
    weights, names = team_weights(team)[0], team_weights(team)[1]
    thresholds = {
        "id": "w1-qwen2.5-3b-instruct-soft-m40-1", "model": MODEL, "weightsHash": weights, "mode": MODE,
        "topK": TOP_K, "temperature": TEMPERATURE, "steps": STEPS, "legibilityTolerance": LEGIBILITY_TOLERANCE,
        "replayTolerance": max(matched) if matched else 0.0,
        "parameterNames": names_digest(names),
        "degenerate": {"edges": [quantile(degenerate, q) for q in QUANTILES], "flag": quantile(degenerate, 0.99)},
        "distance": {"edges": [quantile(distance, q) for q in QUANTILES], "flag": quantile(distance, 0.99),
                     "reference": reference_digest, "referenceBlock": 2},
        "measuredOn": {"split": "test", "seed": SEED, "block": 0, "count": COUNT, "batch": BATCH,
                       "date": time.strftime("%Y-%m-%d")},
        "about": ("W1 threshold set (docs/watchdog-security.md). Edges are the clean 50, 60, 70, 80, 90, 95, 98, 99 "
                  "and 99.5th percentiles of each score on GSM8K test block 0; flag is the 99th. replayTolerance is "
                  "the largest memory difference among block 0's clean replays whose answer and top tokens matched. "
                  "The distance reference statistics are "
                  "not committed; their SHA-256 is recorded. Any change of weights voids this file."),
    }
    os.makedirs(args.thresholds_dir, exist_ok=True)
    write(os.path.join(args.thresholds_dir, THRESHOLD_FILE), thresholds)
    write(os.path.join(args.out, "block0-rows.json"), rows)
    write(os.path.join(args.out, "block0-summary.json"), summarize_clean(rows, timings, thresholds))


def part_score(args, team, block):
    from .faults import FAULTS, NAMED, inject, swap_before_solver
    from .guard import Guard, memory_difference
    from .reports import EXACT_CHECKS
    from .watchdog import Reference, load_thresholds, team_weights
    thresholds = load_thresholds(MODEL, team_weights(team)[0], args.thresholds_dir)
    reference = checked_reference(args, team, thresholds)
    guard = Guard(team, thresholds=thresholds, reference=reference)
    items = block(1)
    rows, timings = [], []
    for chunk in batches(items):
        got, timing = clean_batch(team, guard, chunk, thresholds, reference, thresholds["replayTolerance"])
        rows += got
        timings.append(timing)
    write(os.path.join(args.out, "block1-rows.json"), rows)
    summary = {"clean": summarize_clean(rows, timings, thresholds), "faults": {}}
    write(os.path.join(args.out, "block1-summary.json"), summary)

    fault_items = items[:FAULT_QUESTIONS]
    for name in FAULTS:
        caught, named, failures, stat = 0, 0, {k: 0 for k in EXACT_CHECKS}, []
        seconds = 0.0
        for chunk in batches(fault_items):
            questions = [item["question"] for item in chunk]
            watch = guard.watch(questions, STEPS, TOKENS, thresholds=thresholds, reference=reference)
            mode, undo = inject(team, name)
            try:
                answers, receipt = team.latent_mas(questions, steps=STEPS, max_new_tokens=TOKENS, mode=mode,
                                                   watch=watch)
            finally:
                undo()
            results = watch.finish(answers, receipt.generated_tokens, receipt.seconds)
            seconds += receipt.seconds
            for r in range(len(chunk)):
                checks = {k: v[r] for k, v in results["checks"].items()}
                caught += not all(checks.values())
                named += not checks[NAMED[name]]
                for k in EXACT_CHECKS:
                    failures[k] += not checks[k]
            stat += flagged(results["raw"], thresholds)
            watch.drop()
        summary["faults"][name] = {
            "questions": len(fault_items), "caughtByAnExactCheck": caught, "namedCheck": NAMED[name],
            "caughtByTheNamedCheck": named, "failures": failures,
            "statisticalCatch": {"degenerate": catch(stat, 0), "distance": catch(stat, 1),
                                 "supervisorRule": catch(stat, "rule")},
            "secondsPerQuestion": round(seconds / len(fault_items), 3)}
        print(name, json.dumps(summary["faults"][name]), flush=True)
        write(os.path.join(args.out, "block1-summary.json"), summary)

    # Eval 3's fault: a cache swapped in just before the solver, the in-run checksum ignored.
    flagged_by_replay, unchanged_answer, checksum_saw, mask_differs, values_without_mask = 0, 0, 0, 0, 0
    for chunk in batches(fault_items):
        questions = [item["question"] for item in chunk]
        watch = guard.watch(questions, STEPS, TOKENS, keep_memory=True)
        undo = swap_before_solver(team)
        try:
            answers, receipt = team.latent_mas(questions, steps=STEPS, max_new_tokens=TOKENS, watch=watch)
        finally:
            undo()
        results = watch.finish(answers, receipt.generated_tokens, receipt.seconds)
        checksum_saw += sum(not v for v in results["checks"]["memoryChecksum"])
        again = guard.watch(questions, STEPS, TOKENS, keep_memory=True)
        replay, _ = team.latent_mas(questions, steps=STEPS, max_new_tokens=TOKENS, watch=again)
        diff, differs = memory_difference(watch.handoff, again.handoff, watch.plan.starts)
        for r in range(len(chunk)):
            # Counted on keys and values at positions both rows hold, not on the mask.
            seen = bool((diff[r] > thresholds["replayTolerance"]).any())
            flagged_by_replay += seen
            mask_differs += bool(differs[r])
            values_without_mask += seen and not bool(differs[r])
            unchanged_answer += seen and answers[r] == replay[r]
        watch.drop()
        again.drop()
    summary["swapBeforeSolver"] = {"questions": len(fault_items), "replayMemoryFlagged": flagged_by_replay,
                                   "flaggedWithTheAnswerUnchanged": unchanged_answer,
                                   "masksAlsoDiffer": mask_differs, "flaggedWithEqualMasks": values_without_mask,
                                   "inRunChecksumAlsoCaught": checksum_saw}
    write(os.path.join(args.out, "block1-summary.json"), summary)


def part_cost(args, team, block):
    import torch
    from .guard import Guard
    from .watchdog import Reference, load_thresholds, team_weights
    thresholds = load_thresholds(MODEL, team_weights(team)[0], args.thresholds_dir)
    reference = checked_reference(args, team, thresholds)
    guard = Guard(team, thresholds=thresholds, reference=reference)
    chunks = list(batches(block(1)[:2 * BATCH]))
    on, off = [], []
    for repeat in range(args.repeats):
        for watched in ((True, False) if repeat % 2 == 0 else (False, True)):
            total = 0.0
            for chunk in chunks:
                questions = [item["question"] for item in chunk]
                torch.cuda.synchronize()
                started = time.perf_counter()
                if watched:
                    watch = guard.watch(questions, STEPS, TOKENS, thresholds=thresholds, reference=reference)
                    answers, receipt = team.latent_mas(questions, steps=STEPS, max_new_tokens=TOKENS, watch=watch)
                    watch.finish(answers, receipt.generated_tokens, receipt.seconds)
                    watch.drop()
                else:
                    team.latent_mas(questions, steps=STEPS, max_new_tokens=TOKENS)
                torch.cuda.synchronize()
                total += time.perf_counter() - started
            (on if watched else off).append(total)
            print("watched" if watched else "plain", round(total, 3), flush=True)
    questions = sum(len(c) for c in chunks)
    result = {"questions": questions, "repeats": args.repeats, "watchedSeconds": on, "plainSeconds": off,
              "medianWatched": statistics.median(on), "medianPlain": statistics.median(off),
              "overhead": round(statistics.median(on) / statistics.median(off) - 1, 4),
              "watchedSecondsPerQuestion": round(statistics.median(on) / questions, 3),
              "plainSecondsPerQuestion": round(statistics.median(off) / questions, 3)}
    write(os.path.join(args.out, "cost.json"), result)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--part", required=True, choices=("reference", "thresholds", "score", "cost"))
    parser.add_argument("--out", required=True, help="a folder on this machine (not the repository)")
    parser.add_argument("--thresholds-dir", default=os.path.join(os.path.dirname(__file__), "thresholds"))
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args()
    args.out = os.path.expanduser(args.out)
    os.makedirs(args.out, exist_ok=True)
    team, block = load(args)
    {"reference": part_reference, "thresholds": part_thresholds, "score": part_score,
     "cost": part_cost}[args.part](args, team, block)


if __name__ == "__main__":
    main()
