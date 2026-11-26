"""Turn documents into aligned, padded sender and receiver batches."""
from dataclasses import dataclass

import torch

from .align import ALIGNMENT_RULE, RULE_RAW, align_document


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
        aligned = align_document(s_raw, r_raw, len(text), max_tokens, rule)
        if not aligned.sender_keep or not aligned.receiver_keep:
            raise ValueError("A document produced no tokens on one side.")
        sender_rows.append(([s_ids[i] for i in aligned.sender_keep], aligned))
        receiver_rows.append(([r_ids[i] for i in aligned.receiver_keep], aligned))
        budget = max(len(s_ids), len(r_ids)) if max_tokens is None else max_tokens
        dropped.append([min(len(s_ids), budget) - len(aligned.sender_keep),
                        min(len(r_ids), budget) - len(aligned.receiver_keep)])
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
    for row, (_, aligned) in enumerate(sender_rows):
        s_keys, r_keys = aligned.sender_keys, aligned.receiver_keys
        positions[row, :len(s_keys)] = torch.tensor(aligned.positions())
        # align.causal_mask, vectorized over integer keys (rule 1: the raw span ends), so
        # the comparison is exact whatever fractions the refined spans hold.
        allowed[row, :len(r_keys), :len(s_keys)] = torch.tensor(s_keys)[None, :] <= torch.tensor(r_keys)[:, None]
        unread[row, :len(s_keys)] = torch.tensor(aligned.unread())
        blind[row, :len(r_keys)] = torch.tensor(aligned.blind())
    return Pair(sender_ids, sender_mask, receiver_ids, receiver_mask, positions, allowed,
                unread, blind, torch.tensor(dropped))
