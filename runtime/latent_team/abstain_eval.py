"""W3 evals 11 to 13 on the GPU (docs/evals.md, "W3").

    python -m latent_team.abstain_eval --part run --out ~/w3 --w1 ~/w1/out        # batched (exploratory)
    python -m latent_team.abstain_eval --part certify --out ~/w3 --shard 0 --shards 2   # single requests
    python -m latent_team.abstain_eval --part analyze --out ~/w3                   # evals 11 to 13

Pinned setting: W1's, with W1's watchdog, its committed threshold set and the block-2
reference. GSM8K test, seed 0, blocks of 200.

The claim is about the service as users call it, so it is certified and scored on single
requests through TeamService itself (the gateway in front, W1's guard and supervisor, the
sampled audits, the fallback, the deadline and the output gate), graded on the text the
service returns; every request is its own guarded call, so no two decisions share a batch
or an audit (review W3-2). Rows used to fit W1's policy are never certified or scored on:
W1's thresholds come from block 0 and its distance reference from block 2, so blocks 0 and
2 only propose the candidate thresholds (from the batched run's scores), blocks 1 and 3
certify them, and blocks 4 and 5 and the 119 questions after block 5 are scored.

The batched run (--part run) is exploratory: it gives the proposal scores, the probe of
eval 13 and how batched decisions compare with single ones. Eval 14 (refusals) is not run
here.

Written to --out on this machine only: per-question numbers (decision, correct or not,
scores, seconds) and the probe's aggregate results. No question, answer, thought record,
memory or hidden state is written: the probe is fitted in memory at the end of its run.
--part analyze prints the aggregate numbers that go into docs/evals.md and writes the
committed calibration file only when the threshold is certified and passes eval 11.
"""
import argparse
import json
import math
import os
import re
import time

MODEL = "Qwen/Qwen2.5-3B-Instruct"
TASK = "gsm8k-arithmetic"
STEPS, TOKENS, BATCH, COUNT, SEED = 40, 512, 32, 200, 0
BATCH_BLOCKS = (0, 1, 2, 3, 4, 5)       # the batched, exploratory run
PROPOSE = (0, 2)                       # candidates only: W1 fitted its thresholds and reference here
CERTIFY = (1, 3)
SCORE = (4, 5, 6)                      # 6: the 119 questions after block 5
FITTED_BY_W1 = (0, 2)
PROBE_TRAIN, PROBE_TEST = (0, 1, 2), (3, 4, 5)
TRANSFER_BLOCK, TRANSFER = 3, 64       # batched questions also run one at a time in the batched run
TARGET, DELTA, GRID = 0.10, 0.05, 20
JOIN_MARGIN = 0.02
PROBE_SCORE = {"threshold": -math.inf}   # score every run, abstain on none
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


GSM8K_TEST = 1319


def dataset_identity(items):
    """The one cached GSM8K snapshot, and a fingerprint of its ordered test questions; stops
    the run unless there is exactly one snapshot with 1319 distinct questions, so no question
    can enter two splits (review W3-3)."""
    import glob
    import hashlib
    from .evaluate import HUB
    snapshots = sorted(glob.glob(os.path.join(HUB, "datasets--openai--gsm8k", "snapshots", "*")))
    questions = [item["question"] for item in items]
    if len(snapshots) != 1 or len(questions) != GSM8K_TEST or len(set(questions)) != GSM8K_TEST:
        raise SystemExit(f"GSM8K test must be one snapshot of {GSM8K_TEST} distinct questions: "
                         f"{len(snapshots)} snapshots, {len(questions)} rows, {len(set(questions))} distinct")
    return {"revision": os.path.basename(snapshots[0]),
            "fingerprint": hashlib.sha256("\n".join(questions).encode("utf-8")).hexdigest()}


