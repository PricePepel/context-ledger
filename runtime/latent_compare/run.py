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
import signal
import sys
import time

from . import items as item_sets
from .models import MAPPERS, MODELS, backend, keys
from .prompts import SYSTEM_TEXT
from .report import build_summary, render_markdown
from .stats import kv_bytes, score
from .vllm_engine import CACHE_REFUSAL

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


def mapper_cut(document, sender_offsets, receiver_offsets, cap=MAPPER_TOKENS):
    """What latent_transfer keeps of a document on the receiver's side: each side is cut to
    `cap` tokens, then both keep only the tokens that end within the earlier of the two ends
    (batch.cut_to_common_end). Returns {docTokens, truncated, keptBytes}."""
    ends = [offsets[min(len(offsets), cap) - 1][1] if offsets else 0 for offsets in (sender_offsets, receiver_offsets)]
    limit = min(ends)
    kept = max((end for _, end in receiver_offsets[:cap] if end <= limit), default=0)
    return {"docTokens": len(receiver_offsets),
            "truncated": len(sender_offsets) > cap or len(receiver_offsets) > cap,
            "keptBytes": len(document[:kept].encode("utf-8"))}


def default_engine(key):
    if backend(key) == "vllm":
        from .vllm_engine import VllmEngine
        return VllmEngine(key)
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
    try:
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
    finally:
        engine.close()   # also on a failure: a model or a vLLM server must not stay on the GPU


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


def summary_stamps(summaries):
    """{sender: a short hash of its saved summaries, timings included}: which writing of them
    a result was computed from. A sender whose summaries are written again gets a new stamp."""
    return {sender: hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]
            for sender, data in summaries.items()}


def from_these_summaries(saved, stamps):
    """Whether a saved result read these very summaries. A file from before stamps were
    recorded (saved is None) is taken as current: there is nothing to compare."""
    return saved is None or all(saved.get(sender) == stamp for sender, stamp in stamps.items())


def phase_receive(out, key, groups, senders, force=False, engine_factory=default_engine):
    target, items_id = path(out, "receive", f"{key}.json"), fingerprint(groups)
    summaries = available_summaries(out, senders, items_id)
    stamps = summary_stamps(summaries)
    done = existing(target, items_id, force)
    # Codex review, round 5: a sender whose summaries were written again (a retry after a
    # failure) left receivers holding answers to its previous summaries.
    if done and set(summaries) <= set(done.get("senders", [])) and from_these_summaries(done.get("summaryStamps"), stamps):
        return
    # A file that lacks a sender whose summaries now exist is run again as a whole, so every
    # arm of a receiver comes from one load of the model.
    engine = engine_factory(key)
    try:
        warm = engine.prepare("Warm-up passage.", "Warm-up?")
        engine.timed(warm["ids"], 2)
        if engine.hands_over_cache:
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
                if engine.hands_over_cache:
                    guarded(record, "self_cache", self_cache, engine.recover)
                else:
                    # A named, expected refusal: not an error and not a missing record.
                    record["self_cache"] = {"refused": CACHE_REFUSAL}
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
        save(target, {"itemsId": items_id, "model": engine.describe(), "senders": sorted(summaries),
                      "summaryStamps": stamps, "results": results})
    finally:
        engine.close()


