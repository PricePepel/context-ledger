"""W3 evals 11 to 13 on the GPU (docs/evals.md, "W3").

    python -m latent_team.abstain_eval --part run --out ~/w3 --w1 ~/w1/out     # blocks 0-5, fresh, transfer, probe
    python -m latent_team.abstain_eval --part analyze --out ~/w3                # evals 11 to 13

Pinned setting: W1's, with W1's watchdog, its threshold set (--w1 holds thresholds/ and the
block-2 reference). GSM8K test (seed 0): block 0 proposes the candidate thresholds, blocks 1
and 2 certify them, blocks 3 to 5 are scored. Eval 14 (refusals) is not run here.

Every decision comes from the guarded path the service runs (Guard.run, W1's supervisor
table, sampled audits, the fallback and its checks), with a calibration that scores each
run without abstaining; the threshold is applied afterwards to exactly what that path
released. A sample of block 3 is also run one question at a time, as the service runs, to
measure whether batched decisions transfer to single requests.

Written to --out on this machine only: per-question numbers (decision, correct or not,
scores) and the probe's aggregate results. No question, answer, thought record, memory or
hidden state is written: the probe (eval 13) is fitted in memory at the end of the run.
--part analyze prints the aggregate numbers that go into docs/evals.md and writes the
committed calibration file only when the threshold is certified and passes eval 11.
"""
import argparse
import json
import math
import os
import time

MODEL = "Qwen/Qwen2.5-3B-Instruct"
TASK = "gsm8k-arithmetic"
STEPS, TOKENS, BATCH, COUNT, SEED = 40, 512, 32, 200, 0
PROPOSE, CERTIFY, SCORE = (0,), (1, 2), (3, 4, 5)
CALIBRATE = PROPOSE + CERTIFY
TRANSFER = 64           # the first questions of block 3, also run one at a time
TARGET, DELTA = 0.10, 0.05
JOIN_MARGIN = 0.02
PROBE_SCORE = {"threshold": -math.inf}   # score every run, abstain on none
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def batches(items, size=BATCH):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def fresh_items():
    """The fresh latent-read questions, each asked with its fixture codebase's files."""
    with open(os.path.join(REPO, "evals", "latent", "fresh.json"), encoding="utf-8") as handle:
        data = json.load(handle)
    root = os.path.join(REPO, "evals", "latent", data["fixture"])
    files = []
    for path in data["paths"]:
        with open(os.path.join(root, path), encoding="utf-8") as handle:
            files.append(f"File {path}:\n{handle.read()}")
    context = "\n\n".join(files)
    return [{"id": q["id"], "question": f"{context}\n\nQuestion about this codebase: {q['question']}", "entry": q}
            for q in data["questions"]]


def guarded(guard, questions):
    """The guarded path for a batch: (outcomes, per-row numbers, solver states)."""
    outcomes = guard.run(questions, steps=STEPS, max_new_tokens=TOKENS, calibration_override=PROBE_SCORE)
    rows, states = [], []
    for outcome in outcomes:
        action = outcome.decision["action"]
        rows.append({"action": action, "reason": outcome.decision["reason"],
                     "fallback": action == "release" and outcome.system == "single",
                     "confidence": outcome.confidence,
                     # exploratory scores, never used for the pass rule
                     "meanLogprob": outcome.extra.get("meanLogprob"),
                     "minLogprob": outcome.extra.get("minLogprob")})
        states.append(outcome.extra.get("solverState"))
    return outcomes, rows, states


