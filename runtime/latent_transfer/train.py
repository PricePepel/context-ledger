"""Train a SwaT-style mapper for one sender -> receiver pair.

    python -m latent_transfer.train --out ~/m2b/run1 --stage1-steps 3000 --stage2-steps 3000

Stage 1: normalized MSE against the receiver's own prefill cache (keys before RoPE).
Stage 2: the receiver's next-token loss on answers and continuations, with the
predicted cache in place of the text; gradients pass through the frozen receiver.

Data: WikiText-103 paragraphs and SQuAD train contexts (stage 1); SQuAD train
question/answer pairs and WikiText continuations (stage 2). A dev set of SQuAD train
articles is held out from training, so tuning never looks at the eval split.
"""
import argparse
import json
import math
import os
import random
import time

import torch
import torch.nn.functional as F

from .data import doc_text, f1, question_suffix, squad, wikitext
from .mapper import calibrate_sigma, parameter_count
from .pair import TransferPair

DEV_TITLES = 20  # SQuAD train articles kept out of training, for dev F1 during training


def split_squad(seed):
    rows = squad("train")
    titles = sorted({row["title"] for row in rows})
    random.Random(seed).shuffle(titles)
    dev_titles = set(titles[:DEV_TITLES])
    train = [row for row in rows if row["title"] not in dev_titles]
    dev = [row for row in rows if row["title"] in dev_titles]
    return train, dev


def cosine(step, total, warmup, peak):
    if step < warmup:
        return peak * (step + 1) / warmup
    progress = (step - warmup) / max(1, total - warmup)
    return peak * 0.5 * (1 + math.cos(math.pi * min(1.0, progress)))


def stage1_loss(pair, batch):
    with torch.no_grad():
        target = pair.receiver_cache(batch)
    keys, values = pair.predict(batch)
    sigma = pair.mapper.sigma
    weight = batch.receiver_mask.float()[:, None, :, None]
    total, count = 0.0, weight.sum() * keys[0].shape[1] * keys[0].shape[-1] * len(keys) * 2
    for layer, (k, v) in enumerate(zip(keys, values)):
        k_target = target.keys[layer].float() / sigma[layer, :, 0][None, :, None, None]
        v_target = target.values[layer].float() / sigma[layer, :, 1][None, :, None, None]
        total = total + ((k.float() - k_target) ** 2 * weight).sum() + ((v.float() - v_target) ** 2 * weight).sum()
    return total / count


def stage2_loss(pair, batch, suffixes, targets):
    """suffixes: per row, the receiver tokens after the cache; targets: per row, a 0/1 list
    marking which suffix tokens are predicted (loss is on those only)."""
    keys, values = pair.mapper.scaled(*pair.predict(batch))
    from .kv import build_cache, continue_from_cache
    cache = build_cache(pair.receiver, keys, values)
    width = max(len(s) for s in suffixes)
    ids = torch.tensor([s + [0] * (width - len(s)) for s in suffixes], device=pair.device)
    mask = torch.tensor([[1] * len(s) + [0] * (width - len(s)) for s in suffixes], device=pair.device)
    labels = torch.tensor([t + [0] * (width - len(t)) for t in targets], device=pair.device)
    out = continue_from_cache(pair.receiver, cache, batch.receiver_mask, ids, mask)
    logits = out.logits[:, :-1].float()
    gold, weight = ids[:, 1:], labels[:, 1:].float()
    loss = F.cross_entropy(logits.reshape(-1, logits.shape[-1]), gold.reshape(-1), reduction="none")
    return (loss * weight.reshape(-1)).sum() / weight.sum().clamp(min=1)


def qa_sample(pair, row):
    """Document, then question + answer; loss on the answer and the end-of-turn token."""
    question = pair.receiver_tok(question_suffix(row["question"]), add_special_tokens=False)["input_ids"]
    answer = pair.receiver_tok(row["answers"][0] + "<|im_end|>", add_special_tokens=False)["input_ids"]
    # Token t's logits predict token t+1: mark the last question token's successor onward.
    return doc_text(row["context"]), question + answer, [0] * len(question) + [1] * len(answer)


