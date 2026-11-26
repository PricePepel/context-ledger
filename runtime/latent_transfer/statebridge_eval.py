"""Card L4 eval: can a training-free alignment replace the trained mapper?

    python -m latent_transfer.statebridge_eval --sender microsoft/Phi-3.5-mini-instruct \
        --receiver Qwen/Qwen2.5-1.5B-Instruct --checkpoint best.pt --out phi-qwen15.json
    python -m latent_transfer.statebridge_stats phi-qwen15.json

Same 300 SQuAD questions, prompts and grading as M2b-S (`latent_transfer.evaluate`). Arms are
listed in docs/evals.md (L4). Every aligned arm has a mismatched control: the same pipeline
on the next item's passage. Nothing is tuned on these questions; K, alpha and lambda are the
paper's (arXiv 2608.13317).
"""
import argparse
import hashlib
import json
import os
import time
from types import SimpleNamespace

import torch
from transformers import AutoTokenizer

from . import statebridge as sb
from .data import DOC_PREFIX, closed_prompt, contains, doc_text, f1, question_suffix, sample, squad, summary_prompt
from .evaluate import eval_items
from .statebridge_anchors import covered_share, overlap, shared_anchors, split_holdout, vocab_keys
from .statebridge_stats import VARIANTS, summarize

# The item set is always chosen with the M2b-S tokenizers, so every pair answers the same questions.
REFERENCE_SENDER = "microsoft/Phi-3.5-mini-instruct"
REFERENCE_RECEIVER = "Qwen/Qwen2.5-1.5B-Instruct"
CALIBRATION_PASSAGES = 400
EDGE_FILE = os.path.join(os.path.dirname(__file__), "statebridge_edge.json")


def load_items(kind, count, seed, max_tokens):
    if kind == "edge":
        with open(EDGE_FILE, encoding="utf-8") as handle:
            return json.load(handle)["items"]
    reference = SimpleNamespace(sender_tok=AutoTokenizer.from_pretrained(REFERENCE_SENDER),
                                receiver_tok=AutoTokenizer.from_pretrained(REFERENCE_RECEIVER))
    return eval_items(reference, count, seed, max_tokens)


def calibration_passages(count, seed, exclude):
    """Distinct SQuAD train passages, none of which is an evaluation passage."""
    seen, passages = set(exclude), []
    for row in sample(squad("train"), count * 20, seed):
        if row["context"] in seen:
            continue
        seen.add(row["context"])
        passages.append(row["context"])
        if len(passages) == count:
            break
    return passages


