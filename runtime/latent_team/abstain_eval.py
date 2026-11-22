"""W3 evals 11 to 14 on the GPU (docs/evals.md, "W3").

    python -m latent_team.abstain_eval --part run --out ~/w3 --w1 ~/w1/out     # blocks 0-5 and fresh
    python -m latent_team.abstain_eval --part analyze --out ~/w3                # evals 11 to 13
    python -m latent_team.abstain_eval --part safety --out ~/w3 --safety <dir>  # eval 14

Pinned setting: W1's, with W1's watchdog, its threshold set (--w1 holds thresholds/ and the
block-2 reference). Blocks 0 to 2 of GSM8K test (seed 0) calibrate, blocks 3 to 5 are scored.

Written to --out on this machine only: per-question numbers (correct or not, scores, flags)
and the probe's features (hidden states of public GSM8K questions, never committed). No
question or answer text is written. --part analyze prints the aggregate numbers that go
into docs/evals.md and writes the committed calibration file when asked (--calibration-dir).
"""
import argparse
import json
import math
import os
import time

MODEL = "Qwen/Qwen2.5-3B-Instruct"
STEPS, TOKENS, BATCH, COUNT, SEED = 40, 512, 32, 200, 0
CALIBRATE, SCORE = (0, 1, 2), (3, 4, 5)
TARGET, DELTA = 0.10, 0.05
JOIN_MARGIN = 0.02
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


def row_scores(team, receipt_details):
    from .confidence import answer_logprob
    return [answer_logprob(d["pieces"], d["logprobs"]) for d in receipt_details]


def run_batch(team, guard, questions, thresholds, reference):
    """One batch: the watched team with token scores, the solver alone, and per-row numbers."""
    import torch
    from .guard import agreement
    from .watch_eval import flagged
    watch = guard.watch(questions, STEPS, TOKENS, thresholds=thresholds, reference=reference, keep_solver_state=True)
    answers, receipt = team.latent_mas(questions, steps=STEPS, max_new_tokens=TOKENS, watch=watch, scores=True)
    results = watch.finish(answers, receipt.generated_tokens, receipt.seconds)
    alone, alone_receipt = team.single(questions, max_new_tokens=TOKENS, scores=True)
    flags = flagged(results["raw"], thresholds)
    states = watch.solver_state.float().cpu() if watch.solver_state is not None else None
    rows = []
    for r in range(len(questions)):
        logprobs = receipt.details[r]["logprobs"]
        rows.append({"held": not all(v[r] for v in results["checks"].values()),
                     "flagged": bool(flags[r][0] or flags[r][1] or flags[r][2] >= 2),
                     "confidence": row_scores(team, receipt.details)[r],
                     "aloneConfidence": row_scores(team, alone_receipt.details)[r],
                     # exploratory scores, never used for the pass rule
                     "meanLogprob": sum(logprobs) / len(logprobs) if logprobs else None,
                     "minLogprob": min(logprobs) if logprobs else None,
                     "agree": agreement(answers[r], alone[r])})
    watch.drop()
    torch.cuda.empty_cache()
    return answers, alone, rows, states, receipt.seconds, alone_receipt.seconds


def part_run(args):
    import torch
    from .evaluate import correct, gsm8k, sample_block
    from .guard import Guard
    from .team import LatentTeam
    from .watch_eval import checked_reference
    from .watchdog import load_thresholds, team_weights
    items = gsm8k("test")
    team = LatentTeam(MODEL)
    warm = [item["question"] for item in items[:BATCH]]
    team.single(warm, max_new_tokens=8)
    team.latent_mas(warm, steps=2, max_new_tokens=8)
    thresholds = load_thresholds(MODEL, team_weights(team)[0], os.path.join(args.w1, "thresholds"))
    w1 = argparse.Namespace(out=args.w1)
    reference = checked_reference(w1, team, thresholds)
    guard = Guard(team, thresholds=thresholds, reference=reference)
    rows, features, seconds = [], [], {"team": 0.0, "alone": 0.0, "questions": 0}
    for block in CALIBRATE + SCORE:
        chunked = sample_block(items, COUNT, SEED, block)
        for chunk in batches(chunked):
            answers, alone, got, states, team_s, alone_s = run_batch(team, guard, [i["question"] for i in chunk],
                                                                      thresholds, reference)
            for item, answer, solo, row in zip(chunk, answers, alone, got):
                row.update(block=block, teamCorrect=correct(answer, item["gold"]),
                           aloneCorrect=correct(solo, item["gold"]))
                rows.append(row)
            features.append(states)
            seconds["team"] += team_s
            seconds["alone"] += alone_s
            seconds["questions"] += len(chunk)
        print(f"block {block}: {sum(r['teamCorrect'] for r in rows if r['block'] == block)}/{COUNT} team correct",
              flush=True)
    import sys
    sys.path.insert(0, os.path.join(REPO, "runtime"))
    from tests.grade import grade_slice
    fresh = fresh_items()
    fresh_rows, fresh_features = [], []
    for chunk in batches(fresh, 4):
        answers, alone, got, states, _, _ = run_batch(team, guard, [i["question"] for i in chunk], thresholds, reference)
        for item, answer, solo, row in zip(chunk, answers, alone, got):
            row.update(id=item["id"], teamCorrect=grade_slice(item["entry"], answer, [])["correct"],
                       aloneCorrect=grade_slice(item["entry"], solo, [])["correct"])
            fresh_rows.append(row)
        fresh_features.append(states)
    torch.save({"gsm8k": torch.cat(features), "fresh": torch.cat(fresh_features)}, os.path.join(args.out, "features.pt"))
    with open(os.path.join(args.out, "rows.json"), "w") as handle:
        json.dump({"gsm8k": rows, "fresh": fresh_rows, "seconds": seconds,
                   "weightsHash": team_weights(team)[0], "thresholdSet": thresholds["id"]}, handle)
    print("run done", json.dumps(seconds), flush=True)


