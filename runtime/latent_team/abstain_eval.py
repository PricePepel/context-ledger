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
eval 13 and how batched decisions compare with single ones. Eval 14 (refusals) runs in
safety_eval.py.

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
# The certification plans: (block, how many of its questions, None for all). "full" is the plan
# decided before any run; "today" is the cut taken on 2026-11-22 so a single-request run
# finishes in a day on the laptop GPU (about 100 s a request with two shards): 60 proposal
# questions (they only place the candidate cutoffs), all 200 of block 1 to certify (the least
# that makes a 10% bound at 0.05 / 20 reachable), and 150 of block 3 to score.
PLANS = {
    "full": {"propose": ((0, None), (2, None)), "certify": ((1, None), (3, None)),
             "score": ((4, None), (5, None), (6, None))},
    "today": {"propose": ((0, 60),), "certify": ((1, None),), "score": ((3, 150),)},
}


def plan_blocks(plan, part):
    return tuple(block for block, _ in PLANS[plan][part])


def plan_items(items, plan, part):
    """(block, position, item) for one part of a plan."""
    out = []
    for block, count in PLANS[plan][part]:
        chosen = block_items(items, block)
        out += [(block, position, item) for position, item in enumerate(chosen if count is None else chosen[:count])]
    return out


def work_keys(plan, fresh=None):
    """Every request of a plan, in the order the certification shards take them: request
    number k belongs to shard k mod the number of shards."""
    fresh = len(fresh_items()) if fresh is None else fresh
    return (plan_keys(plan, "propose") + plan_keys(plan, "certify") + plan_keys(plan, "score")
            + [("fresh", None, position) for position in range(fresh)])


PARTS = ("propose", "certify", "score", "fresh")
BARRIER_POLL, BARRIER_LIMIT = 10, 3 * 3600   # seconds


def part_of_keys(plan, fresh=None):
    """{request key: its part} for every request of a plan."""
    fresh = len(fresh_items()) if fresh is None else fresh
    parts = {key: part for part in ("propose", "certify", "score") for key in plan_keys(plan, part)}
    parts.update({("fresh", None, position): "fresh" for position in range(fresh)})
    return parts


def barrier_ready(out, manifest, part, order, parts):
    """True when every shard of this run has saved every request it owns from the parts before
    `part` (review W3-6). The shards share one GPU, so a request of one part could otherwise
    slow another shard's request of an earlier part past its deadline: the proposal grid could
    then depend on certification requests, and the certification on scored ones."""
    earlier = set(PARTS[:PARTS.index(part)])
    shards = manifest["shards"]
    same = {k: v for k, v in manifest.items() if k != "shard"}
    for shard in range(shards):
        needed = {key for number, key in enumerate(order) if number % shards == shard and parts[key] in earlier}
        if not needed:
            continue
        try:
            with open(os.path.join(out, f"certify-{shard}-of-{shards}.json")) as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            return False
        if {k: data.get(k) for k in same} != same:   # no file of this run yet
            return False
        if not needed <= {(r["kind"], r["block"], r["position"]) for r in data.get("rows", [])}:
            return False
    return True


def shard_progress(out, manifest):
    """How many rows the shards of this run have saved, in all."""
    total, shards = 0, manifest["shards"]
    same = {k: v for k, v in manifest.items() if k != "shard"}
    for shard in range(shards):
        try:
            with open(os.path.join(out, f"certify-{shard}-of-{shards}.json")) as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            continue
        if {k: data.get(k) for k in same} == same:
            total += len(data.get("rows", []))
    return total


def wait_for_part(out, manifest, part, order, parts, poll=BARRIER_POLL, limit=BARRIER_LIMIT, sleep=time.sleep):
    """Wait at the barrier; give up only after `limit` seconds in which no shard of the run saved
    a row, so a shard that resumed far behind can catch up (review W3-7)."""
    idle, seen = 0, shard_progress(out, manifest)
    while not barrier_ready(out, manifest, part, order, parts):
        if idle >= limit:
            raise SystemExit(f"waited {limit} s with no progress from the other shards, before {part}")
        sleep(poll)
        now = shard_progress(out, manifest)
        idle = 0 if now > seen else idle + poll
        seen = max(seen, now)