def block_items(items, block):
    """A block of the seed-0 shuffle; block 6 is the remainder after block 5."""
    from .evaluate import sample_block
    if block < 6:
        return sample_block(items, COUNT, SEED, block)
    import random
    shuffled = list(items)
    random.Random(SEED).shuffle(shuffled)
    return shuffled[6 * COUNT:]


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
    """The batched run (exploratory since review W3-2): proposal scores, the probe, the
    batched decisions and their transfer to single requests."""
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
    for block in BATCH_BLOCKS:
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
                if block == TRANSFER_BLOCK and len([r for r in rows if r["block"] == block]) < TRANSFER:
                    answers_by_index[len(rows)] = released
                rows.append(row)
                states.append(state)
            torch.cuda.empty_cache()
        print(f"block {block}: {sum(r['releasedCorrect'] for r in rows if r['block'] == block)}/{COUNT} released "
              "and correct", flush=True)

    # Batch to single requests: the service runs one question at a time.
    transfer = []
    score_items = sample_block(items, COUNT, SEED, TRANSFER_BLOCK)
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


def part_certify(args):
    """Single requests through TeamService, on the certification and scoring blocks and the
    fresh set: what the service returns, graded. --shard k of --shards n takes every n-th
    question, so shards can share the GPU."""
    import sys
    from .evaluate import correct, gsm8k
    from .team import LatentTeam
    from .watchdog import load_thresholds, team_weights
    os.environ["LATENT_WATCH_REFERENCE"] = os.path.join(args.w1, "reference.pt")
    sys.path.insert(0, os.path.join(REPO, "runtime"))
    from latent_pool import ApiError
    from latent_pool.team_service import TeamService
    from tests.grade import grade_slice
    items = gsm8k("test")
    dataset = dataset_identity(items)
    team = LatentTeam(MODEL)
    warm = [item["question"] for item in items[:4]]
    team.single(warm, max_new_tokens=8)
    team.latent_mas(warm, steps=2, max_new_tokens=8)
    thresholds = load_thresholds(MODEL, team_weights(team)[0])   # the committed set, as the service loads it
    fitted = {thresholds["measuredOn"]["block"], thresholds["distance"]["referenceBlock"]}
    if fitted != set(FITTED_BY_W1) or fitted & set(CERTIFY + SCORE):
        raise SystemExit(f"W1 fitted blocks {sorted(fitted)}: they may not certify or score")
    service = TeamService(team, steps=STEPS)
    if service.guard.reference is None:
        raise SystemExit("the distance reference did not load: the service would run unscreened")
    # Score every request without abstaining: the threshold is applied afterwards.
    service.guard.calibration = lambda task, *rest, **kw: PROBE_SCORE if task else None
    work = [("gsm8k", block, position, item) for block in CERTIFY + SCORE
            for position, item in enumerate(block_items(items, block))]
    work += [("fresh", None, position, item) for position, item in enumerate(fresh_items())]
    rows = []
    for number, (kind, block, position, item) in enumerate(work):
        if number % args.shards != args.shard:
            continue
        started = time.perf_counter()
        try:
            answer, outcome, _ = service.run(item["question"], STEPS, TOKENS, task=TASK)
            action, reason = outcome.decision["action"], outcome.decision["reason"]
            fallback, confidence = action == "release" and outcome.system == "single", outcome.confidence
        except ApiError as error:   # a hold leaves as an error, with its reason in parentheses
            named = re.search(r"\(([A-Za-z-]{1,40})\)", str(error))
            answer, action, reason, fallback, confidence = None, "hold", named.group(1) if named else "error", False, None
        seconds = time.perf_counter() - started
        released = answer if action == "release" else None
        if kind == "gsm8k":
            good = released is not None and correct(released, item["gold"])
        else:
            good = released is not None and grade_slice(item["entry"], {"answer": released})["correct"]
        rows.append({"kind": kind, "block": block, "position": position, "action": action, "reason": reason,
                     "fallback": fallback, "confidence": confidence, "teamAnswer": action == "release" and not fallback,
                     "releasedCorrect": good, "seconds": round(seconds, 3)})
        if len(rows) % 25 == 0:
            print(f"shard {args.shard}: {len(rows)} done, {sum(r['seconds'] for r in rows) / len(rows):.1f} s each",
                  flush=True)
    with open(os.path.join(args.out, f"certify-{args.shard}-of-{args.shards}.json"), "w") as handle:
        json.dump({"rows": rows, "weightsHash": team_weights(team)[0], "thresholdSet": thresholds["id"],
                   "reference": True, "fittedByW1": sorted(fitted), "dataset": dataset, "shard": args.shard,
                   "shards": args.shards, "commit": open(os.path.join(REPO, "COMMIT")).read().strip()
                   if os.path.exists(os.path.join(REPO, "COMMIT")) else None}, handle)
    print(f"shard {args.shard} done: {len(rows)} requests", flush=True)


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
    calibrate = [k for k, b in enumerate(blocks) if b in PROBE_TRAIN]
    score = [k for k, b in enumerate(blocks) if b in PROBE_TEST]
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


