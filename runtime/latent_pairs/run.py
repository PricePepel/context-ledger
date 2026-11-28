"""Train and measure the batch's pairs, one after another, on one GPU.

    python -m latent_pairs.run --root ~/l5-mappers --compare ~/l5-mappers/compare --repro ~/l5-mappers/compare-repro

Each pair gets a folder under --root with the training log, the checkpoints and a
status.json. The command can be run again after an interruption:

- a pair that is measured, with its result file still the one that was written, is left alone;
- a pair cut off in stage 2 starts stage 2 again from its stage 1 checkpoint;
- the time an interrupted run had used is counted against the budget.

The first pair of the batch is the M2b-S pair again and is measured into --repro, beside
the registered checkpoint's result in --compare. No other pair starts before the recipe
decision of docs/evals.md (L5) is made from those two results and written to recipe.json;
that decision sets the step counts for the rest. No new pair starts once the batch has used
its budget. Standard library only: training and measuring run as their own processes, so the
GPU is empty between them.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

from .plan import BATCH, BUDGET_HOURS, ITEMS_ID, out_of_memory, pair_name, recipe, train_args, within_budget

STATUS, RECIPE_FILE = "status.json", "recipe.json"
DIVERGED = 3   # latent_transfer.train's exit code for a loss or gradient that is not a number
ATTEMPT_FILES = ("log.jsonl", "train.out", "stage1.pt", "best.pt", "last.pt", "stage1.pt.tmp", "best.pt.tmp", "last.pt.tmp")


def load_json(target):
    try:
        with open(target, encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def save_json(target, data):
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target + ".tmp", "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=1)
    os.replace(target + ".tmp", target)


def load_status(folder):
    return load_json(os.path.join(folder, STATUS)) or {}


def save_status(folder, status):
    save_json(os.path.join(folder, STATUS), status)


def read_log(folder):
    """The training log's events. A last line cut off by an interruption is left out."""
    rows = []
    try:
        with open(os.path.join(folder, "log.jsonl"), encoding="utf-8") as handle:
            for line in handle:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except FileNotFoundError:
        pass
    return [row for row in rows if isinstance(row, dict)]


def finished(folder):
    """Whether the training log of a folder ends with its `done` event."""
    rows = read_log(folder)
    return bool(rows) and rows[-1].get("event") == "done"


def diverged(folder):
    return any(row.get("event") == "diverged" for row in read_log(folder))


def sha256_file(target):
    digest = hashlib.sha256()
    with open(target, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def tail(path, size=4000):
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - size))
            return handle.read().decode("utf-8", "replace")
    except FileNotFoundError:
        return ""


def last_line(text):
    lines = text.strip().splitlines()
    return lines[-1][:300] if lines else "no output"


