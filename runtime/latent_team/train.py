"""C13 levels 2 and 3: train the latent hand-off with the model frozen.

    python -m latent_team.train --model microsoft/Phi-3.5-mini-instruct --level adapter --mode soft --out runs/l2
    python -m latent_team.train --model microsoft/Phi-3.5-mini-instruct --level lora --mode soft --out runs/l3

One example is one GSM8K *train* question. The three latent subagents run exactly as in
latent_mas (same prompts, think() and chat turns), with gradients; then the solver turn is
read and the target is teacher-forced: the gold solution with its calculator annotations
<<...>> removed, its "#### N" line replaced by "The answer is N.", and the template's close
text, so the model also learns to stop. The loss is the cross-entropy of the target tokens
only (team.target_loss); prompts and latent positions are not scored.

Every base weight is frozen. Only the thought adapter (level adapter, adapter.py) and/or
the LoRA factors (level lora, lora.py) train, with AdamW, batch 1 and gradient
accumulation. Checkpoints hold only those weights:

    <out>/adapter/   adapter.pt + adapter.json   ->  evaluate.py --adapter <out>/adapter
    <out>/lora/      lora.pt + lora.json         ->  evaluate.py --lora <out>/lora
    <out>/train-log.json                             config, loss history, timings
    <out>/epoch-<k>/ the same after epoch k

Memory: backward keeps every latent step's attention inputs, and the KV cache is a new
tensor at each step, so the saved keys and values grow with steps x memory length (about
3-4 GB for Phi-3.5-mini at --steps 10, on top of 7.6 GB of bf16 weights and ~3 GB of
activations). --grad-agents 1 or 2 runs the earlier subagents without gradients (same
forward, shorter backward) if the full loop does not fit.

torch is imported lazily so target_text() can be tested where torch is missing.
"""
import argparse
import json
import math
import os
import random
import re
import time

LEVELS = ("adapter", "lora", "both")
TRAIN_MODES = ("soft", "aligned")  # random is the control: it is never trained
ANNOTATION = re.compile(r"<<[^>]*>>")


def target_text(solution, close):
    """The solver's teacher-forced target for one GSM8K solution."""
    body, sep, answer = solution.rpartition("####")
    if not sep:
        raise ValueError("a GSM8K solution ends with '#### N'")
    body = ANNOTATION.sub("", body).strip()
    answer = answer.strip()
    return f"{body}\nThe answer is {answer}.{close}" if body else f"The answer is {answer}.{close}"


def train_items(count, seed):
    """count questions of the GSM8K train split, shuffled by seed. Never the test split."""
    from .evaluate import gsm8k
    items = list(gsm8k("train"))
    if count < 1 or count > len(items):
        raise ValueError(f"--train-count must be between 1 and {len(items)}")
    random.Random(seed).shuffle(items)
    return items[:count]


def parser():
    p = argparse.ArgumentParser(prog="python -m latent_team.train", description=__doc__.split("\n\n")[0])
    p.add_argument("--model", default="microsoft/Phi-3.5-mini-instruct")
    p.add_argument("--level", choices=LEVELS, required=True)
    p.add_argument("--mode", choices=TRAIN_MODES, default="soft")
    p.add_argument("--steps", type=int, default=10, help="latent steps per subagent during training")
    p.add_argument("--train-count", type=int, default=2000, help="GSM8K train questions")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--weight-decay", type=float, default=0.0)
    p.add_argument("--rank", type=int, default=16, help="adapter rank")
    p.add_argument("--lora-rank", type=int, default=16)
    p.add_argument("--lora-alpha", type=float, default=32.0)
    p.add_argument("--lora-dropout", type=float, default=0.0,
                   help="0 keeps LoRA from saving its own copy of every projection input for backward")
    p.add_argument("--lora-targets", default=None,
                   help="comma list of module names or fnmatch patterns (default: lora.DEFAULT_TARGETS)")
    p.add_argument("--epochs", type=int, default=1)
    p.add_argument("--grad-accum", type=int, default=8, help="examples per optimizer step")
    p.add_argument("--max-grad-norm", type=float, default=1.0, help="0 turns clipping off")
    p.add_argument("--max-target-tokens", type=int, default=256,
                   help="examples whose target is longer are skipped, not cut (a cut target never stops)")
    p.add_argument("--grad-agents", type=int, default=3, choices=(1, 2, 3),
                   help="subagents (the last ones) that keep gradients; fewer bounds memory, 3 is the full loop")
    p.add_argument("--log-every", type=int, default=10, help="optimizer steps between log lines")
    p.add_argument("--device", default="cuda")
    p.add_argument("--out", required=True)
    return p


