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

from latent_transfer.data import summary_request

from .models import MODELS, shape_of
from .prompts import (SENTINEL, chat_messages, closed_content, cut_passage, fit_tokens, prefix_token_count,
                      split_rendered, supports_system, user_content)

ANSWER_TOKENS = 24
SUMMARY_TOKENS = 96
# Slack for tokens that merge or split differently once the passage replaces the sentinel.
JOIN_SLACK = 8


class Engine:
    def __init__(self, key, device="cuda"):
        spec = MODELS[key]
        self.key, self.name, self.device = key, spec["id"], device
        self.tok = AutoTokenizer.from_pretrained(self.name)
        dtype = spec.get("dtype") or torch.bfloat16
        self.model = AutoModelForCausalLM.from_pretrained(self.name, dtype=dtype).to(device).eval()
        for parameter in self.model.parameters():
            parameter.requires_grad_(False)
        self.shape = shape_of(self.model.config.to_dict())
        self.system_ok = supports_system(lambda messages: self.tok.apply_chat_template(messages, tokenize=False))
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

    # Prompts --------------------------------------------------------------
    def render(self, messages):
        return self.tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)

    def count(self, text):
        return len(self.tok(text, add_special_tokens=False)["input_ids"])

    def fit(self, passage, other_tokens, limit, reserve):
        """(passage cut to fit, passage tokens, kept tokens, truncated)."""
        encoded = self.tok(passage, add_special_tokens=False, return_offsets_mapping=True)
        total = len(encoded["input_ids"])
        if limit is None:
            return passage, total, total, False
        kept, truncated = fit_tokens(total, other_tokens + JOIN_SLACK, limit, reserve)
        if not truncated:
            return passage, total, total, False
        cut = cut_passage(passage, encoded["offset_mapping"], kept)
        # Counted again on the cut text: several byte-level tokens can end on one character,
        # so the cut can keep a token or two more than asked for.
        return cut, total, self.count(cut), True

    def prepare(self, passage, question, abstain=False, system=None, limit=None):
        """Token ids of the full prompt and how many of them form the hand-over prefix.

        prepareMs (rendering, fitting and tokenizing) is part of every arm's time end to end.
        """
        start = time.perf_counter()
        rendered = self.render(chat_messages(user_content(SENTINEL, question, abstain), system, self.system_ok))
        passage, total, kept, truncated = self.fit(passage, self.count(rendered), limit, ANSWER_TOKENS)
        prefix, suffix = split_rendered(rendered, passage)
        encoded = self.tok(prefix + suffix, add_special_tokens=False, return_offsets_mapping=True)
        ids = encoded["input_ids"]
        if limit is not None and len(ids) + ANSWER_TOKENS > limit:
            raise ValueError(f"Prompt of {len(ids)} tokens does not fit the context of {limit}.")
        return {"ids": ids, "prefixTokens": prefix_token_count(encoded["offset_mapping"], len(prefix)),
                "promptTokens": len(ids), "passageTokens": total, "keptTokens": kept, "truncated": truncated,
                "passageBytes": len(passage.encode("utf-8")), "prepareMs": (time.perf_counter() - start) * 1000}

    def closed_ids(self, question):
        return self.tok(self.render(chat_messages(closed_content(question))), add_special_tokens=False)["input_ids"]

    def summary_ids(self, passage, limit=None):
        rendered = self.render(chat_messages(summary_request(SENTINEL)))
        passage, total, kept, truncated = self.fit(passage.strip(), self.count(rendered), limit, SUMMARY_TOKENS)
        ids = self.tok(rendered.replace(SENTINEL, passage), add_special_tokens=False)["input_ids"]
        if limit is not None and len(ids) + SUMMARY_TOKENS > limit:
            raise ValueError(f"Summary prompt of {len(ids)} tokens does not fit the context of {limit}.")
        return ids, {"passageTokens": total, "keptTokens": kept, "truncated": truncated}

    def summarize(self, passage, limit=None, max_new_tokens=SUMMARY_TOKENS):
        """The sender's summary of a passage, timed from the raw text to the last token."""
        start = time.perf_counter()
        ids, info = self.summary_ids(passage, limit)
        text, tokens = self.greedy(ids, max_new_tokens)
        return {"summary": text, "ms": (time.perf_counter() - start) * 1000, "newTokens": tokens,
                "bytes": len(text.encode("utf-8")), **info}

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
