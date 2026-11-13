"""C14 self-distillation: the frozen model's own correct answers as training targets.

    python -m latent_team.distill --model microsoft/Phi-3.5-mini-instruct --out targets.json
    python -m latent_team.train --level lora --targets targets.json ...

Cycle 13 trained on GSM8K's gold solutions, and LoRA lowered every system (single 0.855 to
0.730, answers 280 to 102 tokens): the loss could fall by copying the gold style, without
any help from the latent hand-off. Here the target is what the untrained model itself
writes for the train question, as the single system (greedy, SINGLE_PROMPT), kept only when
its number is right and it stopped on its own. The target is then close to the model's own
style, so there is less to gain from a change of style alone.

The questions are the same --train-count / --seed sample of the GSM8K *train* split that
train.py takes; the test split is never read. The output holds the train questions and the
model's answers: keep it out of the repository with the other run outputs.

torch is imported lazily so the target logic can be tested where torch is missing.
"""
import argparse
import json
import os

FORMAT = "latent-team-self-targets/1"


def keep(record, max_new_tokens):
    """A self answer is a target only if its number is right and it ended before the budget:
    a cut answer never shows the model how to stop."""
    return bool(record["correct"]) and record["tokens"] < max_new_tokens


def load_targets(path, model):
    """{question: answer} of the kept self answers in a distill.py file made with `model`.

    A file made with another model is refused: that would be distillation from a teacher,
    not self-distillation, and the cycle's claim would not hold."""
    with open(path) as handle:
        data = json.load(handle)
    if data.get("format") != FORMAT:
        raise ValueError(f"{path} is not a distill.py targets file")
    if data.get("model") != model:
        raise ValueError(f"{path} was made with {data.get('model')!r}, not {model!r}")
    budget = data["maxNewTokens"]
    return {r["question"]: r["answer"] for r in data["records"] if keep(r, budget)}


def distill(team, items, batch, max_new_tokens, log=print):
    """The single system's greedy answers to items, scored against their gold numbers."""
    from .evaluate import correct
    records = []
    for start in range(0, len(items), batch):
        chunk = items[start:start + batch]
        answers, receipt = team.single([item["question"] for item in chunk], max_new_tokens=max_new_tokens)
        for item, answer, tokens in zip(chunk, answers, receipt.generated_tokens):
            records.append({"question": item["question"], "gold": item["gold"], "answer": answer,
                            "correct": correct(answer, item["gold"]), "tokens": tokens})
        log(f"distill {len(records)}/{len(items)} kept={sum(keep(r, max_new_tokens) for r in records)}")
    return records


def parser():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--model", default="microsoft/Phi-3.5-mini-instruct")
    p.add_argument("--train-count", type=int, default=2000, help="GSM8K train questions, as in train.py")
    p.add_argument("--seed", type=int, default=0, help="the train.py shuffle seed")
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--max-new-tokens", type=int, default=512)
    p.add_argument("--device", default="cuda")
    p.add_argument("--out", required=True)
    return p


def main(argv=None, team=None, items=None, log=print):
    p = parser()
    args = p.parse_args(argv)
    for name in ("train_count", "batch", "max_new_tokens"):
        if getattr(args, name) < 1:
            p.error(f"--{name.replace('_', '-')} must be at least 1")
    from .train import train_items
    items = train_items(args.train_count, args.seed) if items is None else list(items)[:args.train_count]
    if team is None:
        import torch
        from .team import LatentTeam
        team = LatentTeam(args.model, device=args.device, dtype=torch.bfloat16)
    records = distill(team, items, args.batch, args.max_new_tokens, log=log)
    kept = sum(keep(r, args.max_new_tokens) for r in records)
    data = {"format": FORMAT, "model": team.model_name, "split": "train", "trainCount": args.train_count,
            "seed": args.seed, "maxNewTokens": args.max_new_tokens, "items": len(records),
            "correct": sum(bool(r["correct"]) for r in records), "kept": kept,
            "chatTemplate": team.turns.as_dict(), "records": records}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as handle:
        json.dump(data, handle, indent=1)
    log(json.dumps({"event": "done", "items": len(records), "correct": data["correct"], "kept": kept}))
    return data


if __name__ == "__main__":
    main()