class Bench:
    def __init__(self, sender_name, receiver_name, checkpoint=None, device="cuda"):
        self.device = device
        self.sender_name, self.receiver_name = sender_name, receiver_name
        self.pair = None
        if checkpoint:
            from .pair import TransferPair
            self.pair = TransferPair(sender=sender_name, receiver=receiver_name, device=device, checkpoint=checkpoint)
            self.sender, self.receiver = self.pair.sender, self.pair.receiver
            self.sender_tok, self.receiver_tok = self.pair.sender_tok, self.pair.receiver_tok
        else:
            from .pair import load_model
            self.sender_tok = AutoTokenizer.from_pretrained(sender_name)
            self.receiver_tok = AutoTokenizer.from_pretrained(receiver_name)
            self.sender = load_model(sender_name, device)
            self.receiver = self.sender if receiver_name == sender_name else load_model(receiver_name, device)
        end = self.receiver_tok.convert_tokens_to_ids("<|im_end|>")
        if end is None or end == self.receiver_tok.unk_token_id:
            raise ValueError("The receiver must read ChatML: the M2b-S prompts are ChatML.")
        self.eos = {end, self.receiver_tok.eos_token_id}
        self.sender_stop = set(self.sender_tok.all_special_ids)
        self.vocab = self.receiver.get_input_embeddings().weight.detach()
        self.target_norm = sb.mean_vocab_norm(self.vocab)
        self.same_tokenizer = self.sender_tok.get_vocab() == self.receiver_tok.get_vocab()
        self.maps, self.fit = {}, {}
        self.anchor_of = {}

    # Tokens and embeddings ------------------------------------------------
    def ids(self, tokenizer, text):
        return torch.tensor([tokenizer(text, add_special_tokens=False)["input_ids"]], device=self.device)

    def embed(self, text):
        return self.receiver.get_input_embeddings()(self.ids(self.receiver_tok, text))[0]

    def decode(self, tokens):
        return self.receiver_tok.decode(tokens, skip_special_tokens=True).strip()

    def answer(self, parts, max_new_tokens=24):
        """Receiver answer from a list of embedding blocks, timed."""
        self.sync()
        start = time.perf_counter()
        embeds = torch.cat([part.to(self.vocab) for part in parts])
        text = self.decode(sb.answer_from_embeds(self.receiver, embeds, max_new_tokens, self.eos,
                                                 self.receiver_tok.pad_token_id or 0))
        self.sync()
        return text, (time.perf_counter() - start) * 1000

    def sync(self):
        if str(self.device).startswith("cuda"):
            torch.cuda.synchronize()

    # Maps -------------------------------------------------------------------
    def fit_anchor_map(self):
        """One closed-form map from the sender's output-embedding rows to the receiver's input rows."""
        start = time.perf_counter()
        anchors = shared_anchors(vocab_keys(self.sender_tok), vocab_keys(self.receiver_tok))
        self.anchor_of = {sender_id: receiver_id for sender_id, receiver_id, _ in anchors}
        fit, held = split_holdout(anchors)
        out_rows = self.sender.get_output_embeddings().weight.detach()
        moments = sb.Moments(out_rows.shape[1], self.vocab.shape[1], device=self.device)
        for begin in range(0, len(fit), 8192):
            block = fit[begin:begin + 8192]
            moments.add(out_rows[[a[0] for a in block]], self.vocab[[a[1] for a in block]])
        self.maps["anchor"] = sb.fit_map(moments)
        self.sync()
        seconds = time.perf_counter() - start
        held = held[:4000]
        accuracy = sb.retrieval_accuracy(self.maps["anchor"], out_rows[[a[0] for a in held]],
                                         [a[1] for a in held], self.vocab)
        self.fit["anchor"] = {**overlap(anchors, len(self.sender_tok), len(self.receiver_tok)),
                              "fitSeconds": round(seconds, 1), "heldOutRows": len(held),
                              "heldOutNearestIsOwn": round(accuracy, 4)}

    def fit_calibrated_map(self, passages):
        """The same closed form on real sender states, each paired with the receiver's row of the
        anchor token the state itself predicts. Every tenth passage is kept out for the check."""
        start = time.perf_counter()
        moments = sb.Moments(self.sender.config.hidden_size, self.vocab.shape[1], device=self.device)
        held_states, held_targets = [], []
        for index, passage in enumerate(passages):
            states, logits = sb.reading_states(self.sender, self.ids(self.sender_tok, doc_text(passage))[:, :384])
            predicted = logits.argmax(-1).tolist()
            keep = [i for i, token in enumerate(predicted) if token in self.anchor_of]
            if not keep:
                continue
            targets = [self.anchor_of[predicted[i]] for i in keep]
            if index % 10 == 9:
                held_states.append(states[keep].float().cpu())
                held_targets += targets
            else:
                moments.add(states[keep], self.vocab[targets])
        self.maps["calibrated"] = sb.fit_map(moments)
        self.sync()
        seconds = time.perf_counter() - start
        held = torch.cat(held_states)[:4000].to(self.device)
        accuracy = sb.retrieval_accuracy(self.maps["calibrated"], held, held_targets[:4000], self.vocab)
        self.fit["calibrated"] = {"passages": len(passages), "fitRows": moments.count,
                                  "fitSeconds": round(seconds, 1), "heldOutRows": int(held.shape[0]),
                                  "heldOutNearestIsOwn": round(accuracy, 4)}

    # Sender side ------------------------------------------------------------
    def summary(self, context):
        """The t2t summary, with the state every one of its tokens was read from."""
        self.sync()
        start = time.perf_counter()
        prompt = self.ids(self.sender_tok, summary_prompt(context, tokenizer=self.sender_tok))
        tokens, states = sb.generate_with_states(self.sender, prompt, 96, self.sender_stop,
                                                 self.sender_tok.pad_token_id or 0)
        self.sync()
        return {"tokens": tokens, "states": states.float().cpu(),
                "text": self.sender_tok.decode(tokens, skip_special_tokens=True).strip(),
                "ms": (time.perf_counter() - start) * 1000}

    def passage_states(self, context):
        """States at the passage's own positions while the sender reads header + passage."""
        self.sync()
        start = time.perf_counter()
        head = self.ids(self.sender_tok, DOC_PREFIX)
        body = self.ids(self.sender_tok, context.strip())
        states, logits = sb.reading_states(self.sender, torch.cat([head, body], dim=1))
        self.sync()
        return {"tokens": logits.argmax(-1)[head.shape[1]:].tolist(), "states": states[head.shape[1]:].float().cpu(),
                "bodyTokens": body[0].tolist(), "ms": (time.perf_counter() - start) * 1000}

    def prefix(self, map_name, states, expected_tokens=None):
        """Aligned prefix of some sender states, timed, with the share of positions whose
        nearest receiver row is the anchor of the token the state predicted."""
        self.sync()
        start = time.perf_counter()
        vectors, ids = sb.bridge(states.to(self.device), self.maps[map_name], self.vocab, self.target_norm)
        self.sync()
        ms = (time.perf_counter() - start) * 1000
        hit = None
        if expected_tokens is not None:
            pairs = [(found, self.anchor_of[token]) for found, token in zip(ids.tolist(), expected_tokens)
                     if token in self.anchor_of]
            hit = sum(1 for found, want in pairs if found == want) / len(pairs) if pairs else None
        return {"vectors": vectors.to(self.vocab.dtype).cpu(), "ms": ms, "hit": hit}

    def per_message(self, states, tokens):
        """The paper's own fit, where the receiver can embed the sender's tokens."""
        self.sync()
        start = time.perf_counter()
        reference = self.vocab[tokens].to(self.device)
        fitted = sb.per_message_map(states.to(self.device), reference)
        vectors, _ = sb.bridge(states.to(self.device), fitted, self.vocab, self.target_norm)
        self.sync()
        return {"vectors": vectors.to(self.vocab.dtype).cpu(), "ms": (time.perf_counter() - start) * 1000,
                "reference": reference.float().cpu()}