def part_run(args):
    import torch
    from .evaluate import correct, gsm8k, sample_block
    from .guard import Guard, agreement
    from .team import LatentTeam
    from .watch_eval import checked_reference
    from .watchdog import load_thresholds, team_weights
    items = gsm8k("test")
    team = LatentTeam(MODEL)
    warm = [item["question"] for item in items[:BATCH]]
    team.single(warm, max_new_tokens=8)
    team.latent_mas(warm, steps=2, max_new_tokens=8)
    thresholds = load_thresholds(MODEL, team_weights(team)[0], os.path.join(args.w1, "thresholds"))
    reference = checked_reference(argparse.Namespace(out=args.w1), team, thresholds)
    guard = Guard(team, thresholds=thresholds, reference=reference, measure=True, keep_solver_state=True)
    rows, states, seconds = [], [], {"guarded": 0.0, "questions": 0}
    answers_by_index = {}
    for block in CALIBRATE + SCORE:
        chunked = sample_block(items, COUNT, SEED, block)
        for chunk in batches(chunked):
            questions = [i["question"] for i in chunk]
            started = time.perf_counter()
            outcomes, got, chunk_states = guarded(guard, questions)
            seconds["guarded"] += time.perf_counter() - started
            seconds["questions"] += len(chunk)
            alone, _ = team.single(questions, max_new_tokens=TOKENS)   # exploratory agreement only
            for item, outcome, solo, row, state in zip(chunk, outcomes, alone, got, chunk_states):
                released = outcome.answer if row["action"] == "release" else None
                row.update(block=block, releasedCorrect=released is not None and correct(released, item["gold"]),
                           teamAnswer=row["action"] == "release" and not row["fallback"],
                           aloneCorrect=correct(solo, item["gold"]),
                           agree=agreement(released, solo) if released is not None else None)
                if block == SCORE[0] and len([r for r in rows if r["block"] == block]) < TRANSFER:
                    answers_by_index[len(rows)] = released
                rows.append(row)
                states.append(state)
            torch.cuda.empty_cache()
        print(f"block {block}: {sum(r['releasedCorrect'] for r in rows if r['block'] == block)}/{COUNT} released "
              "and correct", flush=True)

    # Batch to single requests: the service runs one question at a time.
    transfer = []
    score_items = sample_block(items, COUNT, SEED, SCORE[0])
    first = min(answers_by_index)
    for offset, item in enumerate(score_items[:TRANSFER]):
        outcomes, got, _ = guarded(guard, [item["question"]])
        row, outcome = got[0], outcomes[0]
        released = outcome.answer if row["action"] == "release" else None
        transfer.append({"index": first + offset, "action": row["action"], "fallback": row["fallback"],
                         "confidence": row["confidence"],
                         "releasedCorrect": released is not None and correct(released, item["gold"]),
                         "sameAnswer": released == answers_by_index[first + offset]})
    print(f"transfer: {sum(t['sameAnswer'] for t in transfer)}/{len(transfer)} same answer", flush=True)

    import sys
    sys.path.insert(0, os.path.join(REPO, "runtime"))
    from tests.grade import grade_slice
    fresh_rows, fresh_states = [], []
    for chunk in batches(fresh_items(), 4):
        outcomes, got, chunk_states = guarded(guard, [i["question"] for i in chunk])
        for item, outcome, row, state in zip(chunk, outcomes, got, chunk_states):
            released = outcome.answer if row["action"] == "release" else None
            row.update(id=item["id"], teamAnswer=row["action"] == "release" and not row["fallback"],
                       releasedCorrect=released is not None and grade_slice(item["entry"], {"answer": released})["correct"])
            fresh_rows.append(row)
            fresh_states.append(state)

    # Eval 13, in memory: no hidden state is written.
    probe_result = run_probe(rows, states, fresh_rows, fresh_states)
    del states, fresh_states
    with open(os.path.join(args.out, "rows.json"), "w") as handle:
        json.dump({"gsm8k": rows, "fresh": fresh_rows, "transfer": transfer, "probe": probe_result,
                   "seconds": seconds, "weightsHash": team_weights(team)[0], "thresholdSet": thresholds["id"],
                   "reference": reference is not None}, handle)
    print("run done", json.dumps(seconds), flush=True)