def write_atomic(path, data, replace=os.replace, sleep=time.sleep, attempts=5):
    """Write a shard's file whole, through a temporary file. On native Windows a peer reading the
    file at the barrier can make the replacement fail for a moment, so it is retried (review
    W3-7); POSIX replacement does not fail that way."""
    temporary = path + ".tmp"
    with open(temporary, "w") as handle:
        json.dump(data, handle)
    for attempt in range(attempts):
        try:
            replace(temporary, path)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            sleep(0.2 * (attempt + 1))


def run_work(work, shard, shards, done, rows, ask, save, wait_part, parts):
    """This shard's requests in order. Before its first request of each part it saves its rows
    and waits until every shard has finished the parts before it (review W3-6)."""
    current = None
    for number, (kind, block, position, item) in enumerate(work):
        if number % shards != shard or (kind, block, position) in done:
            continue
        part = parts[(kind, block, position)]
        if part != current:
            save(False)
            wait_part(part)
            current = part
        rows.append(ask(kind, block, position, item))
        if len(rows) % 5 == 0:
            save(False)
            print(f"shard {shard}: {len(rows)} done, {sum(r['seconds'] for r in rows) / len(rows):.1f} s each",
                  flush=True)


def describe(plan, part):
    """Words for one part of a plan, as in "block 0 (60 questions)"."""
    return ", ".join(f"block {block}" + ("" if count is None else f" ({count} questions)")
                     for block, count in PLANS[plan][part])


def plan_keys(plan, part):
    keys = []
    for block, count in PLANS[plan][part]:
        size = COUNT if block < 6 else GSM8K_TEST - 6 * COUNT
        keys += [("gsm8k", block, position) for position in range(size if count is None else count)]
    return keys
PROBE_TRAIN, PROBE_TEST = (0, 1, 2), (3, 4, 5)
TRANSFER_BLOCK, TRANSFER = 3, 64       # batched questions also run one at a time in the batched run
TARGET, DELTA, GRID = 0.10, 0.05, 20
JOIN_MARGIN = 0.02
PROBE_SCORE = {"threshold": -math.inf}   # score every run, abstain on none
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


GSM8K_TEST = 1319


def dataset_identity(items):
    """The one cached GSM8K snapshot, and fingerprints of its ordered test questions and of the
    ordered question and gold pairs (review W3-4: a changed label changes it); stops the run
    unless there is exactly one snapshot with 1319 distinct questions, so no question can
    enter two splits (review W3-3)."""
    import glob
    import hashlib
    from .evaluate import HUB
    snapshots = sorted(glob.glob(os.path.join(HUB, "datasets--openai--gsm8k", "snapshots", "*")))
    questions = [item["question"] for item in items]
    if len(snapshots) != 1 or len(questions) != GSM8K_TEST or len(set(questions)) != GSM8K_TEST:
        raise SystemExit(f"GSM8K test must be one snapshot of {GSM8K_TEST} distinct questions: "
                         f"{len(snapshots)} snapshots, {len(questions)} rows, {len(set(questions))} distinct")
    labels = [f"{item['question']}\t{item['gold']!r}" for item in items]
    return {"revision": os.path.basename(snapshots[0]),
            "fingerprint": hashlib.sha256("\n".join(questions).encode("utf-8")).hexdigest(),
            "labels": hashlib.sha256("\n".join(labels).encode("utf-8")).hexdigest()}


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


