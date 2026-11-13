"""M2c eval: GSM8K accuracy, generated tokens and time for single / text_mas / latent_mas.

    python -m latent_team.evaluate --count 200 --out report.json
    python -m latent_team.evaluate --systems latent_mas --steps 0,20,40,80 --count 100 --out steps.json

Gate (docs/m2c-latent-team.md): latent_mas accuracy >= text_mas - 2 points, at least
50% fewer generated tokens than text_mas, and faster wall time.
"""
import argparse
import glob
import json
import math
import os
import random
import re

# latent_mas uses soft thoughts (our deviation); latent_aligned is the paper's W_a.
LATENT_MODES = {"latent_mas": "soft", "latent_aligned": "aligned", "latent_random": "random"}
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
        value = to_number(text[lowered.rindex("answer is"):], first=True)
        if value is not None:
            return value
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
        capped = [0] * len(chunk)
        if system in LATENT_MODES:
            answers, receipt = team.latent_mas(questions, steps=steps, mode=LATENT_MODES[system])
        elif system == "text_mas":
            answers, receipt = team.text_mas(questions)
            capped = team.capped
        else:
            answers, receipt = team.single(questions)
        for row, (item, answer, tokens) in enumerate(zip(chunk, answers, receipt.generated_tokens)):
            # Batch time is set by the longest row; per question it is the batch time / rows.
            results.append({"question": item["question"], "gold": item["gold"], "answer": answer,
                            "correct": correct(answer, item["gold"]), "tokens": tokens,
                            "latentVectors": receipt.latent_vectors, "cappedAgents": capped[row],
                            "seconds": receipt.seconds / len(chunk)})
        done = len(results)
        print(f"{system} m={steps}: {done}/{len(items)} acc={sum(r['correct'] for r in results) / done:.3f}", flush=True)
    return results


def summarize(results):
    n = len(results)
    return {"items": n, "accuracy": round(sum(r["correct"] for r in results) / n, 4),
            "meanTokens": round(sum(r["tokens"] for r in results) / n, 1),
            # Latent steps are forward passes without a token; reported so the token
            # saving is read next to the compute it still costs.
            "meanLatentVectors": round(sum(r["latentVectors"] for r in results) / n, 1),
            "meanForwardSteps": round(sum(r["tokens"] + r["latentVectors"] for r in results) / n, 1),
            "cappedAgentShare": round(sum(r["cappedAgents"] for r in results) / (3 * n), 4),
            "secondsPerQuestion": round(sum(r["seconds"] for r in results) / n, 3)}


def paired_interval(a, b, rounds=2000, seed=0):
    """95% bootstrap interval of accuracy(a) - accuracy(b) over the same questions."""
    rng = random.Random(seed)
    n = len(a)
    diffs = sorted(sum(a[i]["correct"] - b[i]["correct"] for i in (rng.randrange(n) for _ in range(n))) / n
                   for _ in range(rounds))
    return [round(diffs[int(0.025 * rounds)], 4), round(diffs[int(0.975 * rounds)], 4)]


def mcnemar(a, b):
    """Exact two-sided McNemar test of a against b over the same questions.

    Returns {aOnly, bOnly, p}: questions only a got right, only b got right, and the
    binomial p-value of that split under "no difference" (cycle 13's primary test)."""
    if len(a) != len(b):
        raise ValueError("mcnemar needs the same questions on both sides")
    a_only = sum(1 for x, y in zip(a, b) if x["correct"] and not y["correct"])
    b_only = sum(1 for x, y in zip(a, b) if y["correct"] and not x["correct"])
    n, k = a_only + b_only, min(a_only, b_only)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n if n else 1.0
    return {"aOnly": a_only, "bOnly": b_only, "p": round(min(1.0, 2 * tail), 4)}


