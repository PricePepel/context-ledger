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

Every phase file carries the fingerprint of items.json. A file made from another item set
is refused (rerun it with --force), so answers to different questions are never paired.
One model is on the GPU at a time (two in the latent phase). Run from runtime/.
"""
import argparse
import hashlib
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
MAPPER_TOKENS = 384    # latent_transfer cuts a document (header included) to this many tokens
SUMMARY_GROUPS = ("main", "long_passage", "tiny_passage", "non_english_emoji", "unanswerable")
LATENT_GROUPS = ("main", "long_passage", "tiny_passage", "non_english_emoji")


class StaleFile(ValueError):
    """A phase file that was made from a different item set."""


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


def fingerprint(groups):
    """sha256 of the item sets: what every phase file must have been made from."""
    body = json.dumps(groups, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


def existing(target, items_id, force=False):
    """A finished phase file for this item set, or None when the phase has to run.

    A file from another item set stops the run instead of being reused or overwritten.
    """
    if force or not os.path.exists(target):
        return None
    data = load(target)
    if data.get("itemsId") != items_id:
        raise StaleFile(f"{target} was made from another item set ({data.get('itemsId')}, now {items_id}). "
                        "Run that phase again with --force, or use a new --out folder.")
    return data


def guarded(record, arm, work, cleanup=None):
    """Run one arm; an error becomes the arm's record instead of stopping the run."""
    try:
        record[arm] = work()
    except Exception as error:  # noqa: BLE001 - the report counts and names these
        record[arm] = {"error": f"{type(error).__name__}: {str(error)[:200]}"}
        if cleanup:
            cleanup()


def limit_for(item):
    return LONG_CONTEXT if item["group"] == "long_passage" else None


def mismatch_index(rows, index):
    """The next item with a different passage: the control must not get the right one back.

    SQuAD asks several questions of one paragraph, so the neighbour can share the passage.
    """
    for step in range(1, len(rows)):
        other = (index + step) % len(rows)
        if rows[other]["passage"].strip() != rows[index]["passage"].strip():
            return other
    raise ValueError("Every item has the same passage, so there is no mismatched control.")


def default_engine(key):
    from .engine import Engine
    return Engine(key)


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


def phase_summaries(out, key, groups, force=False, engine_factory=default_engine):
    target, items_id = path(out, "summaries", f"{key}.json"), fingerprint(groups)
    if existing(target, items_id, force):
        return
    engine = engine_factory(key)
    engine.summarize("Warm-up passage.", None, 4)
    records, started = {}, time.time()
    for group in SUMMARY_GROUPS:
        for item in groups[group]:
            record = {}
            guarded(record, "summary", lambda item=item: engine.summarize(item["passage"], limit_for(item)),
                    engine.recover)
            records[item["id"]] = record["summary"]
        print(f"summaries {key} {group} done {time.time() - started:.0f}s", flush=True)
    save(target, {"itemsId": items_id, "model": engine.describe(), "summaries": records})
    engine.close()


def answer_record(item, prepared, result):
    return {**result, **score(result["answer"], item), "ms": result["ms"] + prepared["prepareMs"],
            **{name: prepared[name] for name in ("promptTokens", "passageTokens", "keptTokens", "truncated", "prepareMs")}}


def available_summaries(out, senders, items_id):
    """{sender: summaries} for the senders whose summary phase has finished on this item set."""
    found = {}
    for sender in senders:
        data = existing(os.path.join(out, "summaries", f"{sender}.json"), items_id)
        if data:
            found[sender] = data["summaries"]
    return found