def grade_fresh(entry, released):
    """The shared latent grader on a fresh-set answer, or None when Python cannot grade it (one
    of the shared patterns needs a variable-width look-behind, which Python's re refuses):
    such a row is ungraded and left out of eval 12, never a crash."""
    from tests.grade import grade_slice
    if released is None:
        return False
    try:
        return bool(grade_slice(entry, {"answer": released})["correct"])
    except ValueError:
        return None


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
    fresh_rows, fresh_states = [], []
    for chunk in batches(fresh_items(), 4):
        outcomes, got, chunk_states = guarded(guard, [i["question"] for i in chunk])
        for item, outcome, row, state in zip(chunk, outcomes, got, chunk_states):
            released = outcome.answer if row["action"] == "release" else None
            row.update(id=item["id"], teamAnswer=row["action"] == "release" and not row["fallback"],
                       releasedCorrect=grade_fresh(item["entry"], released))
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


def resumed(path, manifest, owned):
    """The rows a shard saved before, to resume it: only from a file of the same run (every
    manifest field equal), and only requests this shard owns, each once (review W3-4)."""
    if not os.path.exists(path):
        return []
    with open(path) as handle:
        before = json.load(handle)
    if {k: before.get(k) for k in manifest} != manifest:
        raise SystemExit(f"{path} is of another run")
    rows = before["rows"]
    keys = [(r["kind"], r["block"], r["position"]) for r in rows]
    if len(set(keys)) != len(keys) or not set(keys) <= owned:
        raise SystemExit(f"{path} holds a request twice, or one this shard does not own")
    return rows


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
    # One named run of one known commit (review W3-4): every shard of the run is started with
    # the same --run, from a snapshot with a COMMIT file.
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,39}", args.run or ""):
        raise SystemExit("--run must name this run in letters, digits and hyphens; every shard of it shares the name")
    commit_path = os.path.join(REPO, "COMMIT")
    commit = open(commit_path).read().strip() if os.path.exists(commit_path) else ""
    if not commit:
        raise SystemExit("no COMMIT file: the run's source revision would be unknown")
    items = gsm8k("test")
    dataset = dataset_identity(items)
    team = LatentTeam(MODEL)
    warm = [item["question"] for item in items[:4]]
    team.single(warm, max_new_tokens=8)
    team.latent_mas(warm, steps=2, max_new_tokens=8)
    thresholds = load_thresholds(MODEL, team_weights(team)[0])   # the committed set, as the service loads it
    # W1's blocks are excluded by number, so W1 must have cut the same split the same way
    # (review W3-4). Its file records no dataset revision; the GPU machine has held one
    # snapshot since before W1 ran (docs/evals.md, W3).
    measured = thresholds.get("measuredOn") or {}
    if (measured.get("split"), measured.get("seed"), measured.get("count")) != ("test", SEED, COUNT):
        raise SystemExit("W1's thresholds were not fitted on blocks of this split: its fitted rows are unknown")
    fitted = {thresholds["measuredOn"]["block"], thresholds["distance"]["referenceBlock"]}
    if fitted != set(FITTED_BY_W1) or fitted & set(plan_blocks(args.plan, "certify") + plan_blocks(args.plan, "score")):
        raise SystemExit(f"W1 fitted blocks {sorted(fitted)}: they may not certify or score")
    service = TeamService(team, steps=STEPS)
    if service.guard.reference is None:
        raise SystemExit("the distance reference did not load: the service would run unscreened")
    # Score every request without abstaining: the threshold is applied afterwards.
    service.guard.calibration = lambda task, *rest, **kw: PROBE_SCORE if task else None
    # The proposal blocks run as single requests too, since the batched run that carried them
    # crashed (its scores would only have proposed candidates anyway).
    work = [("gsm8k", block, position, item) for part in ("propose", "certify", "score")
            for block, position, item in plan_items(items, args.plan, part)]
    work += [("fresh", None, position, item) for position, item in enumerate(fresh_items())]
    if [(kind, block, position) for kind, block, position, _ in work] != work_keys(args.plan):
        raise SystemExit("the work list is not the plan's requests in order")
    owned = {(kind, block, position) for number, (kind, block, position, _) in enumerate(work)
             if number % args.shards == args.shard}
    path = os.path.join(args.out, f"certify-{args.shard}-of-{args.shards}.json")
    manifest = {"run": args.run, "plan": args.plan, "weightsHash": team_weights(team)[0],
                "thresholdSet": thresholds["id"], "reference": True, "fittedByW1": sorted(fitted), "dataset": dataset,
                "shard": args.shard, "shards": args.shards, "commit": commit, "phases": "separated"}
    rows = resumed(path, manifest, owned)
    done = {(r["kind"], r["block"], r["position"]) for r in rows}

    def save(complete):
        write_atomic(path, dict(manifest, rows=rows, complete=complete))

    order, parts = work_keys(args.plan), part_of_keys(args.plan)

    def ask(kind, block, position, item):
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
            good = grade_fresh(item["entry"], released)
        return {"kind": kind, "block": block, "position": position, "action": action, "reason": reason,
                "fallback": fallback, "confidence": confidence, "teamAnswer": action == "release" and not fallback,
                "releasedCorrect": good, "seconds": round(seconds, 3)}

    run_work(work, args.shard, args.shards, done, rows, ask, save,
             lambda part: wait_for_part(args.out, manifest, part, order, parts), parts)
    save(True)
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


