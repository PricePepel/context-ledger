"""Turn documents into aligned, padded sender and receiver batches."""
from dataclasses import dataclass

import torch

from .align import causal_mask, sender_positions


@dataclass
class Pair:
    """One batch of documents, tokenized by both sides (right padded)."""
    sender_ids: torch.Tensor        # [B, S]
    sender_mask: torch.Tensor       # [B, S]
    receiver_ids: torch.Tensor      # [B, R]
    receiver_mask: torch.Tensor     # [B, R]
    sender_pos: torch.Tensor        # [B, S] fractional receiver-axis positions
    cross_allowed: torch.Tensor     # [B, R, S] bool, padding excluded

    def to(self, device):
        return Pair(*(getattr(self, name).to(device) for name in self.__dataclass_fields__))


def spans(tokenizer, text, max_tokens):
    encoded = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True,
                        truncation=True, max_length=max_tokens)
    return encoded["input_ids"], [tuple(span) for span in encoded["offset_mapping"]]


def cut_to_common_end(sender, receiver):
    """After truncation the two sides may cover different text. Keep, on each side,
    only tokens that end within the shorter side's coverage, so both describe the
    same characters."""
    (s_ids, s_spans), (r_ids, r_spans) = sender, receiver
    limit = min(s_spans[-1][1] if s_spans else 0, r_spans[-1][1] if r_spans else 0)
    keep_s = [i for i, (_, end) in enumerate(s_spans) if end <= limit]
    keep_r = [i for i, (_, end) in enumerate(r_spans) if end <= limit]
    return ([s_ids[i] for i in keep_s], [s_spans[i] for i in keep_s]), \
        ([r_ids[i] for i in keep_r], [r_spans[i] for i in keep_r])


def pad(rows, value):
    width = max(len(row) for row in rows)
    return torch.tensor([row + [value] * (width - len(row)) for row in rows])


def make_pair(sender_tokenizer, receiver_tokenizer, texts, max_tokens=384):
    sender_rows, receiver_rows = [], []
    for text in texts:
        s, r = cut_to_common_end(spans(sender_tokenizer, text, max_tokens),
                                 spans(receiver_tokenizer, text, max_tokens))
        if not s[0] or not r[0]:
            raise ValueError("A document produced no tokens on one side.")
        sender_rows.append(s)
        receiver_rows.append(r)
    sender_ids = pad([ids for ids, _ in sender_rows], 0)
    receiver_ids = pad([ids for ids, _ in receiver_rows], 0)
    sender_mask = pad([[1] * len(ids) for ids, _ in sender_rows], 0)
    receiver_mask = pad([[1] * len(ids) for ids, _ in receiver_rows], 0)
    batch, s_len = sender_ids.shape
    r_len = receiver_ids.shape[1]
    positions = torch.zeros(batch, s_len)
    allowed = torch.zeros(batch, r_len, s_len, dtype=torch.bool)
    for row, ((_, s_spans), (_, r_spans)) in enumerate(zip(sender_rows, receiver_rows)):
        positions[row, :len(s_spans)] = torch.tensor(sender_positions(s_spans, r_spans))
        allowed[row, :len(r_spans), :len(s_spans)] = torch.tensor(causal_mask(s_spans, r_spans))
    return Pair(sender_ids, sender_mask, receiver_ids, receiver_mask, positions, allowed)