def phase_latent(out, sender, receiver, groups, force=False):
    """Returns None when it ran (or was already done), else the reason it could not run."""
    target, items_id = path(out, "latent", f"{sender}__{receiver}.json"), fingerprint(groups)
    spec = MAPPERS[(sender, receiver)]
    summaries = available_summaries(out, [sender], items_id).get(sender, {})
    stamp = summary_stamps({sender: summaries}).get(sender) if summaries else None
    done = existing(target, items_id, force)
    if done and latent_current(done, spec, bool(summaries), stamp):
        return None
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
    pair.answer_from_text(doc_text("Warm-up passage."), question_suffix("Warm-up?"), 2)
    pair.answer_from_sender(doc_text("Warm-up passage."), question_suffix("Warm-up?"), 2)

    def sync_ms(start):
        torch.cuda.synchronize()
        return (time.perf_counter() - start) * 1000

    def cut(document):
        offsets = [tok(document, add_special_tokens=False, return_offsets_mapping=True)["offset_mapping"]
                   for tok in (pair.sender_tok, pair.receiver_tok)]
        return mapper_cut(document, *offsets)

    results, started = {}, time.time()
    for group in LATENT_GROUPS:
        rows = groups[group]
        for index, item in enumerate(rows):
            record = {}
            document, suffix = doc_text(item["passage"]), question_suffix(item["question"])

            def text():
                info = cut(document)
                start = time.perf_counter()
                answer = pair.answer_from_text(document, suffix)
                return {"answer": answer, "ms": sync_ms(start), **score(answer, item), **info,
                        "bytes": info["keptBytes"]}

            def mapped(source_document=document, zero=False):
                info = cut(source_document)   # of the document this arm really sends
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

                def t2t():
                        if summary is None or "error" in summary:
                            raise ValueError("The sender's summary of this item is missing or failed.")
                        start = time.perf_counter()
                        answer = pair.answer_from_text(doc_text(summary["summary"]), suffix)
                        receiver_ms = sync_ms(start)
                        # bytes: the whole summary is what crosses; truncated says whether the
                        # mapper path's cap cut what the receiver read of it.
                        return {"answer": answer, "ms": receiver_ms + summary["ms"], "receiverMs": receiver_ms,
                                **score(answer, item), "bytes": summary["bytes"],
                                "truncated": cut(doc_text(summary["summary"]))["truncated"]}
                guarded(record, "t2t_m2b", t2t)
            results[item["id"]] = record
        print(f"latent {sender}->{receiver} {group} done {time.time() - started:.0f}s", flush=True)
    save(target, {"itemsId": items_id, "sender": sender, "receiver": receiver, "checkpoint": pair.checkpoint_id,
                  "senderSummaries": bool(summaries), "summaryStamp": stamp,
                  "shapes": {name: list(shape) for name, shape in shapes.items()}, "results": results})
    return None


def latent_current(data, spec, have_summaries, stamp=None):
    """Whether a saved mapper result still stands: it is from the registered checkpoint, it is
    not missing a summary arm that could be run now, and its summary arm read the sender's
    summaries as they are now (a file from before stamps were recorded is taken as current)."""
    if data.get("checkpoint") != spec["id"]:
        return False
    if not have_summaries:
        return True
    return bool(data.get("senderSummaries")) and data.get("summaryStamp") in (None, stamp)


def collect(out, groups, wanted):
    """The phase files of this item set, and what is absent: (receive, summaries, latent, notes)."""
    items_id = fingerprint(groups)
    receive, summaries, latent, notes = {}, {}, {}, load_notes(out)
    for key in wanted:
        if key in notes:
            continue   # its last attempt failed: an older file must not stand in for it
        for store, folder in ((receive, "receive"), (summaries, "summaries")):
            data = existing(os.path.join(out, folder, f"{key}.json"), items_id)
            if data:
                store[key] = data
    # Codex review, round 6: a report must not pair a sender's new summaries with answers that
    # read its earlier ones. Such a receiver or pair is left out and named, until it is run again.
    stamps = summary_stamps({key: data["summaries"] for key, data in summaries.items()})
    for key in list(receive):
        read = {sender: stamps[sender] for sender in receive[key].get("senders", []) if sender in stamps}
        if not from_these_summaries(receive[key].get("summaryStamps"), read):
            del receive[key]
            notes[key] = f"Its answers read summaries that were since written again; run `receive --model {key}`."
    for (sender, receiver), spec in MAPPERS.items():
        name = f"{sender}>{receiver}"
        if sender not in wanted or receiver not in wanted:
            continue   # a report on a subset is not graded on a pair outside it (Codex review, round 5)
        if name in notes:
            # Before the file is even read: its last attempt failed, whatever an older file holds.
            latent[(sender, receiver)] = {"skipped": notes[name]}
            continue
        data = existing(os.path.join(out, "latent", f"{sender}__{receiver}.json"), items_id)
        if data and data.get("checkpoint") != spec["id"]:
            latent[(sender, receiver)] = {"skipped": f"The saved result is from checkpoint {data.get('checkpoint')}, "
                                                     f"not the registered {spec['id']}."}
        elif data and sender in stamps and data.get("summaryStamp") not in (None, stamps[sender]):
            latent[(sender, receiver)] = {"skipped": f"Its summary arm read {sender}'s summaries before they were "
                                                     f"written again; run `latent --pair {sender}:{receiver}`."}
        elif data:
            latent[(sender, receiver)] = data
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
                            dropped={key: notes[key] for key in wanted if key in notes})
    summary["itemsId"] = fingerprint(groups)
    save(path(out, "summary.json"), summary)
    with open(path(out, "report.md"), "w", encoding="utf-8") as handle:
        handle.write(render_markdown(summary))
    print(f"report: {len(receive)} models, written to {os.path.join(out, 'report.md')}", flush=True)
    return summary