def counts(rows, pairs, threshold):
    return {"held": sum(r["action"] == "hold" for r in rows),
            "fallbacksReleased": sum(r["fallback"] for r in rows),
            "abstained": sum(r["action"] == "release" and not r["fallback"] and decide(p[0], threshold) != "released"
                             for r, p in zip(rows, pairs))}


def part_analyze(args):
    import glob
    from .abstain import auroc, choose_threshold, score_threshold, upper_bound
    with open(os.path.join(args.out, "rows.json")) as handle:
        batched = json.load(handle)
    single = []
    shards = sorted(glob.glob(os.path.join(args.out, "certify-*-of-*.json")))
    meta = None
    for path in shards:
        with open(path) as handle:
            data = json.load(handle)
        single += data["rows"]
        meta = meta or data
    expected = {int(re.search(r"of-(\d+)", path).group(1)) for path in shards}
    if len(expected) != 1 or len(shards) != expected.pop():
        raise SystemExit("the certification shards are incomplete")
    if meta["weightsHash"] != batched["weightsHash"] or meta["thresholdSet"] != batched["thresholdSet"]:
        raise SystemExit("the batched and single runs are of different weights or threshold sets")
    proposal = [released_score(r)[0] for r in batched["gsm8k"] if r["block"] in PROPOSE]
    gsm = [r for r in single if r["kind"] == "gsm8k"]
    cert = [r for r in gsm if r["block"] in CERTIFY]
    scored = [r for r in gsm if r["block"] in SCORE]
    fresh = [r for r in single if r["kind"] == "fresh"]
    cert_pairs, score_pairs = [released_score(r) for r in cert], [released_score(r) for r in scored]
    threshold, steps, chosen = choose_threshold(proposal, [p[0] for p in cert_pairs], [p[1] for p in cert_pairs],
                                                TARGET, DELTA, GRID)
    result = score_threshold([p[0] for p in score_pairs], [p[1] for p in score_pairs], threshold, TARGET)
    result.update(counts(scored, score_pairs, threshold))
    seconds = [r["seconds"] for r in single]
    summary = {
        "threshold": threshold, "certification": chosen, "candidates": len(steps),
        "certificationQuestions": len(cert), "eval11": result,
        "releasedAccuracyBeforeThreshold": {
            "certify": round(sum(r["releasedCorrect"] for r in cert) / len(cert), 4),
            "score": round(sum(r["releasedCorrect"] for r in scored) / len(scored), 4)},
        "decisions": {word: sum(r["action"] == word for r in scored) for word in ("release", "hold")},
        "holdReasons": sorted({r["reason"] for r in single if r["action"] == "hold"}),
        "singleSeconds": {"median": sorted(seconds)[len(seconds) // 2], "mean": round(sum(seconds) / len(seconds), 2)},
    }
    # Eval 12: the same threshold on the fresh set; nothing to transfer when nothing certified.
    if threshold is None:
        summary["eval12"] = {"skipped": "no threshold certified"}
    else:
        fresh_pairs = [released_score(r) for r in fresh]
        summary["eval12"] = score_threshold([p[0] for p in fresh_pairs], [p[1] for p in fresh_pairs], threshold, TARGET)
    fresh_fallbacks = [r for r in fresh if r["fallback"]]
    summary["eval12Baseline"] = {"questions": len(fresh), "fallbacksReleased": len(fresh_fallbacks),
                                 "fallbacksWrong": sum(not r["releasedCorrect"] for r in fresh_fallbacks)}
    # Exploratory: the batched run under the same split, and batched against single decisions.
    by_block = {}
    for r in batched["gsm8k"]:
        by_block.setdefault(r["block"], []).append(r)
    explore = {}
    b_cert = [released_score(r) for b in CERTIFY for r in by_block.get(b, [])]
    b_score = [released_score(r) for b in (4, 5) for r in by_block.get(b, [])]
    t, _, _ = choose_threshold(proposal, [p[0] for p in b_cert], [p[1] for p in b_cert], TARGET, DELTA, GRID)
    explore["batchedEval11"] = dict(score_threshold([p[0] for p in b_score], [p[1] for p in b_score], t, TARGET),
                                    threshold=t, scoredOn="blocks 4 and 5, batched")
    pairs = [(by_block[r["block"]][r["position"]], r) for r in gsm if r["block"] in by_block]
    explore["batchedVsSingle"] = {
        "questions": len(pairs),
        "sameAction": sum(b["action"] == s["action"] and b["fallback"] == s["fallback"] for b, s in pairs),
        "sameDecisionUnderThreshold": sum(decide(released_score(b)[0], threshold) == decide(released_score(s)[0], threshold)
                                          for b, s in pairs),
        "sameCorrectness": sum(b["releasedCorrect"] == s["releasedCorrect"] for b, s in pairs)}
    transfer = batched.get("transfer", [])
    explore["transferInBatchedRun"] = {"questions": len(transfer), "sameAnswer": sum(t["sameAnswer"] for t in transfer)}
    team_rows = [r for r in scored if r["teamAnswer"]]
    value = auroc([-(r["confidence"] if r["confidence"] is not None else -1e9) for r in team_rows],
                  [not r["releasedCorrect"] for r in team_rows])
    explore["confidenceAurocSingle"] = None if value is None else round(value, 4)
    explore["probe"] = batched.get("probe")   # eval 13, on the batched run
    summary["exploratory"] = explore
    print(json.dumps(summary, indent=1, default=str))
    with open(os.path.join(args.out, "summary.json"), "w") as handle:
        json.dump(summary, handle, indent=1, default=str)
    if args.calibration_dir and result["passed"]:
        from .abstain import artifact_name, validate
        os.makedirs(args.calibration_dir, exist_ok=True)
        calibration = {
            "id": "w3-qwen2.5-3b-instruct-gsm8k-1", "task": TASK, "model": MODEL,
            "weightsHash": meta["weightsHash"], "thresholdSet": meta["thresholdSet"], "reference": True,
            "steps": STEPS, "maxNewTokens": TOKENS, "batch": 1, "gated": True, "grid": GRID,
            "score": "answer-number-logprob", "threshold": threshold, "target": TARGET, "delta": DELTA,
            "certified": True,
            "measuredOn": {"split": "test", "seed": SEED, "blockSize": COUNT, "propose": list(PROPOSE),
                           "certify": list(CERTIFY), "score": list(SCORE), "fittedByW1": list(FITTED_BY_W1),
                           "requests": "single, through TeamService", "date": time.strftime("%Y-%m-%d")},
            "certification": {"threshold": threshold, "released": chosen["released"], "errors": chosen["errors"],
                              "upper": upper_bound(chosen["errors"], chosen["released"], DELTA / GRID)},
            "heldOut": {k: result[k] for k in ("questions", "released", "releasedShare", "errors", "error", "error95",
                                               "passed")},
            "about": ("W3 calibration (docs/watchdog-security.md): for single requests through the latent team "
                      "service on this kind of task, an answer is released when the log-probability of its graded "
                      "number reaches the threshold (a fallback answer is released, a held run is not). Candidates "
                      "came from the scores of GSM8K test blocks 0 and 2, were tested on blocks 1 and 3 at 0.05 / 20 "
                      "each (Bonferroni over the grid, one-sided Clopper-Pearson) for a 10% error ceiling, and the "
                      "threshold was scored on blocks 4, 5 and the rest of the test set. Void for any other weights, "
                      "task or policy."),
        }
        validate(calibration, TASK, MODEL)
        with open(os.path.join(args.calibration_dir, artifact_name(TASK, MODEL)), "w") as handle:
            json.dump(calibration, handle, indent=1)
            handle.write("\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--part", required=True, choices=("run", "certify", "analyze"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--w1", default=os.path.expanduser("~/w1/out"))
    parser.add_argument("--calibration-dir", default=None)
    parser.add_argument("--shard", type=int, default=0)
    parser.add_argument("--shards", type=int, default=1)
    args = parser.parse_args()
    args.out = os.path.expanduser(args.out)
    args.w1 = os.path.expanduser(args.w1)
    os.makedirs(args.out, exist_ok=True)
    {"run": part_run, "certify": part_certify, "analyze": part_analyze}[args.part](args)


if __name__ == "__main__":
    main()