def released_score(row):
    """(score, wrong) of a row by W1's table: held never releases; a flagged run releases the
    solver alone's fallback whatever its confidence; any other run releases on its score."""
    if row["held"]:
        return None, False
    if row["flagged"]:
        return math.inf, not row["aloneCorrect"]
    return row["confidence"], not row["teamCorrect"]


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


def probe(features, wrong, calibrate, score, extra_sets):
    """Eval 13. Standardized features, L2 by 5-fold CV inside the calibration rows."""
    import torch
    from .abstain import auroc
    x = features.double()
    mean, std = x[calibrate].mean(0), x[calibrate].std(0).clamp(min=1e-6)
    x = ((x - mean) / std).float()
    y = torch.tensor(wrong)
    folds = [calibrate[i::5] for i in range(5)]
    best, best_auc = None, -1.0
    for l2 in (1e-4, 1e-3, 1e-2, 1e-1, 1.0):
        oof = torch.zeros(len(wrong))
        for fold in folds:
            train = [i for i in calibrate if i not in set(fold)]
            w, b = fit_logistic(x[train], y[train], l2)
            oof[fold] = x[fold] @ w + b
        auc = auroc(oof[calibrate].tolist(), y[calibrate].tolist())
        if auc is not None and auc > best_auc:
            best, best_auc, best_oof = l2, auc, oof.clone()
    w, b = fit_logistic(x[calibrate], y[calibrate], best)
    logits = x @ w + b
    out = {"l2": best, "cvAuroc": round(best_auc, 4), "heldOutAuroc": round(auroc(logits[score].tolist(),
                                                                                   y[score].tolist()) or 0, 4)}
    for name, (fx, fy) in extra_sets.items():
        fx = ((fx.double() - mean) / std).float()
        value = auroc((fx @ w + b).tolist(), fy)
        out[f"{name}Auroc"] = None if value is None else round(value, 4)
    return out, best_oof, logits