def phase_receive(out, key, groups, senders, force=False, engine_factory=default_engine):
    target, items_id = path(out, "receive", f"{key}.json"), fingerprint(groups)
    summaries = available_summaries(out, senders, items_id)
    done = existing(target, items_id, force)
    if done and set(summaries) <= set(done.get("senders", [])):
        return
    # A file that lacks a sender whose summaries now exist is run again as a whole, so every
    # arm of a receiver comes from one load of the model.
    engine = engine_factory(key)
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
                return {**answer_record(item, prepared, engine.timed(prepared["ids"])),
                        "bytes": prepared["passageBytes"]}

            def self_cache(read=read, item=item):
                prepared = read(item["passage"])
                return answer_record(item, prepared, engine.answer_from_cache(prepared))

            guarded(record, "text", text, engine.recover)
            guarded(record, "self_cache", self_cache, engine.recover)
            if group == "main":
                def closed(item=item):
                    start = time.perf_counter()
                    ids = engine.closed_ids(item["question"])
                    prepare_ms = (time.perf_counter() - start) * 1000
                    result = engine.timed(ids)
                    return {**result, **score(result["answer"], item), "bytes": 0, "ms": result["ms"] + prepare_ms}
                guarded(record, "closed", closed, engine.recover)
            if group != "no_system_role":
                for sender in (senders if group == "main" else [key]):
                    summary = summaries.get(sender, {}).get(item["id"])
                    if summary is None:
                        continue

                    def t2t(summary=summary, read=read, item=item):
                        if "error" in summary:
                            raise ValueError(f"The sender's summary failed: {summary['error']}")
                        prepared = read(summary["summary"])
                        answered = answer_record(item, prepared, engine.timed(prepared["ids"]))
                        # End to end: the sender writes the summary, then the receiver answers.
                        return {**answered, "bytes": summary["bytes"], "receiverMs": answered["ms"],
                                "ms": answered["ms"] + summary["ms"], "senderTruncated": summary["truncated"]}
                    guarded(record, f"t2t:{sender}", t2t, engine.recover)
            results[item["id"]] = record
        print(f"receive {key} {group} done {time.time() - started:.0f}s", flush=True)
    save(target, {"itemsId": items_id, "model": engine.describe(), "senders": sorted(summaries), "results": results})
    engine.close()


def phase_latent(out, sender, receiver, groups, force=False):
    """Returns None when it ran (or was already done), else the reason it could not run."""
    target, items_id = path(out, "latent", f"{sender}__{receiver}.json"), fingerprint(groups)
    if existing(target, items_id, force):
        return None
    spec = MAPPERS[(sender, receiver)]
    checkpoint = os.path.expanduser(spec["checkpoint"])
    if not os.path.exists(checkpoint):
        return f"The mapper checkpoint {spec['checkpoint']} is not on this machine."
    import torch

    from latent_transfer.data import doc_text, question_suffix
    from latent_transfer.kv import model_shape
    from latent_transfer.pair import TransferPair
    pair = TransferPair(sender=MODELS[sender]["id"], receiver=MODELS[receiver]["id"], checkpoint=checkpoint)
    if pair.checkpoint_id != spec["id"]:
        return f"The checkpoint at {spec['checkpoint']} is {pair.checkpoint_id}, not the registered {spec['id']}."
    shapes = {"sender": model_shape(pair.sender), "receiver": model_shape(pair.receiver)}
    summaries = available_summaries(out, [sender], items_id).get(sender, {})
    pair.answer_from_text(doc_text("Warm-up passage."), question_suffix("Warm-up?"), 2)
    pair.answer_from_sender(doc_text("Warm-up passage."), question_suffix("Warm-up?"), 2)

    def sync_ms(start):
        torch.cuda.synchronize()
        return (time.perf_counter() - start) * 1000

    def cut(document):
        """What the mapper path keeps of a document: latent_transfer truncates to MAPPER_TOKENS."""
        encoded = pair.receiver_tok(document, add_special_tokens=False, return_offsets_mapping=True)
        total = len(encoded["input_ids"])
        sender_total = len(pair.sender_tok(document, add_special_tokens=False)["input_ids"])
        kept = document if total <= MAPPER_TOKENS else document[:encoded["offset_mapping"][MAPPER_TOKENS - 1][1]]
        return {"docTokens": total, "truncated": total > MAPPER_TOKENS or sender_total > MAPPER_TOKENS,
                "keptBytes": len(kept.encode("utf-8"))}

    results, started = {}, time.time()
    for group in LATENT_GROUPS:
        rows = groups[group]
        for index, item in enumerate(rows):
            record = {}
            document, suffix = doc_text(item["passage"]), question_suffix(item["question"])
            info = cut(document)

            def text():
                start = time.perf_counter()
                answer = pair.answer_from_text(document, suffix)
                return {"answer": answer, "ms": sync_ms(start), **score(answer, item), **info,
                        "bytes": info["keptBytes"]}

            def mapped(source_document=document, zero=False):
                start = time.perf_counter()
                answer, receipt = pair.answer_from_sender(source_document, suffix, zero_sender=zero)
                return {"answer": answer, "ms": sync_ms(start), **score(answer, item), **receipt, **info,
                        "bytes": kv_bytes(*shapes["sender"], receipt["senderTokens"]),
                        "mappedBytes": kv_bytes(*shapes["receiver"], receipt["receiverTokens"])}

            guarded(record, "text_m2b", text)
            guarded(record, "swat", mapped)
            if group == "main":
                other = rows[mismatch_index(rows, index)]
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
    save(target, {"itemsId": items_id, "sender": sender, "receiver": receiver, "checkpoint": pair.checkpoint_id,
                  "shapes": {name: list(shape) for name, shape in shapes.items()}, "results": results})
    return None