def rescale_remainder(params, grad_accum, pending):
    """An epoch's last, partial window: each loss was divided by grad_accum, so scale the
    summed gradients up to the mean over the `pending` examples actually in the window.
    Without this the last update is grad_accum / pending times too small (Codex review of 2d11edb)."""
    if not 0 < pending <= grad_accum:
        raise ValueError(f"pending {pending} is outside 1..{grad_accum}")
    for param in params:
        if param.grad is not None:
            param.grad.mul_(grad_accum / pending)


def check(args):
    problems = []
    if args.steps < 0:
        problems.append("--steps must be 0 or more")
    if args.steps == 0 and args.level == "adapter":
        # With no latent step the adapter is never called and nothing would train.
        problems.append("--level adapter needs --steps of at least 1")
    for name in ("rank", "lora_rank", "epochs", "grad_accum", "max_target_tokens", "log_every", "train_count"):
        if getattr(args, name) < 1:
            problems.append(f"--{name.replace('_', '-')} must be at least 1")
    if not args.lr > 0:
        problems.append("--lr must be above 0")
    if not 0 <= args.lora_dropout < 1:
        problems.append("--lora-dropout must be in [0, 1)")
    return problems


def setup(team, args):
    """Freeze the model and attach the trainable parts. Returns {name: [params]}."""
    import torch
    from .adapter import ThoughtAdapter
    from .lora import DEFAULT_TARGETS, inject_lora, lora_parameters

    for parameter in team.model.parameters():
        parameter.requires_grad_(False)
    torch.manual_seed(args.seed)
    groups = {}
    if args.level in ("adapter", "both"):
        dim = team.model.config.hidden_size
        out_dim = team.model.get_input_embeddings().weight.shape[1]
        team.adapter = ThoughtAdapter(dim, args.rank, out_dim).to(team.device)
        groups["adapter"] = list(team.adapter.parameters())
    if args.level in ("lora", "both"):
        targets = args.lora_targets.split(",") if args.lora_targets else DEFAULT_TARGETS
        inject_lora(team.model, targets, args.lora_rank, args.lora_alpha, args.lora_dropout)
        groups["lora"] = lora_parameters(team.model)
    for params in groups.values():
        for parameter in params:
            parameter.requires_grad_(True)
    return groups


def save_checkpoint(team, args, directory, extra=None):
    from .lora import lora_modules, save_lora
    meta = {"model": team.model_name, "trainedMode": args.mode, "trainedSteps": args.steps, **(extra or {})}
    if team.adapter is not None:
        team.adapter.save(os.path.join(directory, "adapter"), meta)
    if lora_modules(team.model):
        save_lora(team.model, os.path.join(directory, "lora"), meta)


