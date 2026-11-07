"""M2c eval: GSM8K accuracy, generated tokens and time for single / text_mas / latent_mas.

    python -m latent_team.evaluate --count 200 --out report.json
    python -m latent_team.evaluate --systems latent_mas --steps 0,20,40,80 --count 100 --out steps.json

Gate (docs/m2c-latent-team.md): latent_mas accuracy >= text_mas - 2 points, at least
50% fewer generated tokens than text_mas, and faster wall time.
"""
import argparse
import glob
import json
import os
import random
import re

import torch

from .team import LatentTeam

HUB = os.path.expanduser(os.environ.get("HF_HUB_CACHE", "~/.cache/huggingface/hub"))
NUMBER = re.compile(r"-?\d[\d,]*(?:\.\d+)?")


def gsm8k(split="test"):
    import pyarrow.parquet as pq
    files = sorted(glob.glob(os.path.join(HUB, "datasets--openai--gsm8k", "snapshots", "*", "main", f"{split}-*.parquet")))
    if not files:
        raise FileNotFoundError("GSM8K is not in the Hugging Face cache")
    rows = []
    for path in files:
        for row in pq.read_table(path).to_pylist():
            rows.append({"question": row["question"], "gold": gold_number(row["answer"])})
    return rows


def gold_number(answer):
    return to_number(answer.split("####")[-1])


def to_number(text, first=False):
    match = NUMBER.findall(text.replace("$", ""))
    if not match:
        return None
    try:
        return float(match[0 if first else -1].replace(",", "").rstrip("."))
    except ValueError:
        return None


def predicted_number(text):
    """The number after the last 'answer is', else in the last \\boxed{}, else the last number."""
    lowered = text.lower()
    if "answer is" in lowered:
        # "The answer is 7, not 72" answers 7: the first number after the phrase.
        return to_number(text[lowered.rindex("answer is"):], first=True)
    boxed = re.findall(r"\\boxed\{([^}]*)\}", text)
    if boxed:
        return to_number(boxed[-1], first=True)
    return to_number(text)


def correct(text, gold):
    value = predicted_number(text)
    return value is not None and gold is not None and abs(value - gold) < 1e-6


def run_system(team, system, items, batch, steps):
    results = []
    for start in range(0, len(items), batch):
        chunk = items[start:start + batch]
        questions = [item["question"] for item in chunk]
        if system == "latent_mas":
            answers, receipt = team.latent_mas(questions, steps=steps)
        elif system == "text_mas":
            answers, receipt = team.text_mas(questions)
        else:
            answers, receipt = team.single(questions)
        for item, answer, tokens in zip(chunk, answers, receipt.generated_tokens):
            results.append({"question": item["question"], "gold": item["gold"], "answer": answer,
                            "correct": correct(answer, item["gold"]), "tokens": tokens,
                            "seconds": receipt.seconds / len(chunk)})
        done = len(results)
        print(f"{system} m={steps}: {done}/{len(items)} acc={sum(r['correct'] for r in results) / done:.3f}", flush=True)
    return results


def summarize(results):
    n = len(results)
    return {"items": n, "accuracy": round(sum(r["correct"] for r in results) / n, 4),
            "meanTokens": round(sum(r["tokens"] for r in results) / n, 1),
            "secondsPerQuestion": round(sum(r["seconds"] for r in results) / n, 3)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="Qwen/Qwen2.5-3B-Instruct")
    parser.add_argument("--systems", default="single,text_mas,latent_mas")
    parser.add_argument("--steps", default="40", help="latent steps per subagent; a comma list sweeps them")
    parser.add_argument("--count", type=int, default=200)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    items = gsm8k("test")
    random.Random(args.seed).shuffle(items)
    items = items[:args.count]
    team = LatentTeam(args.model)
    team.single(["What is 1 + 1?"], max_new_tokens=4)  # warm-up, so the first batch's timing is fair
    report = {"model": args.model, "systems": {}}
    for system in args.systems.split(","):
        for steps in ([int(s) for s in args.steps.split(",")] if system == "latent_mas" else [0]):
            key = f"{system}@{steps}" if system == "latent_mas" else system
            results = run_system(team, system, items, args.batch, steps)
            report["systems"][key] = {"summary": summarize(results), "results": results}
            print(key, json.dumps(report["systems"][key]["summary"]), flush=True)
    summaries = {k: v["summary"] for k, v in report["systems"].items()}
    text, latents = summaries.get("text_mas"), {k: v for k, v in summaries.items() if k.startswith("latent_mas@")}
    if text and latents:
        gate = {}
        for key, latent in latents.items():
            gate[key] = {
                "accuracyWithin2": latent["accuracy"] >= text["accuracy"] - 0.02,
                "tokensHalved": latent["meanTokens"] <= 0.5 * text["meanTokens"],
                "faster": latent["secondsPerQuestion"] < text["secondsPerQuestion"],
            }
            gate[key]["passed"] = all(gate[key].values())
        report["gate"] = gate
    report["summaries"] = summaries
    with open(args.out, "w") as handle:
        json.dump(report, handle, indent=1)
    print(json.dumps({"summaries": summaries, "gate": report.get("gate")}, indent=1))


if __name__ == "__main__":
    main()