def collect(out, groups, wanted):
    """The phase files of this item set, and what is absent: (receive, summaries, latent, notes)."""
    items_id = fingerprint(groups)
    receive, summaries, latent, notes = {}, {}, {}, load_notes(out)
    for key in wanted:
        for store, folder in ((receive, "receive"), (summaries, "summaries")):
            data = existing(os.path.join(out, folder, f"{key}.json"), items_id)
            if data:
                store[key] = data
    for sender, receiver in MAPPERS:
        data = existing(os.path.join(out, "latent", f"{sender}__{receiver}.json"), items_id)
        if data:
            latent[(sender, receiver)] = data
        elif f"{sender}>{receiver}" in notes:
            latent[(sender, receiver)] = {"skipped": notes[f"{sender}>{receiver}"]}
    return receive, summaries, latent, notes


def load_notes(out):
    target = os.path.join(out, "failures.json")
    return load(target) if os.path.exists(target) else {}


def note(out, name, reason):
    """Record why a model or a pair did not run, for the report. None clears the note."""
    notes = load_notes(out)
    if reason is None:
        notes.pop(name, None)
    else:
        notes[name] = reason
    save(path(out, "failures.json"), notes)


def phase_report(out, wanted=None):
    groups = load(os.path.join(out, "items.json"))
    wanted = wanted or list(MODELS)
    receive, summaries, latent, notes = collect(out, groups, wanted)
    summary = build_summary(groups, receive, summaries, latent,
                            dropped={key: notes[key] for key in wanted if key in notes and key not in receive})
    summary["itemsId"] = fingerprint(groups)
    save(path(out, "summary.json"), summary)
    with open(path(out, "report.md"), "w", encoding="utf-8") as handle:
        handle.write(render_markdown(summary))
    print(f"report: {len(receive)} models, written to {os.path.join(out, 'report.md')}", flush=True)
    return summary


def attempt(out, name, work):
    """One model's or pair's phase inside `all`: a failure is noted and the run goes on."""
    try:
        reason = work()
    except StaleFile:
        raise
    except Exception as error:  # noqa: BLE001 - a checkpoint that does not load is dropped and named
        reason = f"{type(error).__name__}: {str(error)[:300]}"
    note(out, name, reason)
    return reason is None


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
        note(out, args.model, None)
    elif args.phase == "latent":
        sender, _, receiver = (args.pair or "").partition(":")
        if (sender, receiver) not in MAPPERS:
            parser.error("--pair must be a pair with a trained mapper: "
                         + ", ".join(f"{s}:{r}" for s, r in MAPPERS))
        reason = phase_latent(out, sender, receiver, groups, args.force)
        note(out, f"{sender}>{receiver}", reason)
        if reason:
            print(f"latent {sender}->{receiver} not run: {reason}", flush=True)
    elif args.phase == "all":
        alive = [key for key in wanted
                 if attempt(out, key, lambda key=key: phase_summaries(out, key, groups, args.force))]
        for key in alive:
            attempt(out, key, lambda key=key: phase_receive(out, key, groups, alive, args.force))
        for sender, receiver in MAPPERS:
            if sender in alive and receiver in alive:
                attempt(out, f"{sender}>{receiver}",
                        lambda sender=sender, receiver=receiver: phase_latent(out, sender, receiver, groups, args.force))
        phase_report(out, wanted)


if __name__ == "__main__":
    main()