def lm_sample(pair, paragraph, rng):
    """Document is the paragraph's first part; the receiver continues it (empty question)."""
    cut = int(len(paragraph) * rng.uniform(0.5, 0.75))
    cut = paragraph.rfind(" ", 0, cut) if paragraph.rfind(" ", 0, cut) > 0 else cut
    rest = pair.receiver_tok(paragraph[cut:], add_special_tokens=False)["input_ids"][:48]
    return doc_text(paragraph[:cut]), rest, [1] * len(rest)


@torch.no_grad()
def dev_f1(pair, rows):
    pair.mapper.eval()
    scores = [f1(pair.answer_from_sender(doc_text(r["context"]), question_suffix(r["question"]))[0], r["answers"])
              for r in rows]
    pair.mapper.train()
    return sum(scores) / len(scores)


@torch.no_grad()
def nmse(pair, batches):
    pair.mapper.eval()
    values = [float(stage1_loss(pair, b)) for b in batches]
    pair.mapper.train()
    return sum(values) / len(values)


def fits(pair, text, max_tokens):
    return (len(pair.receiver_tok(text, add_special_tokens=False)["input_ids"]) <= max_tokens and
            len(pair.sender_tok(text, add_special_tokens=False)["input_ids"]) <= max_tokens)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--stage1-steps", type=int, default=3000)
    parser.add_argument("--stage2-steps", type=int, default=3000)
    parser.add_argument("--batch1", type=int, default=16)
    parser.add_argument("--batch2", type=int, default=8)
    parser.add_argument("--lr1", type=float, default=3e-4)
    parser.add_argument("--lr2", type=float, default=2e-5)
    parser.add_argument("--qa-share", type=float, default=0.7)
    parser.add_argument("--dim", type=int, default=512)
    parser.add_argument("--heads", type=int, default=8)
    parser.add_argument("--ffn", type=int, default=2048)
    parser.add_argument("--blocks", type=int, default=8)
    parser.add_argument("--max-tokens", type=int, default=384)
    parser.add_argument("--resume", help="checkpoint to start stage 2 from (skips stage 1)")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    os.makedirs(os.path.expanduser(args.out), exist_ok=True)
    out = os.path.expanduser(args.out)
    log_path = os.path.join(out, "log.jsonl")
    rng = random.Random(args.seed)
    torch.manual_seed(args.seed)

    def log(**fields):
        fields["time"] = round(time.time(), 1)
        print(json.dumps(fields), flush=True)
        with open(log_path, "a") as handle:
            handle.write(json.dumps(fields) + "\n")

    config = dict(dim=args.dim, heads=args.heads, ffn=args.ffn, blocks=args.blocks)
    pair = TransferPair(mapper_config=config, checkpoint=args.resume)
    log(event="start", args=vars(args), mapperParams=parameter_count(pair.mapper))

    squad_train, squad_dev = split_squad(args.seed)
    dev_rows = [r for r in random.Random(1).sample(squad_dev, 300) if fits(pair, doc_text(r["context"]), args.max_tokens)][:100]
    wiki = wikitext("train")
    wiki_val = wikitext("validation")
    contexts = sorted({row["context"] for row in squad_train})
    log(event="data", squadTrain=len(squad_train), squadDev=len(dev_rows), wiki=len(wiki), contexts=len(contexts))

    val_docs = [doc_text(p) for p in random.Random(2).sample(wiki_val, 64)]
    val_batches = [pair.pair(val_docs[i:i + 16], args.max_tokens) for i in range(0, 64, 16)]

    params = [p for p in pair.mapper.parameters() if p.requires_grad]

    # ---------------------------------------------------------------- stage 1
    if not args.resume:
        calib = [pair.pair([doc_text(p) for p in rng.sample(wiki, 16)], args.max_tokens) for _ in range(16)]
        caches = [pair.receiver_cache(b) for b in calib]
        pair.mapper.sigma.copy_(calibrate_sigma([c.keys for c in caches], [c.values for c in caches],
                                                [b.receiver_mask for b in calib]).to(pair.device))
        del caches
        log(event="calibrated", sigmaKeys=round(float(pair.mapper.sigma[..., 0].mean()), 4),
            sigmaValues=round(float(pair.mapper.sigma[..., 1].mean()), 4))
        optimizer = torch.optim.AdamW(params, lr=args.lr1, betas=(0.9, 0.95), weight_decay=1e-3)
        log(event="stage1", nmse=round(nmse(pair, val_batches), 4), step=0)
        started = time.time()
        for step in range(args.stage1_steps):
            for group in optimizer.param_groups:
                group["lr"] = cosine(step, args.stage1_steps, 200, args.lr1)
            docs = [doc_text(rng.choice(contexts) if rng.random() < 0.3 else rng.choice(wiki))
                    for _ in range(args.batch1)]
            batch = pair.pair(docs, args.max_tokens)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                loss = stage1_loss(pair, batch)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            norm = torch.nn.utils.clip_grad_norm_(params, 1.0)
            optimizer.step()
            if (step + 1) % 100 == 0:
                log(event="stage1", step=step + 1, loss=round(float(loss), 4), grad=round(float(norm), 3),
                    secPerStep=round((time.time() - started) / (step + 1), 3))
            if (step + 1) % 1000 == 0 or step + 1 == args.stage1_steps:
                log(event="stage1-eval", step=step + 1, nmse=round(nmse(pair, val_batches), 4),
                    devF1=round(dev_f1(pair, dev_rows[:50]), 4))
        checkpoint_id = pair.save(os.path.join(out, "stage1.pt"), {"stage": 1, "steps": args.stage1_steps})
        log(event="saved", path="stage1.pt", id=checkpoint_id)

    # ---------------------------------------------------------------- stage 2
    optimizer = torch.optim.AdamW(params, lr=args.lr2, betas=(0.9, 0.95), weight_decay=1e-3)
    best, started = -1.0, time.time()
    log(event="stage2-eval", step=0, devF1=round(dev_f1(pair, dev_rows), 4))
    for step in range(args.stage2_steps):
        for group in optimizer.param_groups:
            group["lr"] = args.lr2 * min(1.0, (step + 1) / 100)
        docs, suffixes, targets = [], [], []
        while len(docs) < args.batch2:
            if rng.random() < args.qa_share:
                sample = qa_sample(pair, rng.choice(squad_train))
            else:
                sample = lm_sample(pair, rng.choice(wiki), rng)
            if len(sample[1]) < 2 or not fits(pair, sample[0], args.max_tokens):
                continue
            docs.append(sample[0]); suffixes.append(sample[1]); targets.append(sample[2])
        batch = pair.pair(docs, args.max_tokens)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            loss = stage2_loss(pair, batch, suffixes, targets)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        norm = torch.nn.utils.clip_grad_norm_(params, 1.0)
        optimizer.step()
        if (step + 1) % 100 == 0:
            log(event="stage2", step=step + 1, loss=round(float(loss), 4), grad=round(float(norm), 3),
                secPerStep=round((time.time() - started) / (step + 1), 3))
        if (step + 1) % 500 == 0 or step + 1 == args.stage2_steps:
            score = dev_f1(pair, dev_rows)
            log(event="stage2-eval", step=step + 1, devF1=round(score, 4), nmse=round(nmse(pair, val_batches), 4))
            if score > best:
                best = score
                checkpoint_id = pair.save(os.path.join(out, "best.pt"), {"stage": 2, "step": step + 1, "devF1": score})
                log(event="saved", path="best.pt", id=checkpoint_id, devF1=round(score, 4))
    pair.save(os.path.join(out, "last.pt"), {"stage": 2, "steps": args.stage2_steps})
    log(event="done", bestDevF1=round(best, 4))


if __name__ == "__main__":
    main()