def _write_json(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as handle:
        json.dump(value, handle, indent=1)
    os.replace(tmp, path)


def _print(line):
    print(line, flush=True)


def train(team, items, args, log=_print):
    """The training loop. Returns the training log (also written to <out>/train-log.json)."""
    import torch
    from .lora import set_lora_training

    groups = setup(team, args)
    params = [p for group in groups.values() for p in group]
    optimizer = torch.optim.AdamW(params, lr=args.lr, weight_decay=args.weight_decay)
    cuda = str(team.device).startswith("cuda")
    if cuda:
        torch.cuda.reset_peak_memory_stats()
    close = team.close_turn()
    from .team import IGNORE, LATENT_PROMPTS
    targets, kept, too_long = [], [], 0
    for item in items:
        text = target_text(item["solution"], close)
        prompt = LATENT_PROMPTS["solver"].format(question=item["question"])
        if int(team.target_batch([prompt], [text])[2].ne(IGNORE).sum()) > args.max_target_tokens:
            too_long += 1
            continue
        targets.append(text)
        kept.append(item)
    items = kept
    if not items:
        raise ValueError("every target is longer than --max-target-tokens")
    record = {"model": team.model_name, "config": {k: v for k, v in vars(args).items()},
              "chatTemplate": team.turns.as_dict(), "examples": len(items),
              "trainable": {name: sum(p.numel() for p in group) for name, group in groups.items()},
              "tooLong": too_long, "history": [], "epochs": [], "skipped": 0}
    log(json.dumps({"event": "start", "trainable": record["trainable"], "examples": len(items), "tooLong": too_long}))
    rng = random.Random(args.seed)
    order = list(range(len(items)))
    step, start = 0, time.perf_counter()
    window = []

    def optimizer_step():
        nonlocal step
        if args.max_grad_norm > 0:
            torch.nn.utils.clip_grad_norm_(params, args.max_grad_norm)
        optimizer.step()
        optimizer.zero_grad(set_to_none=True)
        step += 1
        if step % args.log_every == 0 and window:
            entry = {"step": step, "loss": round(sum(window) / len(window), 5), "examples": len(window),
                     "seconds": round(time.perf_counter() - start, 1)}
            if cuda:
                entry["peakMemoryGB"] = round(torch.cuda.max_memory_allocated() / 2 ** 30, 2)
            record["history"].append(entry)
            log(json.dumps(entry))
            window.clear()

    team.model.eval()
    for epoch in range(1, args.epochs + 1):
        rng.shuffle(order)
        if team.adapter is not None:
            team.adapter.train()
        set_lora_training(team.model, True)
        epoch_losses, pending = [], 0
        for index in order:
            loss = team.latent_loss([items[index]["question"]], [targets[index]], args.steps, mode=args.mode,
                                    grad_agents=args.grad_agents)
            value = float(loss.detach())
            if not math.isfinite(value):
                record["skipped"] += 1
                del loss
                continue
            (loss / args.grad_accum).backward()
            del loss  # the graph is freed by backward; drop the last reference before the next example
            epoch_losses.append(value)
            window.append(value)
            pending += 1
            if pending == args.grad_accum:
                optimizer_step()
                pending = 0
        if pending:
            rescale_remainder(params, args.grad_accum, pending)
            optimizer_step()
        if team.adapter is not None:
            team.adapter.eval()
        set_lora_training(team.model, False)
        summary = {"epoch": epoch, "meanLoss": round(sum(epoch_losses) / max(1, len(epoch_losses)), 5),
                   "steps": step, "seconds": round(time.perf_counter() - start, 1)}
        record["epochs"].append(summary)
        log(json.dumps({"event": "epoch", **summary}))
        save_checkpoint(team, args, os.path.join(args.out, f"epoch-{epoch}"), {"epoch": epoch})
        _write_json(os.path.join(args.out, f"epoch-{epoch}", "train-log.json"), record)
    record["seconds"] = round(time.perf_counter() - start, 1)
    if cuda:
        record["peakMemoryGB"] = round(torch.cuda.max_memory_allocated() / 2 ** 30, 2)
    save_checkpoint(team, args, args.out, {"epoch": args.epochs})
    _write_json(os.path.join(args.out, "train-log.json"), record)
    log(json.dumps({"event": "done", "out": args.out, "seconds": record["seconds"]}))
    return record


def main(argv=None, team=None, items=None, log=_print):
    """CLI. Tests pass a tiny team and items; a run loads the model and the train split."""
    p = parser()
    args = p.parse_args(argv)
    problems = check(args)
    if problems:
        p.error("; ".join(problems))
    if items is None:
        items = train_items(args.train_count, args.seed)
    else:
        items = list(items)[:args.train_count]
    if team is None:
        import torch
        from .team import LatentTeam
        team = LatentTeam(args.model, device=args.device, dtype=torch.bfloat16)
    return train(team, items, args, log=log)


if __name__ == "__main__":
    main()