def sample_block(items, count, seed, block=0):
    """Questions block*count to (block+1)*count - 1 of one shuffle by seed.

    Blocks of one seed never share a question, and block 0 is the sample that --seed alone
    took before (PR #7 review: seeds 0 and 1 shared 30 of their 200 questions)."""
    if count < 1 or block < 0 or (block + 1) * count > len(items):
        raise ValueError(f"block {block} of {count} questions is outside the {len(items)} available")
    shuffled = list(items)
    random.Random(seed).shuffle(shuffled)
    return shuffled[block * count:(block + 1) * count]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="Qwen/Qwen2.5-3B-Instruct")
    parser.add_argument("--systems", default="single,text_mas,latent_mas")
    parser.add_argument("--steps", default="40", help="latent steps per subagent; a comma list sweeps them")
    parser.add_argument("--count", type=int, default=200)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--block", type=int, default=0,
                        help="which block of --count questions of the --seed shuffle; blocks are disjoint")
    parser.add_argument("--soft-top-k", type=int, default=None,
                        help="tokens mixed into a soft thought (default: LatentTeam.soft_top_k, 16)")
    parser.add_argument("--soft-temperature", type=float, default=None,
                        help="softmax temperature of a soft thought (default: LatentTeam.soft_temperature, 1.0)")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.soft_top_k is not None and args.soft_top_k < 1:
        parser.error("--soft-top-k must be at least 1")
    if args.soft_temperature is not None and not args.soft_temperature > 0:
        parser.error("--soft-temperature must be above 0")
    items = sample_block(gsm8k("test"), args.count, args.seed, args.block)
    from .team import LatentTeam  # torch is only needed to run the models, not to score answers
    team = LatentTeam(args.model)
    if args.soft_top_k is not None:
        team.soft_top_k = args.soft_top_k
    if args.soft_temperature is not None:
        team.soft_temperature = args.soft_temperature
    # Warm-up at the real batch size, so the first system does not pay kernel set-up costs.
    warm = [item["question"] for item in items[:args.batch]]
    team.single(warm, max_new_tokens=8)
    team.latent_mas(warm, steps=2, max_new_tokens=8)
    # The turn texts come from the model's chat template; recorded so runs on different
    # families can be read side by side.
    report = {"model": args.model, "sample": {"seed": args.seed, "block": args.block, "count": args.count},
              "soft": {"topK": team.soft_top_k, "temperature": team.soft_temperature},
              "chatTemplate": team.turns.as_dict(), "stopTokenIds": sorted(team.eos), "systems": {}}
    for system in args.systems.split(","):
        latent = system in LATENT_MODES
        for steps in ([int(s) for s in args.steps.split(",")] if latent else [0]):
            key = f"{system}@{steps}" if latent else system
            results = run_system(team, system, items, args.batch, steps)
            report["systems"][key] = {"summary": summarize(results), "results": results}
            print(key, json.dumps(report["systems"][key]["summary"]), flush=True)
    summaries = {k: v["summary"] for k, v in report["systems"].items()}
    text, latents = summaries.get("text_mas"), {k: v for k, v in summaries.items() if k.startswith("latent_mas@")}
    if text and latents:
        gate = {}
        for key, latent in latents.items():
            gate[key + " minus text_mas (95%)"] = paired_interval(report["systems"][key]["results"],
                                                                   report["systems"]["text_mas"]["results"])
            gate[key] = {
                "accuracyWithin2": latent["accuracy"] >= text["accuracy"] - 0.02,
                "tokensHalved": latent["meanTokens"] <= 0.5 * text["meanTokens"],
                "faster": latent["secondsPerQuestion"] < text["secondsPerQuestion"],
            }
            gate[key]["passed"] = all(gate[key].values())
        report["gate"] = gate
    # Cycle 13's primary test: each latent mode against the random control at the same steps.
    controls = {}
    for key in report["systems"]:
        system, _, steps = key.partition("@")
        control = f"latent_random@{steps}"
        if system in LATENT_MODES and system != "latent_random" and control in report["systems"]:
            controls[f"{key} vs {control}"] = mcnemar(report["systems"][key]["results"],
                                                      report["systems"][control]["results"])
    if controls:
        report["vsRandom"] = controls
    report["summaries"] = summaries
    with open(args.out, "w") as handle:
        json.dump(report, handle, indent=1)
    print(json.dumps({"summaries": summaries, "gate": report.get("gate"), "vsRandom": report.get("vsRandom")}, indent=1))


if __name__ == "__main__":
    main()
