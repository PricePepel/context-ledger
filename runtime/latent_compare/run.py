"""L2 cross-model comparison: one question set, N models, the same arms.

    python -m latent_compare.run all --out ~/l2-compare/run1
    python -m latent_compare.run all --out DIR --models qwen1.5,phi3.5     # a subset
    python -m latent_compare.run summaries --model phi3.5 --out DIR        # one phase
    python -m latent_compare.run report --out DIR                          # tables only, no GPU

Phases, each saving one file under --out so a stopped run resumes where it was:
  items      the main set and the edge-case groups (tokenizers only)
  summaries  one model writes the summary of every passage        summaries/<model>.json
  receive    one model answers: text, closed, its own cache handed over, and every
             sender's summary                                      receive/<model>.json
  latent     a pair with a trained mapper: mapped cache and its controls   latent/<s>__<r>.json
  report     tables and intervals                                  summary.json, report.md

One model is on the GPU at a time (two in the latent phase). Run from runtime/.
"""
import argparse
import json
import os
import time

from . import items as item_sets
from .models import MAPPERS, MODELS, keys
from .prompts import SYSTEM_TEXT
from .report import build_summary, render_markdown
from .stats import kv_bytes, score

FIT_TOKENS = 384       # main-set passages fit this on every tokenizer (the M2b-S eval's cap)
LONG_CONTEXT = 2048    # the context the long_passage group runs at
SUMMARY_GROUPS = ("main", "long_passage", "tiny_passage", "non_english_emoji", "unanswerable")
LATENT_GROUPS = ("main", "long_passage", "tiny_passage", "non_english_emoji")


def path(out, *parts):
    target = os.path.join(out, *parts)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    return target


def load(target):
    with open(target, encoding="utf-8") as handle:
        return json.load(handle)


