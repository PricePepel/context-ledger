"""M2b eval: SQuAD retention of a sender -> mapper -> receiver transfer.

    python -m latent_transfer.evaluate --checkpoint ckpt.pt --out report.json
    python -m latent_transfer.evaluate --conditions text,closed,t2t --out baseline.json

Conditions (same receiver, same question text):
  text    receiver prefills the passage itself           (upper reference)
  closed  no passage                                     (floor)
  swat    mapped sender cache of the passage             (the transfer)
  t2t     sender's summary of the passage, as text       (text-to-text baseline)

Gate (docs/m2b-transfer.md): retention = F1(swat)/F1(text) >= 0.90, and swat beats
closed with the bootstrap 95% interval of the difference above zero.
"""
import argparse
import json
import random
import time

import torch

from .data import closed_prompt, doc_text, f1, question_suffix, sample, squad, summary_prompt
from .pair import TransferPair

GATE_RETENTION = 0.90


def eval_items(pair, count, seed, max_tokens):
    """Fixed validation items whose passage fits max_tokens on both sides."""
    rows = sample(squad("validation"), count * 3, seed)
    items = []
    for row in rows:
        text = doc_text(row["context"])
        if len(pair.receiver_tok(text, add_special_tokens=False)["input_ids"]) > max_tokens:
            continue
        if len(pair.sender_tok(text, add_special_tokens=False)["input_ids"]) > max_tokens:
            continue
        items.append(row)
        if len(items) == count:
            break
    return items


def bootstrap(values_a, values_b, rounds=2000, seed=0):
    """95% interval of mean(a) - mean(b) over resampled items (paired)."""
    rng = random.Random(seed)
    n = len(values_a)
    diffs = []
    for _ in range(rounds):
        idx = [rng.randrange(n) for _ in range(n)]
        diffs.append(sum(values_a[i] - values_b[i] for i in idx) / n)
    diffs.sort()
    return diffs[int(0.025 * rounds)], diffs[int(0.975 * rounds)]


def run(pair, items, conditions, log_every=50):
    results = []
    for index, row in enumerate(items):
        document, suffix = doc_text(row["context"]), question_suffix(row["question"])
        record = {"id": row["id"], "question": row["question"], "answers": row["answers"]}
        if "text" in conditions:
            start = time.perf_counter()
            record["text"] = pair.answer_from_text(document, suffix)
            record["textMs"] = (time.perf_counter() - start) * 1000
        if "closed" in conditions:
            record["closed"] = pair.answer_closed(closed_prompt(row["question"]))
        if "swat" in conditions:
            start = time.perf_counter()
            record["swat"], record["receipt"] = pair.answer_from_sender(document, suffix)
            record["swatMs"] = (time.perf_counter() - start) * 1000
        if "t2t" in conditions:
            summary = pair.sender_generate(summary_prompt(row["context"]))
            record["summary"] = summary
            record["t2t"] = pair.answer_from_text(doc_text(summary), suffix)
        for condition in conditions:
            record[f"{condition}F1"] = f1(record[condition], row["answers"])
        results.append(record)
        if log_every and (index + 1) % log_every == 0:
            means = {c: round(sum(r[f"{c}F1"] for r in results) / len(results), 3) for c in conditions}
            print(f"{index + 1}/{len(items)} {means}", flush=True)
    return results


def summarize(results, conditions):
    mean = {c: sum(r[f"{c}F1"] for r in results) / len(results) for c in conditions}
    summary = {"items": len(results), "f1": {c: round(v, 4) for c, v in mean.items()}}
    if "text" in mean and mean["text"] > 0:
        for c in ("swat", "t2t"):
            if c in mean:
                summary[f"{c}Retention"] = round(mean[c] / mean["text"], 4)
                if "closed" in mean and mean["text"] > mean["closed"]:
                    summary[f"{c}Lift"] = round((mean[c] - mean["closed"]) / (mean["text"] - mean["closed"]), 4)
    if "swat" in mean and "closed" in mean:
        low, high = bootstrap([r["swatF1"] for r in results], [r["closedF1"] for r in results])
        summary["swatMinusClosed95"] = [round(low, 4), round(high, 4)]
    if "swat" in mean and "text" in mean:
        low, high = bootstrap([r["swatF1"] for r in results], [r["textF1"] for r in results])
        summary["swatMinusText95"] = [round(low, 4), round(high, 4)]
        receipts = [r["receipt"] for r in results]
        summary["meanMs"] = {
            "sender": round(sum(x["senderMs"] for x in receipts) / len(receipts), 2),
            "mapper": round(sum(x["mapperMs"] for x in receipts) / len(receipts), 2),
            "swatTotal": round(sum(r["swatMs"] for r in results) / len(results), 2),
            "textTotal": round(sum(r["textMs"] for r in results) / len(results), 2),
        }
        summary["gate"] = {
            "retention": summary.get("swatRetention", 0) >= GATE_RETENTION,
            "beatsClosed": "swatMinusClosed95" in summary and summary["swatMinusClosed95"][0] > 0,
        }
        summary["passed"] = all(summary["gate"].values())
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint")
    parser.add_argument("--conditions", default="text,closed,swat")
    parser.add_argument("--count", type=int, default=300)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--max-tokens", type=int, default=384)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    conditions = [c for c in args.conditions.split(",") if c]
    if "swat" in conditions and not args.checkpoint:
        parser.error("--checkpoint is required for the swat condition")
    torch.manual_seed(args.seed)
    pair = TransferPair(checkpoint=args.checkpoint)
    items = eval_items(pair, args.count, args.seed, args.max_tokens)
    results = run(pair, items, conditions)
    summary = summarize(results, conditions)
    summary["checkpoint"] = pair.checkpoint_id
    with open(args.out, "w") as handle:
        json.dump({"summary": summary, "results": results}, handle, indent=1)
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
