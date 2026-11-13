"""C15: latent teams of many agents, and a split-facts test of the hand-off.

    python -m latent_team.scale --part scale --agents 3,11,31,101 --out scale.json
    python -m latent_team.scale --part split --agents 3,11 --out split.json

Part scale (every agent sees the whole question):
    single            one model, greedy
    latent_mas@N      N thinking agents in a chain (team.chain_roles) and the solver, soft thoughts
    latent_random@N   the same with random thoughts at the soft norm (the control)
    vote@N            N sampled single answers, majority number: the same many calls, no hand-off
    text_mas@N        N text agents (only for --text-agents: text grows fast)

Part split (the facts are dealt out; only the hand-off can bring them to the solver):
    single_full       one model with the whole question (upper bound)
    alone             one model with only the question sentence, no facts (lower bound)
    latent_sealed@N   facts dealt round robin to N thinkers; the solver sees only the question
                      sentence; earlier prompts are hidden (team.chain sealed), so only the
                      latent steps pass on
    random_sealed@N   the same with random thoughts. Not an empty hand-off: the keys and values
                      at a thinker's latent positions were computed reading its own prompt, so
                      they can carry facts with any thought vector. `alone` is the no-hand-off floor
    latent_open@N     as latent_sealed but unsealed: the facts can also be read from the
                      earlier agents' prompts in the shared memory
    random_open@N     its control
    text_mas@N        the facts dealt to N text agents; only their notes reach the solver

Results are written after every system, so a long run that stops keeps what it finished.
"""
import argparse
import json
import os
import re
import time
from collections import Counter

from .evaluate import correct, gsm8k, mcnemar, predicted_number, sample_block, summarize

SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9$])")


def split_question(question):
    """(facts, ask) of a GSM8K question: the sentences before the last, and the last one.
    None when fewer than two facts come before it, so there is nothing to deal out."""
    sentences = [s.strip() for s in SENTENCE.split(question.strip()) if s.strip()]
    if len(sentences) < 3:
        return None
    return sentences[:-1], sentences[-1]


def deal(facts, ask, agents):
    """What each of `agents` thinkers sees: fact j goes to agent j mod agents, then the ask.
    With more agents than facts the later agents see the ask alone."""
    hands = [[] for _ in range(agents)]
    for index, fact in enumerate(facts):
        hands[index % agents].append(fact)
    return [" ".join(hand + [ask]) for hand in hands]


def tally(texts):
    """The most common predicted number of the texts (first seen wins a tie), or None."""
    numbers = [n for n in (predicted_number(t) for t in texts) if n is not None]
    return Counter(numbers).most_common(1)[0][0] if numbers else None


def systems_for(part, agents, text_agents):
    out = []
    if part == "scale":
        out.append({"key": "single", "kind": "single"})
        for n in agents:
            out += [{"key": f"latent_mas@{n}", "kind": "latent", "mode": "soft", "agents": n},
                    {"key": f"latent_random@{n}", "kind": "latent", "mode": "random", "agents": n},
                    {"key": f"vote@{n}", "kind": "vote", "agents": n}]
            if n in text_agents:
                out.append({"key": f"text_mas@{n}", "kind": "text", "agents": n})
    else:
        out += [{"key": "single_full", "kind": "single"}, {"key": "alone", "kind": "alone"}]
        for n in agents:
            for sealed in (True, False):
                word = "sealed" if sealed else "open"
                out += [{"key": f"latent_{word}@{n}", "kind": "latent", "mode": "soft", "agents": n, "sealed": sealed},
                        {"key": f"random_{word}@{n}", "kind": "latent", "mode": "random", "agents": n, "sealed": sealed}]
            if n in text_agents:
                out.append({"key": f"text_mas@{n}", "kind": "text", "agents": n})
    return out