def worst_case(row):
    """(score, wrong) with a held request counted as a released wrong answer at every threshold
    (review W3-5). The two shards share one GPU, so one request's timing can change another's
    decision, and only by holding it: every budget check that skips a stage is followed by a
    hold at the release boundary (guard.py). On a service no slower than the certification's,
    a held request would at worst be released and wrong, so these counts are at least its."""
    if row["action"] != "release":
        return math.inf, True
    return released_score(row)


def worst_case_eval11(scored, threshold):
    """Eval 11's rule from the worst case: holds count as released wrong answers for the error
    rule, and as not released for the coverage rule."""
    from .abstain import passes, score_threshold
    pairs = [worst_case(r) for r in scored]
    result = score_threshold([p[0] for p in pairs], [p[1] for p in pairs], threshold, TARGET)
    # released() takes math.inf scores at any threshold, None too, so the holds are always in
    # the tally (review W3-6).
    result["heldCountedWrong"] = sum(r["action"] != "release" for r in scored)
    result["releasedWithoutHolds"] = result["released"] - result["heldCountedWrong"]
    result["passed"] = bool(threshold is not None and passes(result["errors"], result["released"], len(scored), TARGET)
                            and result["releasedWithoutHolds"] >= len(scored) / 2)
    return result


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
    batched_path = os.path.join(args.out, "rows.json")
    batched = None
    if os.path.exists(batched_path):   # exploratory only
        with open(batched_path) as handle:
            batched = json.load(handle)
    single = []
    shards = sorted(glob.glob(os.path.join(args.out, "certify-*-of-*.json")))
    manifests, by_shard = [], {}
    for path in shards:
        with open(path) as handle:
            data = json.load(handle)
        if data.get("complete") is not True:
            raise SystemExit(f"{path} is not complete")
        single += data["rows"]
        by_shard[data.get("shard")] = data["rows"]
        manifests.append({k: data.get(k) for k in ("run", "plan", "weightsHash", "thresholdSet", "reference",
                                                  "fittedByW1", "dataset", "shards", "commit", "phases")}
                         | {"shard": data.get("shard")})
    # One run (review W3-3): every shard of one manifest, each once, and exactly the expected
    # requests, each once.
    if not manifests or any({k: v for k, v in m.items() if k != "shard"} !=
                            {k: v for k, v in manifests[0].items() if k != "shard"} for m in manifests):
        raise SystemExit("the certification shards are not of one run")
    meta = manifests[0]
    if args.run is None or meta["run"] != args.run:   # review W3-5: the run asked for, or nothing
        raise SystemExit(f"the certification shards are of run {meta['run']!r}, not {args.run!r}")
    if sorted(m["shard"] for m in manifests) != list(range(meta["shards"])):
        raise SystemExit("the certification shards are incomplete or repeated")
    if not all(isinstance(meta.get(k), str) and meta[k] for k in ("run", "commit")) or \
            not isinstance(meta.get("dataset"), dict) or not meta["dataset"].get("labels"):
        raise SystemExit("the certification shards do not name their run, commit and labelled dataset")
    if meta.get("phases") != "separated":   # review W3-6
        raise SystemExit("the certification shards did not wait for each other between parts")
    if batched is not None and (meta["weightsHash"] != batched["weightsHash"] or
                                meta["thresholdSet"] != batched["thresholdSet"]):
        batched = None   # of another run: not used, even for exploration
    plan = meta.get("plan")
    if plan not in PLANS:
        raise SystemExit("the certification shards name no known plan")
    order = work_keys(plan)
    if sorted(((r["kind"], r["block"], r["position"]) for r in single), key=str) != sorted(order, key=str):
        raise SystemExit("the certification requests are not exactly the expected ones, each once")
    owner = {key: number % meta["shards"] for number, key in enumerate(order)}
    if any(owner[(r["kind"], r["block"], r["position"])] != shard for shard, rows in by_shard.items() for r in rows):
        raise SystemExit("a certification shard holds a request another shard owns")   # review W3-4
    gsm = [r for r in single if r["kind"] == "gsm8k"]
    keys = {part: set(plan_keys(plan, part)) for part in ("propose", "certify", "score")}
    part_of = lambda r, part: (r["kind"], r["block"], r["position"]) in keys[part]   # noqa: E731
    proposal = [released_score(r)[0] for r in gsm if part_of(r, "propose")]
    cert = [r for r in gsm if part_of(r, "certify")]
    scored = [r for r in gsm if part_of(r, "score")]
    fresh_all = [r for r in single if r["kind"] == "fresh"]
    fresh = [r for r in fresh_all if r["releasedCorrect"] is not None]   # graded rows only
    cert_pairs, score_pairs = [released_score(r) for r in cert], [released_score(r) for r in scored]
    threshold, steps, chosen = choose_threshold(proposal, [p[0] for p in cert_pairs], [p[1] for p in cert_pairs],
                                                TARGET, DELTA, GRID)
    result = score_threshold([p[0] for p in score_pairs], [p[1] for p in score_pairs], threshold, TARGET)
    result.update(counts(scored, score_pairs, threshold))
    # The worst case for holds (review W3-5): the claim and the calibration come from it.
    cert_worst = [worst_case(r) for r in cert]
    worst_threshold, _, worst_chosen = choose_threshold(proposal, [p[0] for p in cert_worst],
                                                        [p[1] for p in cert_worst], TARGET, DELTA, GRID)
    if worst_chosen is not None:
        worst_chosen = dict(worst_chosen, heldCountedWrong=sum(r["action"] != "release" for r in cert))
    worst = {"threshold": worst_threshold, "certification": worst_chosen,
             "eval11": worst_case_eval11(scored, worst_threshold)}
    seconds = [r["seconds"] for r in single]
    summary = {
        "run": meta["run"], "commit": meta["commit"], "execution": "two shards sharing one GPU",
        "plan": plan, "threshold": threshold, "certification": chosen, "candidates": len(steps),
        "proposalQuestions": len(proposal), "scoredQuestions": len(scored),
        "certificationQuestions": len(cert), "eval11": result, "worstCaseForHolds": worst,
        "releasedAccuracyBeforeThreshold": {
            "certify": round(sum(r["releasedCorrect"] for r in cert) / len(cert), 4),
            "score": round(sum(r["releasedCorrect"] for r in scored) / len(scored), 4)},
        "decisions": {word: sum(r["action"] == word for r in scored) for word in ("release", "hold")},
        # By reason and part (review W3-4): deadline holds are counted apart, since the two
        # shards shared one GPU and one request's length can push another past its deadline.
        "holdsByReason": {part: {reason: sum(r["action"] == "hold" and r["reason"] == reason for r in rows)
                                 for reason in sorted({r["reason"] for r in rows if r["action"] == "hold"})}
                          for part, rows in (("certify", cert), ("score", scored), ("fresh", fresh_all))},
        "singleSeconds": {"median": sorted(seconds)[len(seconds) // 2], "mean": round(sum(seconds) / len(seconds), 2)},
    }
    # Eval 12: the same threshold on the fresh set; nothing to transfer when nothing certified.
    # At the threshold that would ship, the worst case's (review W3-6), and apart at the
    # pre-registered count's.
    fresh_pairs = [released_score(r) for r in fresh]
    for name, value in (("eval12", worst_threshold), ("eval12AtPreRegisteredThreshold", threshold)):
        summary[name] = {"skipped": "no threshold certified"} if value is None else \
            score_threshold([p[0] for p in fresh_pairs], [p[1] for p in fresh_pairs], value, TARGET)
    summary["eval12Ungraded"] = len(fresh_all) - len(fresh)
    fresh_fallbacks = [r for r in fresh if r["fallback"]]
    summary["eval12Baseline"] = {"questions": len(fresh), "fallbacksReleased": len(fresh_fallbacks),
                                 "fallbacksWrong": sum(not r["releasedCorrect"] for r in fresh_fallbacks)}
    # Exploratory: the batched run under the same split, and batched against single decisions,
    # when a batched run of these weights finished.
    explore = {}
    team_rows = [r for r in scored if r["teamAnswer"]]
    value = auroc([-(r["confidence"] if r["confidence"] is not None else -1e9) for r in team_rows],
                  [not r["releasedCorrect"] for r in team_rows])
    explore["confidenceAurocSingle"] = None if value is None else round(value, 4)
    if batched is None:
        explore["batched"] = "not run: no finished batched run of these weights (eval 13's probe ran on it)"
        summary["exploratory"] = explore
        return finish(args, summary, worst, meta)
    by_block = {}
    for r in batched["gsm8k"]:
        by_block.setdefault(r["block"], []).append(r)
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
    # Pre-registered, exploratory only (review W3-3): the other scores on the batched run,
    # with the same split, never used for the pass rule or the calibration.
    b_rows = {b: by_block.get(b, []) for b in PROPOSE + CERTIFY + (4, 5)}
    b_team = [r for b in (4, 5) for r in b_rows[b] if r["teamAnswer"]]
    for name in ("meanLogprob", "minLogprob"):
        def alt(r):
            if r["action"] != "release":
                return None, False
            return (math.inf if r["fallback"] else r[name]), not r["releasedCorrect"]
        prop = [alt(r)[0] for b in PROPOSE for r in b_rows[b]]
        cert_alt = [alt(r) for b in CERTIFY for r in b_rows[b]]
        score_alt = [alt(r) for b in (4, 5) for r in b_rows[b]]
        t, _, _ = choose_threshold(prop, [p[0] for p in cert_alt], [p[1] for p in cert_alt], TARGET, DELTA, GRID)
        value = auroc([-(r[name] if r[name] is not None else -1e9) for r in b_team],
                      [not r["releasedCorrect"] for r in b_team])
        explore[name] = {"aurocBatched": None if value is None else round(value, 4),
                         "calibratedBatched": score_threshold([p[0] for p in score_alt], [p[1] for p in score_alt], t,
                                                              TARGET)}
    value = auroc([0.0 if r.get("agree") == "agree" else 1.0 for r in b_team], [not r["releasedCorrect"] for r in b_team])
    explore["agreeWithSolverAlone"] = {"aurocBatched": None if value is None else round(value, 4)}
    explore["probe"] = batched.get("probe")   # eval 13, on the batched run
    summary["exploratory"] = explore
    return finish(args, summary, worst, meta)


def finish(args, summary, worst, meta):
    """Print and write the summary; write the calibration only from the worst case for holds
    (review W3-5), when it is certified and passes eval 11's rule."""
    from .abstain import upper_bound
    threshold, chosen, result = worst["threshold"], worst["certification"], worst["eval11"]
    print(json.dumps(summary, indent=1, default=str))
    with open(os.path.join(args.out, "summary.json"), "w") as handle:
        json.dump(summary, handle, indent=1, default=str)
    plan = meta["plan"]
    if args.calibration_dir and result["passed"]:
        from .abstain import artifact_name, service_profile, validate
        os.makedirs(args.calibration_dir, exist_ok=True)
        calibration = {
            "id": "w3-qwen2.5-3b-instruct-gsm8k-1", "task": TASK, "model": MODEL,
            "weightsHash": meta["weightsHash"], "thresholdSet": meta["thresholdSet"], "reference": True,
            "steps": STEPS, "maxNewTokens": TOKENS, "batch": 1, "gated": True, "grid": GRID,
            "score": "answer-number-logprob", "threshold": threshold, "target": TARGET, "delta": DELTA,
            "certified": True,
            # What the certification ran: /latent/team requests, public clearance, no declared
            # secrets (review W3-4); and where its evidence came from.
            "profile": service_profile("request", "public", False),
            "provenance": {"run": meta["run"], "commit": meta["commit"], "dataset": meta["dataset"]},
            "measuredOn": {"split": "test", "seed": SEED, "blockSize": COUNT, "plan": plan,
                           "propose": [list(x) for x in PLANS[plan]["propose"]],
                           "certify": [list(x) for x in PLANS[plan]["certify"]],
                           "score": [list(x) for x in PLANS[plan]["score"]],
                           "fittedByW1": list(FITTED_BY_W1),
                           "requests": "single, through TeamService", "execution": "two shards sharing one GPU",
                           "date": time.strftime("%Y-%m-%d")},
            "certification": {"threshold": threshold, "released": chosen["released"], "errors": chosen["errors"],
                              "heldCountedWrong": chosen["heldCountedWrong"],
                              "upper": upper_bound(chosen["errors"], chosen["released"], DELTA / GRID)},
            "heldOut": {k: result[k] for k in ("questions", "released", "releasedShare", "errors", "error", "error95",
                                               "heldCountedWrong", "releasedWithoutHolds", "passed")},
            "about": ("W3 calibration (docs/watchdog-security.md): for single requests through the latent team "
                      "service on this kind of task, an answer is released when the log-probability of its graded "
                      "number reaches the threshold (a fallback answer is released, a held run is not). Candidates "
                      f"came from the scores of GSM8K test {describe(plan, 'propose')}, were tested on "
                      f"{describe(plan, 'certify')} at 0.05 / 20 each (Bonferroni over the grid, one-sided "
                      f"Clopper-Pearson) for a 10% error ceiling, and the threshold was scored on {describe(plan, 'score')} "
                      f"(plan {plan!r}), every held request counted as a released wrong answer (the two "
                      "certification shards shared one GPU). Void for any other weights, task, policy or service profile "
                      "(it was measured on /latent/team requests with public clearance and no declared secrets)."),
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
    parser.add_argument("--plan", choices=sorted(PLANS), default="full")
    parser.add_argument("--run", default=None, help="certify and analyze: the run's name, shared by its shards")
    args = parser.parse_args()
    args.out = os.path.expanduser(args.out)
    args.w1 = os.path.expanduser(args.w1)
    os.makedirs(args.out, exist_ok=True)
    {"run": part_run, "certify": part_certify, "analyze": part_analyze}[args.part](args)


if __name__ == "__main__":
    main()
