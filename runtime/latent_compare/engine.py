"""One loaded model: prompts in its own template, greedy answers, and a cache it can hand over.

Needs torch and transformers (the WSL venv). The text arm and the cache arm feed the model
the same token ids; the only difference is that the cache arm computes the prefix's KV cache
in a separate call, serializes it, reads it back and continues from it.
"""
import gc
import io
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, DynamicCache

from .models import MODELS, shape_of
from .prompting import ANSWER_TOKENS, SUMMARY_TOKENS, Prompter  # noqa: F401 - SUMMARY_TOKENS is re-exported


class Engine(Prompter):
    hands_over_cache = True

    def __init__(self, key, device="cuda"):
        spec = MODELS[key]
        self.key, self.name, self.device = key, spec["id"], device
        self.tok = AutoTokenizer.from_pretrained(self.name)
        dtype = spec.get("dtype") or torch.bfloat16
        self.model = AutoModelForCausalLM.from_pretrained(self.name, dtype=dtype).to(device).eval()
        for parameter in self.model.parameters():
            parameter.requires_grad_(False)
        self.shape = shape_of(self.model.config.to_dict())
        self.setup_prompts()
        eos = self.model.generation_config.eos_token_id
        self.eos = set(eos if isinstance(eos, (list, tuple)) else [eos]) | {self.tok.eos_token_id}
        self.eos.discard(None)

    def close(self):
        self.model = None
        gc.collect()
        torch.cuda.empty_cache()

    def describe(self):
        return {**MODELS[self.key], "key": self.key, **self.shape, "systemRole": self.system_ok,
                "cacheDtype": str(next(self.model.parameters()).dtype).replace("torch.", ""),
                "gpuGiB": round(torch.cuda.memory_allocated() / 2 ** 30, 2)}

    def recover(self):
        """After a failed arm: drop what it left on the GPU so the next arm starts clean."""
        gc.collect()
        torch.cuda.empty_cache()

    # Decoding -------------------------------------------------------------
    def sync(self):
        if str(self.device).startswith("cuda"):
            torch.cuda.synchronize()

    @torch.no_grad()
    def greedy(self, ids, max_new_tokens=ANSWER_TOKENS, cache=None, cached=0):
        """Greedy continuation of ids. With a cache, the first `cached` ids are not run again."""
        feed = torch.tensor([ids[cached:]], device=self.device)
        generated = []
        for _ in range(max_new_tokens):
            out = self.model(input_ids=feed, past_key_values=cache, use_cache=True)
            cache = out.past_key_values
            token = int(out.logits[0, -1].argmax())
            if token in self.eos:
                break
            generated.append(token)
            feed = torch.tensor([[token]], device=self.device)
        self.sync()
        return self.tok.decode(generated, skip_special_tokens=True).strip(), len(generated)

    def timed(self, ids, max_new_tokens=ANSWER_TOKENS):
        start = time.perf_counter()
        text, tokens = self.greedy(ids, max_new_tokens)
        return {"answer": text, "ms": (time.perf_counter() - start) * 1000, "newTokens": tokens}

    # Cache hand-over ------------------------------------------------------
    def load_blob(self, blob):
        """The receiver's side: bytes back into a cache on the GPU."""
        data = torch.load(io.BytesIO(blob), map_location="cpu", weights_only=True)
        return DynamicCache(ddp_cache_data=[(k.to(self.device), v.to(self.device)) for k, v in data],
                            config=self.model.config)

    def answer_from_cache(self, prepared):
        """Prefill the prefix, hand the cache over as bytes, answer from it. Returns the record."""
        ids, count = prepared["ids"], prepared["prefixTokens"]
        if count == 0 or count >= len(ids):
            # Nothing to hand over (or nothing left to read): the receiver reads the prompt itself.
            record = self.timed(ids)
            return {**record, "bytes": 0, "prefixTokens": count, "prefillMs": 0.0, "saveMs": 0.0, "loadMs": 0.0,
                    "answerMs": record["ms"]}
        start = time.perf_counter()
        with torch.no_grad():
            out = self.model(input_ids=torch.tensor([ids[:count]], device=self.device), use_cache=True)
        self.sync()
        prefilled = time.perf_counter()
        buffer = io.BytesIO()
        torch.save([(layer.keys.cpu(), layer.values.cpu()) for layer in out.past_key_values.layers], buffer)
        blob = buffer.getvalue()
        del out, buffer
        saved = time.perf_counter()
        cache = self.load_blob(blob)
        self.sync()
        loaded = time.perf_counter()
        text, tokens = self.greedy(ids, cache=cache, cached=count)
        done = time.perf_counter()
        return {"answer": text, "newTokens": tokens, "bytes": len(blob), "prefixTokens": count,
                "prefillMs": (prefilled - start) * 1000, "saveMs": (saved - prefilled) * 1000,
                "loadMs": (loaded - saved) * 1000, "answerMs": (done - loaded) * 1000, "ms": (done - start) * 1000}
