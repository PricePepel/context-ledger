"""Turn documents into aligned, padded sender and receiver batches."""
from dataclasses import dataclass

import torch

from .align import ALIGNMENT_RULE, RULE_RAW, align_document, blind_receiver, sender_positions, unread_sender


@dataclass
class Pair:
    """One batch of documents, tokenized by both sides (right padded)."""
    sender_ids: torch.Tensor        # [B, S]
    sender_mask: torch.Tensor       # [B, S]
    receiver_ids: torch.Tensor      # [B, R]
    receiver_mask: torch.Tensor     # [B, R]
    sender_pos: torch.Tensor        # [B, S] fractional receiver-axis positions
    cross_allowed: torch.Tensor     # [B, R, S] bool, padding excluded
    # What does not line up, said outright instead of left to the mask (L3):
    sender_unread: torch.Tensor     # [B, S] bool: a real sender token no receiver token may read
    receiver_blind: torch.Tensor    # [B, R] bool: a real receiver token that reads no sender token (sink only)
    dropped: torch.Tensor           # [B, 2] sender and receiver tokens cut so both sides end together

    def to(self, device):
        return Pair(*(getattr(self, name).to(device) for name in self.__dataclass_fields__))


def spans(tokenizer, text, max_tokens, rule=RULE_RAW):
    """Token ids and raw character spans. Rule 1 lets the tokenizer truncate; rule 2
    takes the whole text, because refining the spans needs to know where it ends."""
    if rule == RULE_RAW:
        encoded = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True,
                            truncation=True, max_length=max_tokens)
    else:
        encoded = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True,
                            truncation=False, verbose=False)
    return encoded["input_ids"], [tuple(span) for span in encoded["offset_mapping"]]


def pad(rows, value):
    width = max(len(row) for row in rows)
    return torch.tensor([row + [value] * (width - len(row)) for row in rows])


def make_pair(sender_tokenizer, receiver_tokenizer, texts, max_tokens=384, rule=ALIGNMENT_RULE):
    sender_rows, receiver_rows, dropped = [], [], []
    for text in texts:
        s_ids, s_raw = spans(sender_tokenizer, text, max_tokens, rule)
        r_ids, r_raw = spans(receiver_tokenizer, text, max_tokens, rule)
        keep_s, s_spans, keep_r, r_spans = align_document(s_raw, r_raw, len(text), max_tokens, rule)
        if not keep_s or not keep_r:
            raise ValueError("A document produced no tokens on one side.")
        sender_rows.append(([s_ids[i] for i in keep_s], s_spans))
        receiver_rows.append(([r_ids[i] for i in keep_r], r_spans))
        dropped.append([min(len(s_ids), max_tokens) - len(keep_s), min(len(r_ids), max_tokens) - len(keep_r)])
    sender_ids = pad([ids for ids, _ in sender_rows], 0)
    receiver_ids = pad([ids for ids, _ in receiver_rows], 0)
    sender_mask = pad([[1] * len(ids) for ids, _ in sender_rows], 0)
    receiver_mask = pad([[1] * len(ids) for ids, _ in receiver_rows], 0)
    batch, s_len = sender_ids.shape
    r_len = receiver_ids.shape[1]
    positions = torch.zeros(batch, s_len)
    allowed = torch.zeros(batch, r_len, s_len, dtype=torch.bool)
    unread = torch.zeros(batch, s_len, dtype=torch.bool)
    blind = torch.zeros(batch, r_len, dtype=torch.bool)
    for row, ((_, s_spans), (_, r_spans)) in enumerate(zip(sender_rows, receiver_rows)):
        positions[row, :len(s_spans)] = torch.tensor(sender_positions(s_spans, r_spans))
        # align.causal_mask, vectorized: sender token end <= receiver token end. Refined
        # spans can be exact fractions; equal fractions give equal float64 values.
        s_ends = torch.tensor([float(end) for _, end in s_spans], dtype=torch.float64)
        r_ends = torch.tensor([float(end) for _, end in r_spans], dtype=torch.float64)
        allowed[row, :len(r_spans), :len(s_spans)] = s_ends[None, :] <= r_ends[:, None]
        unread[row, :len(s_spans)] = torch.tensor(unread_sender(s_spans, r_spans))
        blind[row, :len(r_spans)] = torch.tensor(blind_receiver(s_spans, r_spans))
    return Pair(sender_ids, sender_mask, receiver_ids, receiver_mask, positions, allowed,
                unread, blind, torch.tensor(dropped))
