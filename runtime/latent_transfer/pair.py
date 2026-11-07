"""A sender/receiver pair plus its mapper: the pieces training, evals and serving share."""
import hashlib
import json
import os
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from .batch import make_pair
from .kv import build_cache, continue_from_cache, greedy_after_cache, model_shape, prefill
from .mapper import Mapper, init_weights

SENDER = "Qwen/Qwen2.5-0.5B-Instruct"
RECEIVER = "HuggingFaceTB/SmolLM2-360M-Instruct"


def load_model(name, device, dtype=torch.bfloat16):
    model = AutoModelForCausalLM.from_pretrained(name, dtype=dtype).to(device).eval()
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    return model


class TransferPair:
    def __init__(self, sender=SENDER, receiver=RECEIVER, device="cuda", mapper_config=None, checkpoint=None):
        self.device = device
        self.sender_name, self.receiver_name = sender, receiver
        self.sender_tok = AutoTokenizer.from_pretrained(sender)
        self.receiver_tok = AutoTokenizer.from_pretrained(receiver)
        self.sender = load_model(sender, device)
        self.receiver = load_model(receiver, device)
        state = None
        if checkpoint:
            state = torch.load(checkpoint, map_location="cpu", weights_only=True)
            if (state["sender"], state["receiver"]) != (sender, receiver):
                raise ValueError(f"Checkpoint is for {state['sender']} -> {state['receiver']}.")
            mapper_config = state["config"]
        config = dict(mapper_config or {})
        embed_dim = self.receiver.get_input_embeddings().embedding_dim
        config.pop("receiver_embed_dim", None)
        self.mapper = init_weights(Mapper(model_shape(self.sender), model_shape(self.receiver),
                                          receiver_embed_dim=embed_dim, **config)).to(device)
        if state:
            self.mapper.load_state_dict(state["mapper"])
        self.checkpoint_id = state["id"] if state else None
        self.eos = {self.receiver_tok.convert_tokens_to_ids("<|im_end|>"), self.receiver_tok.eos_token_id}

    # Caches ---------------------------------------------------------------
    def pair(self, texts, max_tokens=384):
        return make_pair(self.sender_tok, self.receiver_tok, texts, max_tokens).to(self.device)

    def sender_cache(self, batch):
        return prefill(self.sender, batch.sender_ids, batch.sender_mask)

    def receiver_cache(self, batch):
        return prefill(self.receiver, batch.receiver_ids, batch.receiver_mask)

    def predict(self, batch, sender=None):
        """Mapper output in calibrated units (keys before RoPE)."""
        sender = sender or self.sender_cache(batch)
        embeds = self.receiver.get_input_embeddings()(batch.receiver_ids)
        # The mapper keeps fp32 weights and runs in bf16 like the frozen models, in
        # training and at inference alike.
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=str(self.device).startswith("cuda")):
            return self.mapper(embeds, batch.receiver_mask, sender.keys, sender.values,
                               batch.sender_pos, batch.cross_allowed & batch.sender_mask.bool()[:, None, :])

    def receiver_from_mapper(self, batch):
        keys, values = self.mapper.scaled(*self.predict(batch))
        return build_cache(self.receiver, keys, values)

    # Decoding -------------------------------------------------------------
    def encode(self, text):
        return torch.tensor([self.receiver_tok(text, add_special_tokens=False)["input_ids"]], device=self.device)

    def decode(self, ids):
        return self.receiver_tok.decode(ids, skip_special_tokens=True).strip()

    @torch.no_grad()
    def answer_from_text(self, document, suffix, max_new_tokens=24):
        """Receiver reads the document itself. Same tokens as the cache path: doc then suffix."""
        batch = self.pair([document])
        own = self.receiver_cache(batch)
        cache = build_cache(self.receiver, own.keys, own.values)
        return self.decode(greedy_after_cache(self.receiver, cache, batch.receiver_mask, self.encode(suffix),
                                              max_new_tokens, self.eos))

    @torch.no_grad()
    def answer_from_sender(self, document, suffix, max_new_tokens=24, zero_sender=False):
        """Sender prefills the document, the mapper writes the receiver cache, the receiver answers.

        zero_sender=True is the eval's control: the same mapper and receiver tokens, but the
        sender's keys and values are zeros, so whatever survives did not come from the sender.
        """
        timings = {}
        start = time.perf_counter()
        batch = self.pair([document])
        timings["alignMs"] = (time.perf_counter() - start) * 1000
        start = time.perf_counter()
        sender = self.sender_cache(batch)
        if zero_sender:
            sender.keys = [torch.zeros_like(k) for k in sender.keys]
            sender.values = [torch.zeros_like(v) for v in sender.values]
        self._sync()
        timings["senderMs"] = (time.perf_counter() - start) * 1000
        start = time.perf_counter()
        keys, values = self.mapper.scaled(*self.predict(batch, sender))
        cache = build_cache(self.receiver, keys, values)
        self._sync()
        timings["mapperMs"] = (time.perf_counter() - start) * 1000
        tokens = greedy_after_cache(self.receiver, cache, batch.receiver_mask, self.encode(suffix),
                                    max_new_tokens, self.eos)
        receipt = {"senderTokens": int(batch.sender_mask.sum()), "receiverTokens": int(batch.receiver_mask.sum()),
                   **timings}
        return self.decode(tokens), receipt

    @torch.no_grad()
    def answer_closed(self, prompt, max_new_tokens=24):
        ids = self.encode(prompt)
        out = self.receiver.generate(ids, attention_mask=torch.ones_like(ids), max_new_tokens=max_new_tokens,
                                     do_sample=False, eos_token_id=list(self.eos),
                                     pad_token_id=self.receiver_tok.pad_token_id or 0)
        return self.decode(out[0, ids.shape[1]:].tolist())

    @torch.no_grad()
    def sender_generate(self, prompt, max_new_tokens=96):
        ids = torch.tensor([self.sender_tok(prompt, add_special_tokens=False)["input_ids"]], device=self.device)
        out = self.sender.generate(ids, attention_mask=torch.ones_like(ids), max_new_tokens=max_new_tokens,
                                   do_sample=False, pad_token_id=self.sender_tok.pad_token_id or 0)
        return self.sender_tok.decode(out[0, ids.shape[1]:], skip_special_tokens=True).strip()

    def _sync(self):
        if str(self.device).startswith("cuda"):
            torch.cuda.synchronize()

    # Checkpoints ----------------------------------------------------------
    def save(self, path, meta):
        config = {key: value for key, value in self.mapper.config.items() if key != "receiver_embed_dim"}
        body = json.dumps({"sender": self.sender_name, "receiver": self.receiver_name, "config": config,
                           "meta": meta}, sort_keys=True)
        checkpoint_id = hashlib.sha256(body.encode()).hexdigest()[:16]
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        torch.save({"sender": self.sender_name, "receiver": self.receiver_name, "config": config,
                    "mapper": {k: v.detach().cpu() for k, v in self.mapper.state_dict().items()},
                    "meta": meta, "id": checkpoint_id}, path)
        return checkpoint_id