def run_logged(command, log_path):
    """Run a command with its output appended to log_path. Returns (exit code, seconds)."""
    started = time.time()
    with open(log_path, "ab") as handle:
        code = subprocess.run(command, stdout=handle, stderr=subprocess.STDOUT, check=False,
                              env={**os.environ, "PYTHONUNBUFFERED": "1",
                                   # fewer stranded blocks when batch shapes change every step
                                   "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}).returncode
    return code, time.time() - started


def launch_output(folder, status, size=4000):
    """The end of what the last training launch wrote: train.out from where that launch began.
    The file is appended to by every launch, so an out-of-memory line of an earlier one must
    not be read as this one's (Codex review, round 3)."""
    begin = (status.get("launch") or {}).get("offset", 0)
    try:
        with open(os.path.join(folder, "train.out"), "rb") as handle:
            handle.seek(0, os.SEEK_END)
            end = handle.tell()
            handle.seek(max(min(begin, end), end - size))
            return handle.read().decode("utf-8", "replace")
    except FileNotFoundError:
        return ""


def timed(folder, status, kind, command, log_name, runner, clock=time.time):
    """Run one process and charge its time to the pair. The start is written down first, so a
    run that is cut off can still be charged for (reconcile). What the run left behind is
    read from its own files afterwards (replay), never only from this process's memory."""
    status["running"] = {"kind": kind, "startedAt": clock(), "log": log_name}
    if kind == "train":
        target = os.path.join(folder, log_name)
        status["launch"] = {"offset": os.path.getsize(target) if os.path.exists(target) else 0}
    save_status(folder, status)
    code, seconds = runner(command, os.path.join(folder, log_name))
    status[f"{kind}Seconds"] = status.get(f"{kind}Seconds", 0) + seconds
    status.pop("running", None)
    save_status(folder, status)
    return code


def replay(folder, status):
    """Act on what the last training process left in its files, before another one starts.

    The runner can be cut off between a trainer's exit and the note of what that exit meant.
    The trainer's own files still say it: a `diverged` event ends the pair, and an
    out-of-memory error in the output of a run at the recipe's batches starts the one retry.
    Returns the reason the pair has failed, or None.
    """
    if status.get("retry") == "moving":   # cut off while the first attempt was being set aside
        set_aside(folder)
        status["retry"] = "ready"
        save_status(folder, status)
    if diverged(folder):
        return "training diverged (a loss or gradient that is not a number)"
    if finished(folder):
        return None
    if out_of_memory(launch_output(folder, status)):
        if status.get("smallBatches"):
            return "out of GPU memory at the small batches too"
        # Written down before anything is moved, so an interruption here cannot bring the
        # first attempt, or its stage 1 checkpoint, back.
        status.update({"smallBatches": True, "retriedAfterOutOfMemory": True, "retry": "moving"})
        save_status(folder, status)
        set_aside(folder)
        status["retry"] = "ready"
        status.pop("launch", None)
        save_status(folder, status)
    return None


def reconcile(folder, status):
    """Charge a pair for a run that was cut off before it could report its time: from its
    recorded start to the last time it wrote to its log."""
    running = status.pop("running", None)
    if not running:
        return status
    try:
        seen = os.path.getmtime(os.path.join(folder, running["log"]))
    except OSError:
        seen = running["startedAt"]
    kind = running["kind"]
    status[f"{kind}Seconds"] = status.get(f"{kind}Seconds", 0) + max(0.0, seen - running["startedAt"])
    status["interrupted"] = status.get("interrupted", 0) + 1
    save_status(folder, status)
    return status


def hours_used(root, pairs):
    """GPU hours the given pairs have used so far (training and measuring, cut-off runs included)."""
    seconds = 0.0
    for sender, receiver in pairs:
        folder = os.path.join(root, pair_name(sender, receiver))
        status = reconcile(folder, load_status(folder)) if os.path.isdir(folder) else {}
        seconds += status.get("trainSeconds", 0) + status.get("evalSeconds", 0)
    return seconds / 3600


def set_aside(folder):
    """Move a failed attempt's files into attempt1/. Safe to run again after an interruption:
    a file already moved is not overwritten by a later one."""
    aside = os.path.join(folder, "attempt1")
    os.makedirs(aside, exist_ok=True)
    for name in ATTEMPT_FILES:
        source, target = os.path.join(folder, name), os.path.join(aside, name)
        if os.path.exists(source):
            if os.path.exists(target):
                os.remove(source)
            else:
                shutil.move(source, target)


STAGE2_ONLY = ("stage2_steps", "batch2", "lr2", "qa_share")


def stage1_settings(settings):
    """The settings a stage 1 checkpoint depends on."""
    return {key: value for key, value in settings.items() if key not in STAGE2_ONLY}


def train(folder, sender, receiver, status, full_steps, runner=run_logged):
    """Train one pair, with the one small-batch retry after running out of memory.
    Returns None when it finished, else the reason it did not."""
    for _ in range(2):   # the recipe's batches, then at most the one retry
        reason = replay(folder, status)
        if reason:
            return reason
        if finished(folder):
            return None
        small = bool(status.get("smallBatches"))
        settings = recipe(full_steps=full_steps, small_batches=small)
        stage1 = os.path.join(folder, "stage1.pt")
        made_by = stage1_settings(settings)
        if os.path.exists(stage1) and status.get("stage1Settings") != made_by:
            # From other settings (the recipe changed), or from a runner that did not write
            # down which: stage 1 is trained again, so the result is what its label says.
            os.replace(stage1, os.path.join(folder, "stage1.other-settings.pt"))
        resume = stage1 if os.path.exists(stage1) else None
        status["stage1Settings"] = made_by
        command = [sys.executable, "-m", "latent_transfer.train", *train_args(sender, receiver, folder, settings, resume)]
        status.update({"state": "training", "settings": settings, "smallBatches": small,
                       "stage2Restarts": status.get("stage2Restarts", 0) + (1 if resume else 0)})
        code = timed(folder, status, "train", command, "train.out", runner)
        output = launch_output(folder, status)
        if code == DIVERGED or diverged(folder):
            return "training diverged (a loss or gradient that is not a number)"
        if code == 0 and finished(folder):
            return None
        if not out_of_memory(output):
            return f"training exited with code {code}: {last_line(output)}"
        if small:
            return "out of GPU memory at the small batches too"
    return replay(folder, status) or "training did not finish"


def result_path(compare, sender, receiver):
    return os.path.join(compare, "latent", f"{pair_name(sender, receiver)}.json")


def bound(folder, status, compare, sender, receiver, items_id=ITEMS_ID):
    """Whether a pair's recorded measurement still stands: the result file in this run folder
    is the one that was written for this checkpoint file, from the pinned item set."""
    result = status.get("result") or {}
    target, checkpoint = result_path(compare, sender, receiver), os.path.join(folder, "best.pt")
    if result.get("path") != os.path.abspath(target) or result.get("itemsId") != items_id:
        return False
    if not os.path.exists(target) or not os.path.exists(checkpoint):
        return False
    return sha256_file(target) == result.get("sha256") and sha256_file(checkpoint) == result.get("checkpointSha256")


def measure(folder, sender, receiver, compare, status, runner=run_logged, items_id=ITEMS_ID):
    """Run latent_compare's latent phase on the pair's best checkpoint, always afresh, and
    tie the result file to the checkpoint file it was made from."""
    checkpoint, target = os.path.join(folder, "best.pt"), result_path(compare, sender, receiver)
    if not os.path.exists(checkpoint):
        return "training left no best.pt"
    command = [sys.executable, "-m", "latent_pairs.evaluate", "--pair", f"{sender}:{receiver}",
               "--checkpoint", checkpoint, "--out", compare, "--force"]
    status["state"] = "measuring"
    status.pop("result", None)
    before = sha256_file(checkpoint)
    code = timed(folder, status, "eval", command, "eval.out", runner)
    if code != 0:
        return f"measuring exited with code {code}: {last_line(tail(os.path.join(folder, 'eval.out')))}"
    data = load_json(target)
    if not data:
        return "measuring left no result file"
    if data.get("itemsId") != items_id:
        return f"the result is from item set {data.get('itemsId')}, not L2's {items_id}"
    if sha256_file(checkpoint) != before:
        return "best.pt changed while it was being measured"
    status["result"] = {"path": os.path.abspath(target), "sha256": sha256_file(target), "checkpointSha256": before,
                        "checkpointId": data.get("checkpoint"), "itemsId": data.get("itemsId")}
    return None


def run_pair(root, compare, sender, receiver, full_steps, runner, say, items_id=ITEMS_ID):
    folder = os.path.join(root, pair_name(sender, receiver))
    status = reconcile(folder, load_status(folder)) if os.path.isdir(folder) else {}
    if status.get("state") == "failed":
        say(f"{sender}->{receiver}: already failed, {status.get('reason')}")
        return
    if status.get("state") == "measured" and bound(folder, status, compare, sender, receiver, items_id) \
            and not diverged(folder):
        say(f"{sender}->{receiver}: already measured")
        return
    status.update({"sender": sender, "receiver": receiver, "fullSteps": full_steps})
    # Through train() also when the log already ends with `done`: a run that diverged is
    # failed whatever a later process wrote after it.
    if not finished(folder):
        say(f"{sender}->{receiver}: training")
    reason = train(folder, sender, receiver, status, full_steps, runner)
    if reason:
        status.update({"state": "failed", "reason": reason})
        save_status(folder, status)
        say(f"{sender}->{receiver}: failed, {reason}")
        return
    say(f"{sender}->{receiver}: measuring")
    reason = measure(folder, sender, receiver, compare, status, runner, items_id)
    # A pair whose measurement failed is tried again on the next call: its mapper exists.
    status.update({"state": "trained", "reason": reason} if reason else {"state": "measured", "reason": None})
    save_status(folder, status)
    say(f"{sender}->{receiver}: {status['state']}" + (f", {reason}" if reason else ""))


EVIDENCE = ("itemsId", "registeredCheckpoint", "retrainedCheckpoint", "registeredResultSha256", "retrainedResultSha256",
            "retrainedCheckpointSha256")


def same_evidence(saved, now):
    """Whether a saved recipe decision was made from the results that are there now, and says
    what they say now."""
    return (all(saved.get(key) is not None and saved.get(key) == now.get(key) for key in EVIDENCE)
            and saved.get("fullSteps") is not None and saved.get("fullSteps") == now.get("fullSteps"))


def preflight(compare, repro, first, items_id, registered_id=None):
    """What must hold before any GPU work: the first pair's two results land in two different
    files, both run folders hold L2's item sets, the registered checkpoint's result is there
    and complete, and the first pair's harness inputs, from the same item set, are in the
    folder it is measured into. Raises ValueError with the reason."""
    from latent_compare.models import MAPPERS
    from latent_compare.run import fingerprint
    registered_id = registered_id or MAPPERS[first]["id"]
    # The files themselves, links resolved: two folder names can lead to one latent folder.
    if os.path.realpath(result_path(compare, *first)) == os.path.realpath(result_path(repro, *first)):
        raise ValueError("--compare and --repro are the same folder: the retrained first pair would overwrite the "
                         "registered checkpoint's result")
    for name, folder in (("--compare", compare), ("--repro", repro)):
        groups = load_json(os.path.join(folder, "items.json"))
        if not groups:
            raise ValueError(f"{name} ({folder}) has no readable items.json")
        if fingerprint(groups) != items_id:
            raise ValueError(f"{name} ({folder}) holds item set {fingerprint(groups)}, not L2's {items_id}")
        main = [item["id"] for item in groups.get("main", [])]
    for kind, key in (("summaries", first[0]), ("receive", first[1])):
        data = load_json(os.path.join(repro, kind, f"{key}.json"))
        if not data:
            raise ValueError(f"--repro has no {kind}/{key}.json: copy L2's summaries and receive folders into it, "
                             "so the retrained pair is compared with the same text arms")
        if data.get("itemsId") != items_id:
            raise ValueError(f"--repro's {kind}/{key}.json is from item set {data.get('itemsId')}, not L2's {items_id}")
    registered = load_json(result_path(compare, *first))
    if not registered:
        raise ValueError("--compare has no result of the registered checkpoint for the first pair")
    if registered.get("checkpoint") != registered_id or registered.get("itemsId") != items_id:
        raise ValueError(f"--compare's result for the first pair is from checkpoint {registered.get('checkpoint')} and item set "
                         f"{registered.get('itemsId')}, not the registered {registered_id} and L2's {items_id}")
    ran = sum(1 for item in main if "f1" in (registered.get("results", {}).get(item, {}).get("swat") or {}))
    if ran != len(main):
        raise ValueError(f"--compare's result of the registered checkpoint has `swat` on {ran} of {len(main)} main items")


def default_decide(root, compare, repro):
    from .report import recipe_decision   # the report reads the harness's files; kept out of the runner's start
    return recipe_decision(root, compare, repro)


def run_batch(root, compare, repro, pairs=None, budget=BUDGET_HOURS, runner=run_logged, decide=default_decide,
              say=lambda text: print(text, flush=True), batch=None, items_id=ITEMS_ID, registered_id=None):
    """Train and measure the pairs in order. `pairs` narrows the run to some of the batch;
    the budget and the recipe decision are always the whole batch's."""
    batch = list(batch or BATCH)
    first = batch[0]
    try:
        preflight(compare, repro, first, items_id, registered_id)
    except ValueError as error:
        say(f"not started: {error}")
        return
    for sender, receiver in (pairs or batch):
        used = hours_used(root, batch)
        if not within_budget(used, budget):
            say(f"{sender}->{receiver}: not started, {used:.1f} h of the {budget} h budget are used")
            continue
        if (sender, receiver) == first:
            # The check on the recipe is made with the recipe's own step counts.
            run_pair(root, repro, sender, receiver, False, runner, say, items_id)
            continue
        # The decision is made again from the results as they are now, every time. A saved
        # decision only stands while it was made from these same files (Codex review, round 2).
        try:
            now = decide(root, compare, repro)
        except ValueError as error:
            say(f"{sender}->{receiver}: not started, the recipe is not decided: {error}")
            return
        decision = load_json(os.path.join(root, RECIPE_FILE))
        if not decision:
            decision = now
            save_json(os.path.join(root, RECIPE_FILE), decision)
            say(f"recipe decided: {'adequate' if decision['adequate'] else 'not adequate, full M2b-S steps from here'}")
        elif not same_evidence(decision, now):
            say(f"{sender}->{receiver}: not started, recipe.json was decided from other results than the ones in the "
                "run folders now; settle which stand, then remove recipe.json to decide again")
            return
        run_pair(root, compare, sender, receiver, bool(decision["fullSteps"]), runner, say, items_id)


def parse_pairs(text):
    pairs = []
    for part in text.split(","):
        sender, _, receiver = part.strip().partition(":")
        if (sender, receiver) not in BATCH:
            raise ValueError(f"{part.strip()} is not a pair of the batch: " + ", ".join(f"{s}:{r}" for s, r in BATCH))
        pairs.append((sender, receiver))
    return pairs


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--root", required=True, help="folder for the pairs' training runs")
    parser.add_argument("--compare", required=True, help="latent_compare run folder the new pairs are measured into")
    parser.add_argument("--repro", required=True, help="latent_compare run folder for the retrained M2b-S pair")
    parser.add_argument("--pairs", help="comma-separated sender:receiver keys (default: the whole batch)")
    parser.add_argument("--budget-hours", type=float, default=BUDGET_HOURS)
    args = parser.parse_args()
    run_batch(os.path.expanduser(args.root), os.path.expanduser(args.compare), os.path.expanduser(args.repro),
              parse_pairs(args.pairs) if args.pairs else None, args.budget_hours)


if __name__ == "__main__":
    main()
