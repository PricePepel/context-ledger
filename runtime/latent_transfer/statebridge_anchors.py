"""Vocabulary anchors shared by two tokenizers (card L4; standard library only).

An anchor is a vocabulary entry that both tokenizers have: the same text and the same
word-start marker. SentencePiece marks a word start with U+2581 and byte-level BPE with
U+0120; both become one leading space in the anchor's key, so " the" in a Llama-style
vocabulary matches " the" in a GPT-2-style one, and "the" (a word continuation) matches
only "the".
"""

WORD_START = (chr(0x2581), chr(0x0120))
REPLACEMENT = chr(0xFFFD)


def anchor_key(raw_token, decoded):
    """The key of one vocabulary entry, or None when it cannot be an anchor.

    raw_token is the vocabulary string (tokenizer.convert_ids_to_tokens), decoded is
    tokenizer.decode([id]). A byte-level token that is only part of a character decodes
    to U+FFFD and is dropped: it has no text of its own to share.
    """
    if not raw_token or decoded is None or REPLACEMENT in decoded:
        return None
    word_start = raw_token[0] in WORD_START
    body = decoded
    if word_start and body.startswith(" "):
        body = body[1:]  # byte-level decoders keep the marker's space, SentencePiece drops it
    if not word_start and not body:
        return None
    return (" " if word_start else "") + body


def vocab_keys(tokenizer):
    """{key: token id} for every entry of a tokenizer that can be an anchor.

    Special tokens are skipped. When several ids share a key the lowest id wins.
    """
    special = set(getattr(tokenizer, "all_special_ids", ()) or ())
    keys = {}
    for token_id in range(len(tokenizer)):
        if token_id in special:
            continue
        raw = tokenizer.convert_ids_to_tokens(token_id)
        if not isinstance(raw, str):
            continue
        key = anchor_key(raw, tokenizer.decode([token_id]))
        if key is not None and key not in keys:
            keys[key] = token_id
    return keys


def shared_anchors(sender_keys, receiver_keys):
    """[(sender id, receiver id, key)] for keys both vocabularies have, by sender id."""
    pairs = [(sender_id, receiver_keys[key], key) for key, sender_id in sender_keys.items()
             if key in receiver_keys]
    return sorted(pairs)


def split_holdout(anchors, every=10):
    """(fit, held out): every `every`-th anchor is kept out of the fit for the retrieval check."""
    if every < 2:
        raise ValueError("every must be at least 2")
    fit = [anchor for index, anchor in enumerate(anchors) if index % every != every - 1]
    held = [anchor for index, anchor in enumerate(anchors) if index % every == every - 1]
    return fit, held


def overlap(anchors, sender_size, receiver_size):
    """How much of each vocabulary the anchors cover."""
    count = len(anchors)
    return {"anchors": count,
            "senderShare": round(count / sender_size, 4) if sender_size else 0.0,
            "receiverShare": round(count / receiver_size, 4) if receiver_size else 0.0}


def covered_share(token_ids, anchor_ids):
    """Share of a token sequence whose tokens are anchors (1.0 for an empty sequence)."""
    token_ids = list(token_ids)
    if not token_ids:
        return 1.0
    return sum(1 for token_id in token_ids if token_id in anchor_ids) / len(token_ids)