def prepare(bench, items, cache_path=None, per_message=False, log_every=50):
    """Everything the sender produces for each item, and every prefix built from it."""
    cached = {}
    if cache_path and os.path.exists(cache_path):
        cached = torch.load(cache_path, map_location="cpu", weights_only=True)
    prepared = []
    for index, row in enumerate(items):
        summary = cached.get(row["id"]) or bench.summary(row["context"])
        cached[row["id"]] = summary
        last = slice(-sb.PREFIX_TOKENS, None)
        tokens, states = summary["tokens"][last], summary["states"][last]
        passage = bench.passage_states(row["context"])
        entry = {"summary": summary["text"], "summaryMs": summary["ms"], "summaryTokens": len(summary["tokens"]),
                 "passageMs": passage["ms"], "states": states, "tokens": tokens,
                 "anchorShare": covered_share(passage["bodyTokens"], bench.anchor_of), "prefix": {}}
        for name in bench.maps:
            entry["prefix"][f"{name}/summary"] = bench.prefix(name, states, tokens)
            entry["prefix"][f"{name}/passage"] = bench.prefix(name, passage["states"], passage["tokens"])
        entry["prefix"]["zeroed"] = bench.prefix("anchor", torch.zeros_like(states))
        if per_message and len(tokens) >= 2:
            entry["prefix"]["per-message"] = bench.per_message(states, tokens)
        prepared.append(entry)
        if log_every and (index + 1) % log_every == 0:
            print(f"sender {index + 1}/{len(items)}", flush=True)
    if cache_path:
        os.makedirs(os.path.dirname(cache_path) or ".", exist_ok=True)
        torch.save(cached, cache_path)
    return prepared