def released_score(row):
    """(score, wrong) of what the guarded path released: a hold releases nothing; a fallback
    is released whatever its confidence (math.inf); a team answer is released on its score
    (None: no score, never released)."""
    if row["action"] != "release":
        return None, False
    if row["fallback"]:
        return math.inf, not row["releasedCorrect"]
    return row["confidence"], not row["releasedCorrect"]


def fit_logistic(x, y, l2, steps=300):
    import torch
    weights = torch.zeros(x.shape[1], requires_grad=True)
    bias = torch.zeros(1, requires_grad=True)
    optimizer = torch.optim.LBFGS([weights, bias], max_iter=steps, line_search_fn="strong_wolfe")
    target = y.float()

    def closure():
        optimizer.zero_grad()
        loss = torch.nn.functional.binary_cross_entropy_with_logits(x @ weights + bias, target) + \
            l2 * (weights ** 2).sum()
        loss.backward()
        return loss

    optimizer.step(closure)
    return weights.detach(), bias.detach()


def _standardized(x, rows):
    mean, std = x[rows].mean(0), x[rows].std(0).clamp(min=1e-6)
    return lambda z: ((z.double() - mean) / std).float()


def _fit(x, y, rows, l2):
    scale = _standardized(x, rows)
    w, b = fit_logistic(scale(x[rows]), y[rows], l2)
    return lambda z: scale(z) @ w + b


def run_probe(rows, states, fresh_rows, fresh_states):
    """Eval 13: a logistic probe on the solver's prompt-end hidden state for a wrong team
    answer, its L2 strength by 5-fold cross-validation inside blocks 0 to 2, each fold
    standardized on its own training rows. Only rows whose released answer is the team's
    enter (a held or fallback run has no team answer to label). Reported on blocks 3 to 5 and
    the fresh set for the probe alone, the confidence score alone and both combined. Never
    deployed: a combined score chosen here would need its own certification."""
    import torch
    from .abstain import auroc
    usable = [i for i, r in enumerate(rows) if r["teamAnswer"] and states[i] is not None]
    if not usable:
        return {"rows": 0}
    x = torch.stack([states[i] for i in usable]).double()
    y = torch.tensor([not rows[i]["releasedCorrect"] for i in usable])
    blocks = [rows[i]["block"] for i in usable]
    calibrate = [k for k, b in enumerate(blocks) if b in CALIBRATE]
    score = [k for k, b in enumerate(blocks) if b in SCORE]
    folds = [calibrate[f::5] for f in range(5)]
    best, best_auc, best_oof = None, -1.0, None
    for l2 in (1e-4, 1e-3, 1e-2, 1e-1, 1.0):
        oof = torch.zeros(len(usable))
        for fold in folds:
            held = set(fold)
            predict = _fit(x, y, [k for k in calibrate if k not in held], l2)
            oof[fold] = predict(x[fold])
        value = auroc(oof[calibrate].tolist(), y[calibrate].tolist())
        if value is not None and value > best_auc:
            best, best_auc, best_oof = l2, value, oof.clone()
    probe = _fit(x, y, calibrate, best)
    logits = probe(x)
    logits[calibrate] = best_oof[calibrate]   # out of fold for the rows the probe was fitted on
    low = -50.0   # an answer with no score has the lowest confidence
    confidence = torch.tensor([max(low, rows[i]["confidence"]) if rows[i]["confidence"] is not None else low
                               for i in usable])
    pair = torch.stack([confidence, logits.detach()], dim=1)
    combine = _fit(pair, y, calibrate, 1e-3)

    def report(label_rows, conf, logit, labels):
        both = combine(torch.stack([conf, logit], dim=1)).tolist()
        values = {"probe": auroc(logit.tolist(), labels), "confidence": auroc((-conf).tolist(), labels),
                  "combined": auroc(both, labels)}
        return {k: None if v is None else round(v, 4) for k, v in values.items()} | {"rows": label_rows}

    held_out = report(len(score), confidence[score], logits[score].detach(), y[score].tolist())
    out = {"rows": len(usable), "l2": best, "cvAuroc": round(best_auc, 4), "heldOut": held_out}
    fresh_usable = [i for i, r in enumerate(fresh_rows) if r["teamAnswer"] and fresh_states[i] is not None]
    if fresh_usable:
        fx = torch.stack([fresh_states[i] for i in fresh_usable]).double()
        fconf = torch.tensor([max(low, fresh_rows[i]["confidence"]) if fresh_rows[i]["confidence"] is not None
                              else low for i in fresh_usable])
        out["fresh"] = report(len(fresh_usable), fconf, probe(fx).detach(),
                              [not fresh_rows[i]["releasedCorrect"] for i in fresh_usable])
    gain = (held_out["combined"] or 0) - (held_out["confidence"] or 0)
    out["joins"] = bool(gain >= JOIN_MARGIN)   # reported; never deployed without its own certification
    return out