def save(target, data):
    with open(target + ".tmp", "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=1)
    os.replace(target + ".tmp", target)


def guarded(record, arm, work):
    """Run one arm; an error becomes the arm's record instead of stopping the run."""
    try:
        record[arm] = work()
    except Exception as error:  # noqa: BLE001 - the report counts and names these
        if "out of memory" in str(error).lower():
            raise
        record[arm] = {"error": f"{type(error).__name__}: {str(error)[:200]}"}


def limit_for(item):
    return LONG_CONTEXT if item["group"] == "long_passage" else None


# Phases -------------------------------------------------------------------
def phase_items(out, seed=0, force=False):
    target = path(out, "items.json")
    if os.path.exists(target) and not force:
        return load(target)
    from transformers import AutoTokenizer

    from latent_transfer.data import squad
    # Every registered tokenizer, whichever models this run uses, so the set never changes.
    tokenizers = [AutoTokenizer.from_pretrained(spec["id"]) for spec in MODELS.values()]

    def fits(passage):
        return all(len(tok(passage, add_special_tokens=False)["input_ids"]) <= FIT_TOKENS for tok in tokenizers)

    groups = item_sets.build(squad("validation"), fits, seed)
    save(target, groups)
    print("items", {name: len(rows) for name, rows in groups.items()}, flush=True)
    return groups


def phase_summaries(out, key, groups, force=False):
    target = path(out, "summaries", f"{key}.json")
    if os.path.exists(target) and not force:
        return
    from .engine import SUMMARY_TOKENS, Engine
    engine = Engine(key)
    engine.timed(engine.summary_ids("Warm-up passage.")[0], 4)
    records, started = {}, time.time()
    for group in SUMMARY_GROUPS:
        for item in groups[group]:
            record = {}

            def work(item=item):
                ids, info = engine.summary_ids(item["passage"], limit_for(item))
                result = engine.timed(ids, SUMMARY_TOKENS)
                return {"summary": result["answer"], "ms": result["ms"], "newTokens": result["newTokens"],
                        "bytes": len(result["answer"].encode("utf-8")), **info}
            guarded(record, "summary", work)
            records[item["id"]] = record["summary"]
        print(f"summaries {key} {group} done {time.time() - started:.0f}s", flush=True)
    save(target, {"model": engine.describe(), "summaries": records})
    engine.close()


def answer_record(engine, item, prepared, result):
    return {**result, **score(result["answer"], item),
            **{name: prepared[name] for name in ("promptTokens", "passageTokens", "keptTokens", "truncated")}}


def phase_receive(out, key, groups, senders, force=False):
    target = path(out, "receive", f"{key}.json")
    if os.path.exists(target) and not force:
        return
    from .engine import Engine
    summaries = {}
    for sender in senders:
        source = os.path.join(out, "summaries", f"{sender}.json")
        if os.path.exists(source):
            summaries[sender] = load(source)["summaries"]
    engine = Engine(key)
    warm = engine.prepare("Warm-up passage.", "Warm-up?")
    engine.timed(warm["ids"], 2)
    engine.answer_from_cache(warm)
    results, started = {}, time.time()
    for group, rows in groups.items():
        system = SYSTEM_TEXT if group == "no_system_role" else None
        for item in rows:
            record = {}
            abstain, limit = item_sets.uses_abstain(item), limit_for(item)

            def read(passage, item=item, abstain=abstain, limit=limit, system=system):
                return engine.prepare(passage, item["question"], abstain, system, limit)

            def text(read=read, item=item):
                prepared = read(item["passage"])
                return {**answer_record(engine, item, prepared, engine.timed(prepared["ids"])),
                        "bytes": prepared["passageBytes"]}

            def self_cache(read=read, item=item):
                prepared = read(item["passage"])
                return answer_record(engine, item, prepared, engine.answer_from_cache(prepared))

            guarded(record, "text", text)
            guarded(record, "self_cache", self_cache)
            if group == "main":
                def closed(item=item):
                    result = engine.timed(engine.closed_ids(item["question"]))
                    return {**result, **score(result["answer"], item), "bytes": 0}
                guarded(record, "closed", closed)
            if group != "no_system_role":
                for sender in (senders if group == "main" else [key]):
                    summary = summaries.get(sender, {}).get(item["id"])
                    if summary is None:
                        continue

                    def t2t(summary=summary, read=read, item=item):
                        if "error" in summary:
                            raise ValueError(f"The sender's summary failed: {summary['error']}")
                        prepared = read(summary["summary"])
                        result = engine.timed(prepared["ids"])
                        # End to end: the sender writes the summary, then the receiver answers.
                        return {**answer_record(engine, item, prepared, result), "bytes": summary["bytes"],
                                "receiverMs": result["ms"], "ms": result["ms"] + summary["ms"]}
                    guarded(record, f"t2t:{sender}", t2t)
            results[item["id"]] = record
        print(f"receive {key} {group} done {time.time() - started:.0f}s", flush=True)
    save(target, {"model": engine.describe(), "results": results})
    engine.close()


def phase_latent(out, sender, receiver, groups, force=False):
    target = path(out, "latent", f"{sender}__{receiver}.json")
    if os.path.exists(target) and not force:
        return
    checkpoint = os.path.expanduser(MAPPERS[(sender, receiver)]["checkpoint"])
    if not os.path.exists(checkpoint):
        save(target, {"skipped": f"The mapper checkpoint {MAPPERS[(sender, receiver)]['checkpoint']} is not on this machine."})
        return
    import torch

    from latent_transfer.data import doc_text, question_suffix
    from latent_transfer.kv import model_shape
    from latent_transfer.pair import TransferPair
    pair = TransferPair(sender=MODELS[sender]["id"], receiver=MODELS[receiver]["id"], checkpoint=checkpoint)
    shapes = {"sender": model_shape(pair.sender), "receiver": model_shape(pair.receiver)}
    source = os.path.join(out, "summaries", f"{sender}.json")
    summaries = load(source)["summaries"] if os.path.exists(source) else {}
    pair.answer_from_text(doc_text("Warm-up passage."), question_suffix("Warm-up?"), 2)
    pair.answer_from_sender(doc_text("Warm-up passage."), question_suffix("Warm-up?"), 2)

    def sync_ms(start):
        torch.cuda.synchronize()
        return (time.perf_counter() - start) * 1000

    results, started = {}, time.time()
    for group in LATENT_GROUPS:
        rows = groups[group]
        for index, item in enumerate(rows):
            record = {}
            document, suffix = doc_text(item["passage"]), question_suffix(item["question"])

            def text():
                start = time.perf_counter()
                answer = pair.answer_from_text(document, suffix)
                return {"answer": answer, "ms": sync_ms(start), **score(answer, item),
                        "bytes": len(item["passage"].encode("utf-8"))}

            def mapped(source_document=document, zero=False):
                start = time.perf_counter()
                answer, receipt = pair.answer_from_sender(source_document, suffix, zero_sender=zero)
                return {"answer": answer, "ms": sync_ms(start), **score(answer, item), **receipt,
                        "bytes": kv_bytes(*shapes["sender"], receipt["senderTokens"]),
                        "mappedBytes": kv_bytes(*shapes["receiver"], receipt["receiverTokens"])}

            guarded(record, "text_m2b", text)
            guarded(record, "swat", mapped)
            if group == "main":
                other = rows[(index + 1) % len(rows)]
                guarded(record, "mismatched", lambda: mapped(doc_text(other["passage"])))
                guarded(record, "zeroed", lambda: mapped(zero=True))
                summary = summaries.get(item["id"])
                if summary is not None and "error" not in summary:
                    def t2t():
                        start = time.perf_counter()
                        answer = pair.answer_from_text(doc_text(summary["summary"]), suffix)
                        receiver_ms = sync_ms(start)
                        return {"answer": answer, "ms": receiver_ms + summary["ms"], "receiverMs": receiver_ms,
                                **score(answer, item), "bytes": summary["bytes"]}
                    guarded(record, "t2t_m2b", t2t)
            results[item["id"]] = record
        print(f"latent {sender}->{receiver} {group} done {time.time() - started:.0f}s", flush=True)
    save(target, {"sender": sender, "receiver": receiver, "checkpoint": pair.checkpoint_id,
                  "shapes": {name: list(shape) for name, shape in shapes.items()}, "results": results})


def phase_report(out, wanted=None):
    groups = load(os.path.join(out, "items.json"))
    receive, summaries, latent = {}, {}, {}
    for key in wanted or MODELS:
        for store, folder in ((receive, "receive"), (summaries, "summaries")):
            source = os.path.join(out, folder, f"{key}.json")
            if os.path.exists(source):
                store[key] = load(source)
    for sender, receiver in MAPPERS:
        source = os.path.join(out, "latent", f"{sender}__{receiver}.json")
        if os.path.exists(source):
            latent[(sender, receiver)] = load(source)
    summary = build_summary(groups, receive, summaries, latent)
    save(path(out, "summary.json"), summary)
    with open(path(out, "report.md"), "w", encoding="utf-8") as handle:
        handle.write(render_markdown(summary))
    print(f"report: {len(receive)} models, written to {os.path.join(out, 'report.md')}", flush=True)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("phase", choices=["all", "items", "summaries", "receive", "latent", "report"])
    parser.add_argument("--out", required=True)
    parser.add_argument("--models", help="comma-separated model keys (default: all)")
    parser.add_argument("--model", help="the one model of a summaries or receive phase")
    parser.add_argument("--pair", help="sender:receiver of a latent phase")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--force", action="store_true", help="run a phase again even if its file exists")
    args = parser.parse_args()
    out = os.path.expanduser(args.out)
    wanted = keys(args.models)
    if args.phase == "report":
        phase_report(out, wanted)
        return
    groups = phase_items(out, args.seed, args.force and args.phase == "items")
    if args.phase in ("summaries", "receive"):
        if args.model not in MODELS:
            parser.error(f"--model must be one of: {', '.join(MODELS)}")
        if args.phase == "summaries":
            phase_summaries(out, args.model, groups, args.force)
        else:
            phase_receive(out, args.model, groups, wanted, args.force)
    elif args.phase == "latent":
        sender, _, receiver = (args.pair or "").partition(":")
        if (sender, receiver) not in MAPPERS:
            parser.error("--pair must be a pair with a trained mapper: "
                         + ", ".join(f"{s}:{r}" for s, r in MAPPERS))
        phase_latent(out, sender, receiver, groups, args.force)
    elif args.phase == "all":
        for key in wanted:
            phase_summaries(out, key, groups, args.force)
        for key in wanted:
            phase_receive(out, key, groups, wanted, args.force)
        for sender, receiver in MAPPERS:
            if sender in wanted and receiver in wanted:
                phase_latent(out, sender, receiver, groups, args.force)
        phase_report(out, wanted)


if __name__ == "__main__":
    main()