def attempt(out, name, work, clear=True):
    """One model's or pair's phase inside `all`: a failure is noted and the run goes on.
    clear=False leaves an older note in place on success, for a phase that is not the last."""
    try:
        reason = work()
    except StaleFile:
        raise
    except Exception as error:  # noqa: BLE001 - a checkpoint that does not load is dropped and named
        reason = f"{type(error).__name__}: {str(error)[:300]}"
    if reason is not None or clear:
        note(out, name, reason)
    return reason is None


def stop_on_sigterm():
    """A plain `kill` ends the run through SystemExit, so every `finally` runs and a vLLM
    server this run started is stopped with it (Codex review, round 5). By default Python
    dies on SIGTERM without unwinding, and the server, in its own session, would live on."""
    def stop(signum, frame):
        sys.exit(128 + signum)
    signal.signal(signal.SIGTERM, stop)
    return stop


def main():
    stop_on_sigterm()
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
        run_one(out, args.phase, args.model, groups, wanted, args.force)
    elif args.phase == "latent":
        sender, _, receiver = (args.pair or "").partition(":")
        if (sender, receiver) not in MAPPERS:
            parser.error("--pair must be a pair with a trained mapper: "
                         + ", ".join(f"{s}:{r}" for s, r in MAPPERS))
        reason = phase_latent(out, sender, receiver, groups,
                              args.force or f"{sender}>{receiver}" in load_notes(out))
        note(out, f"{sender}>{receiver}", reason)
        if reason:
            print(f"latent {sender}->{receiver} not run: {reason}", flush=True)
    elif args.phase == "all":
        run_all(out, wanted, groups, args.force)


def run_one(out, phase, key, groups, wanted, force=False, summaries=None, receive=None):
    """A single `summaries` or `receive` command. A model whose last attempt failed is run
    again, not answered from an older file, and its failure note goes only when its receive
    phase has succeeded: a cached summaries phase must not bring older receive results back
    into the report (Codex review, round 7)."""
    failed = key in load_notes(out)
    if phase == "summaries":
        (summaries or phase_summaries)(out, key, groups, force or failed)
    else:
        (receive or phase_receive)(out, key, groups, wanted, force or failed)
        note(out, key, None)


def run_all(out, wanted, groups, force=False, summaries=None, receive=None, latent=None, pairs=None):
    """Every phase for every model, then the report. A model or pair whose last attempt failed
    is run again from the start: its older files must not come back as its result just because
    a cached phase succeeded and cleared the note (Codex review, round 4)."""
    summaries, receive, latent = summaries or phase_summaries, receive or phase_receive, latent or phase_latent
    failed = set(load_notes(out))
    alive = [key for key in wanted
             if attempt(out, key, lambda key=key: summaries(out, key, groups, force or key in failed), clear=False)]
    for key in alive:
        attempt(out, key, lambda key=key: receive(out, key, groups, alive, force or key in failed))
    for sender, receiver in (MAPPERS if pairs is None else pairs):
        name = f"{sender}>{receiver}"
        if sender in alive and receiver in alive:
            attempt(out, name, lambda sender=sender, receiver=receiver, name=name:
                    latent(out, sender, receiver, groups, force or name in failed))
    return phase_report(out, wanted)


if __name__ == "__main__":
    main()