def run(bench, items, prepared, per_message=False, log_every=50):
    head = bench.embed(DOC_PREFIX)
    results, swap_gaps = [], []
    for index, (row, own) in enumerate(zip(items, prepared)):
        other = prepared[(index + 1) % len(items)]
        suffix = bench.embed(question_suffix(row["question"]))
        record = {"id": row["id"]}

        def arm(name, parts, extra_ms=0.0, hit=None):
            answer, ms = bench.answer(parts)
            record[name] = {"answer": answer, "f1": f1(answer, row["answers"]),
                            "contains": contains(answer, row["answers"]), "ms": ms + extra_ms, "hit": hit}

        arm("text", [bench.embed(doc_text(row["context"])), suffix])
        arm("closed", [bench.embed(closed_prompt(row["question"]))])
        arm("t2t", [bench.embed(doc_text(own["summary"])), suffix], own["summaryMs"])
        for variant in VARIANTS:
            if variant not in own["prefix"]:
                continue
            sender_ms = own["summaryMs"] if variant.endswith("/summary") else own["passageMs"]
            mine, theirs = own["prefix"][variant], other["prefix"][variant]
            arm(variant, [head, mine["vectors"], suffix], sender_ms + mine["ms"], mine["hit"])
            arm(f"{variant} mismatched", [head, theirs["vectors"], suffix])
        arm("anchor/summary zeroed", [head, own["prefix"]["zeroed"]["vectors"], suffix])
        if per_message and "per-message" in own["prefix"] and "per-message" in other["prefix"]:
            mine, theirs = own["prefix"]["per-message"], other["prefix"]["per-message"]
            arm("per-message", [head, mine["vectors"], suffix], own["summaryMs"] + mine["ms"])
            arm("per-message mismatched", [head, theirs["vectors"], suffix])
            arm("tokens", [head, mine["reference"], suffix], own["summaryMs"])
            rows = min(len(own["tokens"]), len(other["tokens"]))
            if rows >= 2:
                # Own tokens, the next item's hidden states. Both are cut to a common length, and
                # the comparison is against the own-states fit at that same length.
                swapped = bench.per_message(other["states"][-rows:], own["tokens"][-rows:])
                arm("per-message, states swapped", [head, swapped["vectors"], suffix])
                same = mine if rows == len(own["tokens"]) else bench.per_message(own["states"][-rows:],
                                                                                 own["tokens"][-rows:])
                same_answer = record["per-message"]["answer"] if same is mine else \
                    bench.answer([head, same["vectors"], suffix])[0]
                record["per-message, states swapped"]["sameAnswer"] = \
                    same_answer == record["per-message, states swapped"]["answer"]
                gap = (swapped["vectors"].float() - same["vectors"].float()).norm() / same["vectors"].float().norm()
                swap_gaps.append(float(gap))
            else:
                record["per-message, states swapped"] = dict(record["per-message"], ms=None, sameAnswer=None)
        if bench.pair is not None:
            start = time.perf_counter()
            answer, _ = bench.pair.answer_from_sender(doc_text(row["context"]), question_suffix(row["question"]))
            record["swat"] = {"answer": answer, "f1": f1(answer, row["answers"]),
                              "contains": contains(answer, row["answers"]),
                              "ms": (time.perf_counter() - start) * 1000, "hit": None}
        results.append(record)
        if log_every and (index + 1) % log_every == 0:
            means = {name: round(sum(r[name]["f1"] for r in results) / len(results), 3)
                     for name in record if name != "id"}
            print(f"{index + 1}/{len(items)} {means}", flush=True)
    return results, swap_gaps


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sender", required=True)
    parser.add_argument("--receiver", required=True)
    parser.add_argument("--checkpoint", help="trained M2b-S mapper for this pair: adds the swat arm")
    parser.add_argument("--items", choices=("squad", "edge"), default="squad")
    parser.add_argument("--count", type=int, default=300)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--max-tokens", type=int, default=384)
    parser.add_argument("--per-message", action="store_true",
                        help="add the paper's own per-message fit (needs one shared tokenizer)")
    parser.add_argument("--no-calibrated", action="store_true")
    parser.add_argument("--calibration-passages", type=int, default=CALIBRATION_PASSAGES)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--summary-cache", help="file that keeps this sender's summaries and states between pairs")
    parser.add_argument("--expect-ids", help="an M2b-S eval.json: fail unless the item IDs are the same")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    torch.manual_seed(args.seed)

    items = load_items(args.items, args.count, args.seed, args.max_tokens)
    ids_digest = hashlib.sha256("\n".join(row["id"] for row in items).encode()).hexdigest()[:16]
    same_as_m2bs = None
    if args.expect_ids:
        with open(args.expect_ids, encoding="utf-8") as handle:
            same_as_m2bs = [row["id"] for row in json.load(handle)["results"]] == [row["id"] for row in items]
        if not same_as_m2bs:
            raise SystemExit("The item IDs differ from the M2b-S run.")

    bench = Bench(args.sender, args.receiver, checkpoint=args.checkpoint, device=args.device)
    if args.per_message and not bench.same_tokenizer:
        parser.error("--per-message needs a sender and receiver with the same tokenizer")
    bench.fit_anchor_map()
    if not args.no_calibrated:
        bench.fit_calibrated_map(calibration_passages(args.calibration_passages, args.seed,
                                                      exclude={row["context"] for row in items}))
    print(json.dumps(bench.fit), flush=True)
    # Warm-up, so the first item's timing is fair.
    bench.answer([bench.embed(doc_text("Warm-up passage.")), bench.embed(question_suffix("Warm-up?"))], 2)
    bench.summary("Warm-up passage.")

    prepared = prepare(bench, items, args.summary_cache, args.per_message)
    results, swap_gaps = run(bench, items, prepared, args.per_message)
    for record, entry in zip(results, prepared):
        record["summary"] = entry["summary"]
    arms = [name for name in results[0] if name not in ("id", "summary")]
    summary = summarize(results, arms)
    meta = {"sender": args.sender, "receiver": args.receiver, "items": f"{args.items}, seed {args.seed}",
            "idsSha256": ids_digest, "sameIdsAsM2bS": same_as_m2bs, "sameTokenizer": bench.same_tokenizer,
            "checkpoint": bench.pair.checkpoint_id if bench.pair else None, "fit": bench.fit,
            "prefixTokens": sb.PREFIX_TOKENS, "alpha": sb.ALPHA, "ridge": sb.RIDGE,
            "targetNorm": round(bench.target_norm, 4),
            "meanSummaryTokens": round(sum(e["summaryTokens"] for e in prepared) / len(prepared), 1),
            "meanPassageAnchorShare": round(sum(e["anchorShare"] for e in prepared) / len(prepared), 4)}
    if swap_gaps:
        meta["statesSwappedRelativeChange"] = {"mean": sum(swap_gaps) / len(swap_gaps), "max": max(swap_gaps)}
        compared = [r["per-message, states swapped"]["sameAnswer"] for r in results
                    if r["per-message, states swapped"].get("sameAnswer") is not None]
        meta["statesSwappedSameAnswer"] = {"items": len(compared), "same": sum(compared)}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump({"meta": meta, "summary": summary, "results": results}, handle, indent=1, ensure_ascii=True)
    print(json.dumps({"meta": meta, "summary": summary}, indent=1))


if __name__ == "__main__":
    main()