def decide(score, threshold):
    """What the service does with a released-path score under a threshold."""
    if score is None:
        return "not-released"
    return "released" if score == math.inf or (threshold is not None and score >= threshold) else "abstained"


def part_analyze(args):
    from .abstain import auroc, choose_threshold, score_threshold
    with open(os.path.join(args.out, "rows.json")) as handle:
        data = json.load(handle)
    rows, fresh = data["gsm8k"], data["fresh"]
    index = {name: [i for i, r in enumerate(rows) if r["block"] in blocks]
             for name, blocks in (("propose", PROPOSE), ("certify", CERTIFY), ("score", SCORE))}
    pairs = [released_score(r) for r in rows]
    threshold, steps, chosen = choose_threshold([pairs[i][0] for i in index["propose"]],
                                                [pairs[i][0] for i in index["certify"]],
                                                [pairs[i][1] for i in index["certify"]], TARGET, DELTA)
    result = score_threshold([pairs[i][0] for i in index["score"]], [pairs[i][1] for i in index["score"]],
                             threshold, TARGET)
    score_rows = [rows[i] for i in index["score"]]
    result["held"] = sum(r["action"] == "hold" for r in score_rows)
    result["fallbacksReleased"] = sum(r["fallback"] for r in score_rows)
    result["abstained"] = sum(decide(pairs[i][0], threshold) == "abstained" or
                              (rows[i]["action"] == "release" and pairs[i][0] is None) for i in index["score"])
    summary = {
        "threshold": threshold, "certification": chosen, "candidates": len(steps), "eval11": result,
        "releasedAccuracyBeforeThreshold": {
            name: round(sum(rows[i]["releasedCorrect"] for i in idx) / len(idx), 4) for name, idx in index.items()},
        "aloneAccuracy": {"score": round(sum(r["aloneCorrect"] for r in score_rows) / len(score_rows), 4)},
        "decisions": {"score": {word: sum(r["action"] == word for r in score_rows) for word in ("release", "hold")}},
        "seconds": data["seconds"],
    }
    fresh_pairs = [released_score(r) for r in fresh]
    summary["eval12"] = score_threshold([p[0] for p in fresh_pairs], [p[1] for p in fresh_pairs], threshold, TARGET)
    # Batch to single requests (the service's shape), on the first questions of block 3.
    transfer = data["transfer"]
    same = sum(decide(released_score(t)[0], threshold) == decide(pairs[t["index"]][0], threshold) for t in transfer)
    summary["transfer"] = {"questions": len(transfer), "sameAnswer": sum(t["sameAnswer"] for t in transfer),
                           "sameDecision": same,
                           "singleReleasedWrong": sum(decide(released_score(t)[0], threshold) == "released" and
                                                      not t["releasedCorrect"] for t in transfer),
                           "singleReleased": sum(decide(released_score(t)[0], threshold) == "released"
                                                 for t in transfer)}
    summary["eval13"] = data["probe"]
    # Exploratory (never used for the pass rule): other scores, with the same procedure.
    exploratory = {}
    team_score = [i for i in index["score"] if rows[i]["teamAnswer"]]
    for name in ("meanLogprob", "minLogprob"):
        alt = [(None, False) if r["action"] != "release" else (math.inf, not r["releasedCorrect"]) if r["fallback"]
               else (r[name], not r["releasedCorrect"]) for r in rows]
        t, _, _ = choose_threshold([alt[i][0] for i in index["propose"]], [alt[i][0] for i in index["certify"]],
                                   [alt[i][1] for i in index["certify"]], TARGET, DELTA)
        value = auroc([-(rows[i][name] if rows[i][name] is not None else -1e9) for i in team_score],
                      [not rows[i]["releasedCorrect"] for i in team_score])
        exploratory[name] = {"heldOutAuroc": None if value is None else round(value, 4),
                             "calibrated": score_threshold([alt[i][0] for i in index["score"]],
                                                           [alt[i][1] for i in index["score"]], t, TARGET)}
    value = auroc([0.0 if rows[i]["agree"] == "agree" else 1.0 for i in team_score],
                  [not rows[i]["releasedCorrect"] for i in team_score])
    exploratory["agreeWithSolverAlone"] = {"heldOutAuroc": None if value is None else round(value, 4)}
    confidence_auroc = auroc([-(rows[i]["confidence"] if rows[i]["confidence"] is not None else -1e9)
                              for i in team_score], [not rows[i]["releasedCorrect"] for i in team_score])
    exploratory["confidenceHeldOutAuroc"] = None if confidence_auroc is None else round(confidence_auroc, 4)
    summary["exploratory"] = exploratory
    print(json.dumps(summary, indent=1, default=str))
    with open(os.path.join(args.out, "summary.json"), "w") as handle:
        json.dump(summary, handle, indent=1, default=str)
    if args.calibration_dir and result["passed"]:
        os.makedirs(args.calibration_dir, exist_ok=True)
        calibration = {
            "id": "w3-qwen2.5-3b-instruct-gsm8k-1", "task": TASK, "model": MODEL,
            "weightsHash": data["weightsHash"], "thresholdSet": data["thresholdSet"], "reference": data["reference"],
            "steps": STEPS, "maxNewTokens": TOKENS, "score": "answer-number-logprob",
            "threshold": threshold, "target": TARGET, "delta": DELTA, "certified": True,
            "measuredOn": {"split": "test", "seed": SEED, "propose": list(PROPOSE), "certify": list(CERTIFY),
                           "score": list(SCORE), "count": COUNT, "batch": BATCH, "date": time.strftime("%Y-%m-%d")},
            "certification": chosen,
            "heldOut": {k: result[k] for k in ("questions", "released", "releasedShare", "errors", "error", "error95",
                                               "passed")},
            "transfer": summary["transfer"],
            "about": ("W3 calibration (docs/watchdog-security.md): on this kind of task an answer from the guarded path "
                      "is released when the log-probability of its graded number reaches the threshold (a fallback "
                      "answer is released, a held run is not). Candidates were fixed from the scores of GSM8K test "
                      "block 0, tested on blocks 1 and 2 at 0.05 / 20 each (Bonferroni over the grid, one-sided "
                      "Clopper-Pearson) for a 10% error ceiling, and the threshold was scored on blocks 3 to 5. Void "
                      "for any other weights, task or setting."),
        }
        with open(os.path.join(args.calibration_dir, "qwen2.5-3b-instruct-gsm8k.json"), "w") as handle:
            json.dump(calibration, handle, indent=1)
            handle.write("\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--part", required=True, choices=("run", "analyze"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--w1", default=os.path.expanduser("~/w1/out"))
    parser.add_argument("--calibration-dir", default=None)
    args = parser.parse_args()
    args.out = os.path.expanduser(args.out)
    os.makedirs(args.out, exist_ok=True)
    {"run": part_run, "analyze": part_analyze}[args.part](args)


if __name__ == "__main__":
    main()