def run(team, spec, items, batch, steps, split, args):
    """One system over the items. Returns per-question results like evaluate.run_system."""
    results = []
    size = batch
    if spec["kind"] == "vote":
        size = max(1, args.vote_rows // spec["agents"])  # questions per call; rows = questions x samples
    for start in range(0, len(items), size):
        chunk = items[start:start + size]
        questions = [item["question"] for item in chunk]
        views = solver = None
        if split:
            parts = [split_question(q) for q in questions]
            solver = [ask for _, ask in parts]
            if spec["kind"] in ("latent", "text"):
                hands = [deal(facts, ask, spec["agents"]) for facts, ask in parts]
                views = [[hand[k] for hand in hands] for k in range(spec["agents"])]
        vectors, extra = 0, [{} for _ in chunk]
        if spec["kind"] == "single":
            answers, receipt = team.single(questions)
        elif spec["kind"] == "alone":
            answers, receipt = team.single(solver)
        elif spec["kind"] == "latent":
            answers, receipt = team.latent_mas(questions, steps=steps, mode=spec["mode"], agents=spec["agents"],
                                               views=views, solver_questions=solver, sealed=spec.get("sealed", False))
            vectors = receipt.latent_vectors
        elif spec["kind"] == "text":
            answers, receipt = team.text_mas(questions, agents=spec["agents"], views=views, solver_questions=solver)
            extra = [{"cappedAgents": c} for c in team.capped]
        else:
            groups, receipt = team.sample(questions, spec["agents"], temperature=args.vote_temperature,
                                          rows=args.vote_rows, seed=args.seed + start)
            answers = []
            for texts, row in zip(groups, extra):
                winner = tally(texts)
                row["votes"] = [predicted_number(t) for t in texts]
                answers.append("" if winner is None else f"The answer is {winner:g}.")
        for item, answer, tokens, more in zip(chunk, answers, receipt.generated_tokens, extra):
            results.append({"question": item["question"], "gold": item["gold"], "answer": answer,
                            "correct": correct(answer, item["gold"]), "tokens": tokens, "latentVectors": vectors,
                            "cappedAgents": more.pop("cappedAgents", 0), "seconds": receipt.seconds / len(chunk),
                            **more})
        print(f"{spec['key']}: {len(results)}/{len(items)} acc={sum(r['correct'] for r in results) / len(results):.3f}",
              flush=True)
    return results


def comparisons(report):
    """McNemar of each latent system against its random control, and against vote and single."""
    systems, out = report["systems"], {}
    pairs = []
    for key in systems:
        name, _, n = key.partition("@")
        if name == "latent_mas":
            pairs += [(key, f"latent_random@{n}"), (key, f"vote@{n}"), (key, "single")]
        elif name in ("latent_sealed", "latent_open"):
            pairs += [(key, key.replace("latent_", "random_")), (key, "alone"), (key, f"text_mas@{n}")]
    for a, b in pairs:
        if b in systems:
            out[f"{a} vs {b}"] = mcnemar(systems[a]["results"], systems[b]["results"])
    return out


def parser():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--model", default="Qwen/Qwen2.5-3B-Instruct")
    p.add_argument("--part", choices=("scale", "split"), required=True)
    p.add_argument("--agents", default="3,11,31,101", help="thinking agents per team, a comma list")
    p.add_argument("--text-agents", default="3,11", help="team sizes that also run the text team")
    p.add_argument("--only", default=None, help="comma list of system keys to run (default: all of the part)")
    p.add_argument("--steps", type=int, default=40, help="latent steps per thinking agent")
    p.add_argument("--count", type=int, default=200)
    p.add_argument("--block", type=int, default=4)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--vote-temperature", type=float, default=0.7)
    p.add_argument("--vote-rows", type=int, default=96, help="sampled answers per forward batch")
    p.add_argument("--out", required=True)
    return p


def main(argv=None, team=None, items=None):
    args = parser().parse_args(argv)
    agents = [int(n) for n in args.agents.split(",")]
    text_agents = {int(n) for n in args.text_agents.split(",")} if args.text_agents else set()
    if min(agents) < 1 or args.steps < 0 or args.batch < 1 or args.vote_rows < 1 or not args.vote_temperature > 0:
        raise SystemExit("--agents, --batch and --vote-rows must be at least 1, --steps at least 0, "
                         "--vote-temperature above 0")
    if items is None:
        items = sample_block(gsm8k("test"), args.count, args.seed, args.block)
    split = args.part == "split"
    excluded = 0
    if split:
        kept = [item for item in items if split_question(item["question"])]
        excluded, items = len(items) - len(kept), kept
    specs = systems_for(args.part, agents, text_agents)
    if args.only:
        wanted = set(args.only.split(","))
        unknown = wanted - {s["key"] for s in specs}
        if unknown:
            raise SystemExit(f"unknown systems for --part {args.part}: {sorted(unknown)}")
        specs = [s for s in specs if s["key"] in wanted]
    if team is None:
        from .team import LatentTeam
        team = LatentTeam(args.model)
        warm = [item["question"] for item in items[:args.batch]]
        team.single(warm, max_new_tokens=8)
        team.latent_mas(warm, steps=2, max_new_tokens=8)
    import torch
    cuda = str(team.device).startswith("cuda")
    report = {"model": args.model, "part": args.part, "steps": args.steps, "agents": agents,
              "sample": {"seed": args.seed, "block": args.block, "count": args.count, "items": len(items),
                         "excludedTooFewFacts": excluded},
              "vote": {"temperature": args.vote_temperature, "rows": args.vote_rows},
              "soft": {"topK": team.soft_top_k, "temperature": team.soft_temperature},
              "chatTemplate": team.turns.as_dict(), "systems": {}}
    for spec in specs:
        if cuda:
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
        began = time.perf_counter()
        results = run(team, spec, items, args.batch, args.steps, split, args)
        summary = summarize(results)
        summary["wallSeconds"] = round(time.perf_counter() - began, 1)
        # summarize() divides by three agents; a text team of N agents has N turns per question.
        summary["cappedAgentShare"] = round(sum(r["cappedAgents"] for r in results) /
                                            (spec.get("agents", 3) * len(results)), 4)
        if cuda:
            summary["peakMemoryGB"] = round(torch.cuda.max_memory_allocated() / 2 ** 30, 2)
        report["systems"][spec["key"]] = {"spec": spec, "summary": summary, "results": results}
        report["vsControls"] = comparisons(report)
        report["summaries"] = {k: v["summary"] for k, v in report["systems"].items()}
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out + ".tmp", "w") as handle:
            json.dump(report, handle, indent=1)
        os.replace(args.out + ".tmp", args.out)
        print(spec["key"], json.dumps(summary), flush=True)
    print(json.dumps({"summaries": report["summaries"], "vsControls": report["vsControls"]}, indent=1))
    return report


if __name__ == "__main__":
    main()
