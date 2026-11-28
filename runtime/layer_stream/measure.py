"""T4 measurements. Run from runtime/ in the WSL venv, one phase per process:

    python -m layer_stream.measure timing --mode resident --out ~/t4/run1
    python -m layer_stream.measure timing --mode cpu --stream-share 0.5 --out ~/t4/run1
    python -m layer_stream.measure timing --mode disk --stream-share 0.5 --out ~/t4/run1
    python -m layer_stream.measure exact --mode resident --out ~/t4/run1     (then --mode cpu)
    python -m layer_stream.measure qwen14 --l2 ~/l2-compare/run1 --out ~/t4/run1
    python -m layer_stream.measure report --l2 ~/l2-compare/run1 --out ~/t4/run1

Every phase writes one JSON file of numbers into --out. Answers and passages stay there.
"""
import argparse
import io
import json
import os
import statistics
import time

READER = "mistralai/Mistral-7B-Instruct-v0.3"
LENGTHS = (512, 1024, 2048)
REPEATS = 3
EXACT_ITEMS = 10


def save(out, name, data):
    os.makedirs(out, exist_ok=True)
    target = os.path.join(out, name)
    with open(target + ".tmp", "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=1)
    os.replace(target + ".tmp", target)
    print("wrote", target, flush=True)


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def label(args):
    if args.mode == "resident":
        return "resident"
    return f"{args.mode}-{round(args.stream_share * 100)}"


def open_reader(args):
    from .stream import StreamedModel
    import torch
    from transformers import AutoConfig
    layers = AutoConfig.from_pretrained(args.model).num_hidden_layers
    resident = layers if args.mode == "resident" else layers - round(layers * args.stream_share)
    torch.cuda.reset_peak_memory_stats()
    start = time.perf_counter()
    reader = StreamedModel(args.model, resident_layers=resident, source="cpu" if args.mode == "resident" else args.mode)
    torch.cuda.synchronize()
    return reader, {"model": args.model, "mode": args.mode, "layers": layers, "residentLayers": resident,
                    "streamedLayers": layers - resident, "pinned": reader.pinned,
                    "loadSeconds": round(time.perf_counter() - start, 2),
                    "residentGiB": round(reader.resident_bytes() / 2 ** 30, 3),
                    "streamedGiBPerPass": round(reader.streamed_bytes() / 2 ** 30, 3),
                    "gpuAllocatedAfterLoadGiB": round(torch.cuda.memory_allocated() / 2 ** 30, 3)}


def drop_page_cache():
    os.sync()
    with open("/proc/sys/vm/drop_caches", "w") as handle:
        handle.write("1\n")


def passage_ids(tok, l2, count):
    items = load(os.path.join(os.path.expanduser(l2), "items.json"))["main"]
    text = "\n\n".join(item["passage"] for item in items)
    ids = tok(text, add_special_tokens=False)["input_ids"]
    if len(ids) < count:
        raise ValueError(f"Only {len(ids)} passage tokens available, {count} asked.")
    return ids[:count]


def kv_blob(cache):
    import torch
    buffer = io.BytesIO()
    torch.save([(layer.keys.cpu(), layer.values.cpu()) for layer in cache.layers], buffer)
    return buffer.getvalue()


def kv_from_blob(blob, config, device):
    import torch
    from transformers import DynamicCache
    data = torch.load(io.BytesIO(blob), map_location="cpu", weights_only=True)
    return DynamicCache(ddp_cache_data=[(k.to(device), v.to(device)) for k, v in data], config=config)


def cache_bytes(cache):
    return sum(layer.keys.numel() * layer.keys.element_size() + layer.values.numel() * layer.values.element_size()
               for layer in cache.layers)


def kv_then_decode(reader, out, before_decode=None):
    """Size, move and reload the passage's cache, then time one decode step on top of it.

    The cache is measured first: the decode step appends its token to the cache in place, and
    an earlier version serialized the grown cache (2,049 tokens for a 2,048-token passage).
    """
    import torch
    cache = out.past_key_values
    tokens = cache.layers[0].keys.shape[-2]
    size = cache_bytes(cache)
    start = time.perf_counter()
    blob = kv_blob(cache)
    saved = time.perf_counter()
    kv_from_blob(blob, reader.config, reader.device)
    reader.sync()
    loaded = time.perf_counter()
    token = int(out.logits[0, -1].argmax())
    if before_decode:
        before_decode()
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    begin = time.perf_counter()
    reader.forward([token], cache)
    reader.sync()
    decode = time.perf_counter() - begin
    return {"kvTokens": tokens, "kvBytes": size, "kvSerializedBytes": len(blob),
            "kvToHostAndSerializeSeconds": round(saved - start, 4), "kvLoadToGpuSeconds": round(loaded - saved, 4),
            "decodeStepSeconds": round(decode, 4)}


def bandwidth(reader):
    """Host-to-device GB/s for one streamed layer's tensors (pinned when the reader pinned them)."""
    import torch
    if not reader.streamed or reader.source != "cpu":
        return None
    host = next(iter(reader.streamed.values()))
    size = sum(t.numel() * t.element_size() for t in host.values())
    runs = []
    for _ in range(5):
        torch.cuda.synchronize()
        start = time.perf_counter()
        moved = [t.to(reader.device, non_blocking=reader.pinned) for t in host.values()]
        torch.cuda.synchronize()
        runs.append(time.perf_counter() - start)
        del moved
    return round(size / statistics.median(runs) / 1e9, 2)


def phase_timing(args):
    import torch
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(args.model)
    reader, info = open_reader(args)
    record = {**info, "h2dGBps": bandwidth(reader), "lengths": {}}
    try:
        warm = passage_ids(tok, args.l2, 128)
        reader.forward(warm)
        reader.sync()
        for length in LENGTHS:
            ids = passage_ids(tok, args.l2, length)
            runs, reads, peaks = [], [], []
            out = None
            for _ in range(REPEATS):
                out = None
                torch.cuda.empty_cache()
                if args.mode == "disk":
                    drop_page_cache()
                reader.stats["readSeconds"] = 0.0
                torch.cuda.reset_peak_memory_stats()
                torch.cuda.synchronize()
                start = time.perf_counter()
                out = reader.forward(ids)
                reader.sync()
                runs.append(time.perf_counter() - start)
                reads.append(reader.stats["readSeconds"])
                peaks.append(torch.cuda.max_memory_allocated())
            kv = kv_then_decode(reader, out, drop_page_cache if args.mode == "disk" else None)
            seconds = statistics.median(runs)
            record["lengths"][str(length)] = {
                "prefillSeconds": round(seconds, 4), "runs": [round(r, 4) for r in runs],
                "secondsPer1kTokens": round(seconds / length * 1000, 4),
                "diskReadSeconds": round(statistics.median(reads), 4) if args.mode == "disk" else None,
                "peakGpuGiB": round(max(peaks) / 2 ** 30, 3), **kv,
                "kvBytesPer1kTokens": round(kv["kvBytes"] / length * 1000)}
            if kv["kvTokens"] != length:
                raise RuntimeError(f"The cache measured holds {kv['kvTokens']} tokens, not {length}.")
            print(length, json.dumps(record["lengths"][str(length)]), flush=True)
            del out
    finally:
        reader.close()
    save(args.out, f"timing-{label(args)}.json", record)


def reader_prompter(model):
    from transformers import AutoTokenizer

    from latent_compare.prompting import Prompter

    class ReaderPrompts(Prompter):
        def __init__(self):
            self.tok = AutoTokenizer.from_pretrained(model)
            self.setup_prompts()
    return ReaderPrompts()


def phase_exact(args):
    """Per item: argmax at every prompt position, the uninterrupted greedy answer, the answer
    continued from the passage-prefix cache as computed, and from that cache moved to the host,
    serialized and loaded back. Only token ids are compared; answers stay in --out."""
    import torch
    from transformers import GenerationConfig
    prompts = reader_prompter(args.model)
    eos = GenerationConfig.from_pretrained(reader_dir(args.model)).eos_token_id
    eos = set(eos if isinstance(eos, (list, tuple)) else [eos]) | {prompts.tok.eos_token_id}
    items = load(os.path.join(os.path.expanduser(args.l2), "items.json"))["main"][:EXACT_ITEMS]
    reader, info = open_reader(args)
    rows = []
    try:
        for item in items:
            prepared = prompts.prepare(item["passage"], item["question"])
            ids, count = prepared["ids"], prepared["prefixTokens"]
            out = reader.forward(ids, logits_to_keep=0)
            argmax = out.logits[0].argmax(-1).tolist()
            del out
            whole = reader.greedy(ids, eos)
            prefix = reader.forward(ids[:count])
            split = reader.greedy(ids, eos, cache=prefix.past_key_values, cached=count)
            prefix = reader.forward(ids[:count])
            blob = kv_blob(prefix.past_key_values)
            del prefix
            torch.cuda.empty_cache()
            moved = reader.greedy(ids, eos, cache=kv_from_blob(blob, reader.config, reader.device), cached=count)
            rows.append({"id": item["id"], "promptTokens": len(ids), "prefixTokens": count, "argmax": argmax,
                         "whole": whole, "split": split, "moved": moved, "kvSerializedBytes": len(blob)})
            print(json.dumps([item["id"], len(ids), whole == split, split == moved]), flush=True)
    finally:
        reader.close()
    save(args.out, f"exact-{label(args)}.json", {**info, "items": rows})


def reader_dir(model):
    from .stream import checkpoint_dir
    return checkpoint_dir(model)


def phase_qwen14(args):
    """Qwen2.5-14B (AWQ, resident through vLLM) reads each L2 main item itself: the 14B upper bound."""
    from latent_compare import models
    from latent_compare.stats import score
    models.MODELS["qwen14"] = {"id": "Qwen/Qwen2.5-14B-Instruct-AWQ", "family": "Qwen2.5", "params": "14.7B",
                               "weights": "4-bit AWQ", "licence": "Apache-2.0",
                               "tokenizer": "byte-level BPE, 151k (Qwen2)", "template": "ChatML", "backend": "vllm"}
    from latent_compare.vllm_engine import VllmEngine
    items = load(os.path.join(os.path.expanduser(args.l2), "items.json"))["main"]
    engine = VllmEngine("qwen14")
    results = {}
    try:
        warm = engine.prepare("Warm-up passage.", "Warm-up?")
        engine.timed(warm["ids"], 2)
        for item in items:
            prepared = engine.prepare(item["passage"], item["question"])
            answer = engine.timed(prepared["ids"])
            results[item["id"]] = {"text": {**answer, **score(answer["answer"], item)}}
    finally:
        engine.close()
    save(args.out, "receive-qwen14.json", {"model": "qwen14", "results": results})


def phase_report(args):
    from .analysis import report
    print(json.dumps(report(os.path.expanduser(args.out), os.path.expanduser(args.l2)), indent=1))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("phase", choices=["timing", "exact", "qwen14", "report"])
    parser.add_argument("--mode", choices=["resident", "cpu", "disk"], default="resident")
    parser.add_argument("--stream-share", type=float, default=0.5, help="share of decoder layers streamed")
    parser.add_argument("--model", default=READER)
    parser.add_argument("--l2", default="~/l2-compare/run1", help="the L2 run folder (items and per-item answers)")
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    args.out = os.path.expanduser(args.out)
    {"timing": phase_timing, "exact": phase_exact, "qwen14": phase_qwen14, "report": phase_report}[args.phase](args)


if __name__ == "__main__":
    main()
