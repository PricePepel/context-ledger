"""Train and measure a list of pairs, one after another, on one GPU.

    python -m latent_pairs.run --root ~/l5-mappers --compare ~/l5-mappers/compare --pairs phi3.5:qwen1.5

Each pair gets a folder under --root with the training log, the checkpoints and a
status.json. A pair that is already measured or has failed is left alone, so the command
can be run again after an interruption; a pair cut off in stage 2 starts stage 2 again from
its stage 1 checkpoint. No new pair starts once the pairs so far have used the budget.
Standard library only: training and measuring run as their own processes, so the GPU is
empty between them.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

from .plan import BATCH, BUDGET_HOURS, out_of_memory, pair_name, recipe, train_args, within_budget

STATUS = "status.json"


def load_status(folder):
    try:
        with open(os.path.join(folder, STATUS), encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_status(folder, status):
    os.makedirs(folder, exist_ok=True)
    target = os.path.join(folder, STATUS)
    with open(target + ".tmp", "w", encoding="utf-8") as handle:
        json.dump(status, handle, indent=1)
    os.replace(target + ".tmp", target)


def hours_used(root, pairs):
    """GPU hours the given pairs have used so far (training and measuring)."""
    seconds = 0.0
    for sender, receiver in pairs:
        status = load_status(os.path.join(root, pair_name(sender, receiver)))
        seconds += status.get("trainSeconds", 0) + status.get("evalSeconds", 0)
    return seconds / 3600


def finished(folder):
    """Whether the training log of a folder ends with its `done` event."""
    try:
        with open(os.path.join(folder, "log.jsonl"), encoding="utf-8") as handle:
            lines = [line for line in handle if line.strip()]
    except FileNotFoundError:
        return False
    return bool(lines) and json.loads(lines[-1]).get("event") == "done"


def tail(path, size=4000):
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - size))
            return handle.read().decode("utf-8", "replace")
    except FileNotFoundError:
        return ""


def run_logged(command, log_path):
    """Run a command with its output appended to log_path. Returns (exit code, seconds)."""
    started = time.time()
    with open(log_path, "ab") as handle:
        code = subprocess.run(command, stdout=handle, stderr=subprocess.STDOUT, check=False,
                              env={**os.environ, "PYTHONUNBUFFERED": "1",
                                   # fewer stranded blocks when batch shapes change every step
                                   "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}).returncode
    return code, time.time() - started


def train(folder, sender, receiver, status, full_steps, runner=run_logged):
    """Train one pair, with the one small-batch retry after running out of memory.
    Returns None when it finished, else the reason it did not."""
    for small in ([True] if status.get("smallBatches") else [False, True]):
        settings = recipe(full_steps=full_steps, small_batches=small)
        stage1 = os.path.join(folder, "stage1.pt")
        resume = stage1 if os.path.exists(stage1) else None
        command = [sys.executable, "-m", "latent_transfer.train", *train_args(sender, receiver, folder, settings, resume)]
        status.update({"state": "training", "settings": settings, "smallBatches": small})
        save_status(folder, status)
        code, seconds = runner(command, os.path.join(folder, "train.out"))
        status["trainSeconds"] = status.get("trainSeconds", 0) + seconds
        if code == 0 and finished(folder):
            return None
        output = tail(os.path.join(folder, "train.out"))
        if small or not out_of_memory(output):
            return ("out of GPU memory at the small batches too" if out_of_memory(output)
                    else f"training exited with code {code}: {output.strip().splitlines()[-1][:300] if output.strip() else 'no output'}")
        # Out of memory at the recipe's batches: keep the first attempt's files aside and retry once.
        aside = os.path.join(folder, "attempt1")
        os.makedirs(aside, exist_ok=True)
        for name in ("log.jsonl", "train.out", "stage1.pt", "best.pt", "last.pt"):
            if os.path.exists(os.path.join(folder, name)):
                shutil.move(os.path.join(folder, name), os.path.join(aside, name))
        status["retriedAfterOutOfMemory"] = True
    return "training did not finish"


def measure(folder, sender, receiver, compare, status, runner=run_logged):
    """Run latent_compare's latent phase on the pair's best checkpoint."""
    command = [sys.executable, "-m", "latent_pairs.evaluate", "--pair", f"{sender}:{receiver}",
               "--checkpoint", os.path.join(folder, "best.pt"), "--out", compare]
    status["state"] = "measuring"
    save_status(folder, status)
    code, seconds = runner(command, os.path.join(folder, "eval.out"))
    status["evalSeconds"] = status.get("evalSeconds", 0) + seconds
    if code != 0:
        output = tail(os.path.join(folder, "eval.out")).strip()
        return f"measuring exited with code {code}: {output.splitlines()[-1][:300] if output else 'no output'}"
    return None


def run_pairs(root, compare, pairs, budget=BUDGET_HOURS, full_steps=False, budget_pairs=None, runner=run_logged,
              say=lambda text: print(text, flush=True)):
    """Train and measure each pair in order. budget_pairs are the pairs whose time counts
    against the budget (the whole batch, also when this call runs only some of it)."""
    budget_pairs = budget_pairs or pairs
    for sender, receiver in pairs:
        folder = os.path.join(root, pair_name(sender, receiver))
        status = load_status(folder)
        if status.get("state") in ("measured", "failed"):
            say(f"{sender}->{receiver}: already {status['state']}")
            continue
        used = hours_used(root, budget_pairs)
        if not within_budget(used, budget):
            say(f"{sender}->{receiver}: not started, {used:.1f} h of the {budget} h budget are used")
            continue
        status.update({"sender": sender, "receiver": receiver, "fullSteps": full_steps})
        if not finished(folder):
            say(f"{sender}->{receiver}: training")
            reason = train(folder, sender, receiver, status, full_steps, runner)
            if reason:
                status.update({"state": "failed", "reason": reason})
                save_status(folder, status)
                say(f"{sender}->{receiver}: failed, {reason}")
                continue
        say(f"{sender}->{receiver}: measuring")
        reason = measure(folder, sender, receiver, compare, status, runner)
        # A pair whose measurement failed is tried again on the next call: its mapper exists.
        status.update({"state": "trained", "reason": reason} if reason else {"state": "measured", "reason": None})
        save_status(folder, status)
        say(f"{sender}->{receiver}: {status['state']}" + (f", {reason}" if reason else ""))


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
    parser.add_argument("--compare", required=True, help="latent_compare run folder to measure into")
    parser.add_argument("--pairs", help="comma-separated sender:receiver keys (default: the whole batch)")
    parser.add_argument("--budget-hours", type=float, default=BUDGET_HOURS)
    parser.add_argument("--full-steps", action="store_true", help="the M2b-S step counts instead of half")
    args = parser.parse_args()
    pairs = parse_pairs(args.pairs) if args.pairs else list(BATCH)
    run_pairs(os.path.expanduser(args.root), os.path.expanduser(args.compare), pairs, args.budget_hours,
              args.full_steps, budget_pairs=list(BATCH))


if __name__ == "__main__":
    main()