def part_analyze(args):
    import torch
    from .abstain import auroc, choose_threshold, score_threshold
    with open(os.path.join(args.out, "rows.json")) as handle:
        data = json.load(handle)
    rows, fresh = data["gsm8k"], data["fresh"]
    calibrate = [i for i, r in enumerate(rows) if r["block"] in CALIBRATE]
    score = [i for i, r in enumerate(rows) if r["block"] in SCORE]
    pairs = [released_score(r) for r in rows]
    threshold, steps = choose_threshold([pairs[i][0] for i in calibrate], [pairs[i][1] for i in calibrate],
                                        TARGET, DELTA)
    result = score_threshold([pairs[i][0] for i in score], [pairs[i][1] for i in score], threshold, TARGET)
    released = [i for i in score if pairs[i][0] is not None and pairs[i][0] >= threshold]
    result["fallbacksReleased"] = sum(rows[i]["flagged"] and not rows[i]["held"] for i in released)
    result["held"] = sum(rows[i]["held"] for i in score)
    summary = {
        "threshold": threshold, "calibration": steps[-1] if steps else None,
        "eval11": result,
        "teamAccuracy": {"calibrate": sum(rows[i]["teamCorrect"] for i in calibrate) / len(calibrate),
                         "score": sum(rows[i]["teamCorrect"] for i in score) / len(score)},
        "aloneAccuracy": {"score": sum(rows[i]["aloneCorrect"] for i in score) / len(score)},
        "seconds": data["seconds"],
    }
    fresh_pairs = [released_score(r) for r in fresh]
    summary["eval12"] = score_threshold([p[0] for p in fresh_pairs], [p[1] for p in fresh_pairs], threshold, TARGET)
    summary["eval12"]["teamCorrect"] = sum(r["teamCorrect"] for r in fresh)

    features = torch.load(os.path.join(args.out, "features.pt"))
    wrong = [not r["teamCorrect"] for r in rows]
    low = -1e9   # an answer with no number has the lowest confidence
    confidence = [r["confidence"] if r["confidence"] is not None else low for r in rows]
    fresh_wrong = [not r["teamCorrect"] for r in fresh]
    probe_result, oof, logits = probe(features["gsm8k"], wrong, calibrate, score,
                                      {"fresh": (features["fresh"], fresh_wrong)})
    confidence_auroc = auroc([-confidence[i] for i in score], [wrong[i] for i in score])
    combined_x = torch.tensor([[c, 0.0] for c in confidence])
    combined_x[calibrate, 1] = oof[calibrate]   # out-of-fold probe logits for the calibration rows
    combined_x[score, 1] = logits[score].detach()
    clamped = combined_x.clone()
    clamped[:, 0] = clamped[:, 0].clamp(min=-50)
    w, b = fit_logistic(clamped[calibrate], torch.tensor(wrong)[calibrate], 1e-3)
    combined_auroc = auroc((clamped[score] @ w + b).tolist(), [wrong[i] for i in score])
    summary["eval13"] = dict(probe_result, confidenceHeldOutAuroc=round(confidence_auroc, 4),
                             combinedHeldOutAuroc=round(combined_auroc, 4),
                             joins=bool(combined_auroc - confidence_auroc >= JOIN_MARGIN))
    # Exploratory (never used for the pass rule): other scores' AUROC and calibration.
    exploratory = {}
    for name in ("meanLogprob", "minLogprob"):
        values = [r[name] if r[name] is not None else low for r in rows]
        alt = [(None, False) if r["held"] else (math.inf, not r["aloneCorrect"]) if r["flagged"]
               else (v, not r["teamCorrect"]) for r, v in zip(rows, values)]
        t, _ = choose_threshold([alt[i][0] for i in calibrate], [alt[i][1] for i in calibrate], TARGET, DELTA)
        exploratory[name] = {"heldOutAuroc": round(auroc([-values[i] for i in score], [wrong[i] for i in score]), 4),
                             "calibrated": score_threshold([alt[i][0] for i in score], [alt[i][1] for i in score], t,
                                                           TARGET)}
    agree = [1.0 if r["agree"] == "agree" else 0.0 for r in rows]
    exploratory["agreeWithSolverAlone"] = {"heldOutAuroc": round(auroc([-agree[i] for i in score],
                                                                       [wrong[i] for i in score]), 4)}
    summary["exploratory"] = exploratory
    print(json.dumps(summary, indent=1, default=str))
    with open(os.path.join(args.out, "summary.json"), "w") as handle:
        json.dump(summary, handle, indent=1, default=str)
    if args.calibration_dir:
        os.makedirs(args.calibration_dir, exist_ok=True)
        calibration = {
            "id": "w3-qwen2.5-3b-instruct-gsm8k-1", "task": "gsm8k-arithmetic", "model": MODEL,
            "weightsHash": data["weightsHash"], "thresholdSet": data["thresholdSet"], "steps": STEPS,
            "score": "answer-number-logprob", "threshold": threshold, "target": TARGET, "delta": DELTA,
            "measuredOn": {"split": "test", "seed": SEED, "calibrate": list(CALIBRATE), "score": list(SCORE),
                           "count": COUNT, "date": time.strftime("%Y-%m-%d")},
            "heldOut": {k: result[k] for k in ("released", "releasedShare", "errors", "error", "error95", "passed")},
            "about": ("W3 calibration (docs/watchdog-security.md): answers on this kind of task are released when "
                      "the log-probability of their final number reaches the threshold; chosen by fixed-sequence "
                      "testing on GSM8K test blocks 0-2 for a 10% error ceiling (one-sided 95% Clopper-Pearson), "
                      "scored on blocks 3-5. Void for any other weights or task."),
        }
        with open(os.path.join(args.calibration_dir, "qwen2.5-3b-instruct-gsm8k.json"), "w") as handle:
            json.dump(calibration, handle, indent=1)
            handle.write("\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--part", required=True, choices=("run", "analyze", "safety"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--w1", default=os.path.expanduser("~/w1/out"))
    parser.add_argument("--calibration-dir", default=None)
    parser.add_argument("--safety", default=None)
    args = parser.parse_args()
    args.out = os.path.expanduser(args.out)
    os.makedirs(args.out, exist_ok=True)
    {"run": part_run, "analyze": part_analyze}[args.part](args)


if __name__ == "__main__":
    main()
