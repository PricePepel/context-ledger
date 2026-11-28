"""Data, prompts and scoring for M2b training and evals.

The document text `d` is what the sender reads and the cache stands for. It starts
with the chat header so the template tokens are part of the transferred cache, and
the receiver's question suffix continues the same user turn.
"""
import collections
import glob
import os
import random
import re
import string


HUB = os.path.expanduser(os.environ.get("HF_HUB_CACHE", "~/.cache/huggingface/hub"))
DOC_PREFIX = "<|im_start|>user\nRead this passage.\n\n"
END = "<|im_end|>"


def single_token(tokenizer, text):
    """The id of `text` when the tokenizer writes it as one token of its own, else None.

    A tokenizer that turns any unknown string into its one unknown token would pass a
    length check with a marker it does not have, so that id only counts when the text is
    the unknown token itself (GPT-2 style tokenizers use one token as end and unknown).
    """
    if not text:
        return None
    ids = tokenizer(text, add_special_tokens=False)["input_ids"]
    if len(ids) != 1 or not isinstance(ids[0], int):
        return None
    unknown = getattr(tokenizer, "unk_token_id", None)
    if unknown is not None and ids[0] == unknown and text != getattr(tokenizer, "unk_token", None):
        return None
    return ids[0]


def end_marker(tokenizer):
    """The text that ends a receiver's answer in stage 2, and the token decoding stops at.

    ChatML's `<|im_end|>` when the receiver's tokenizer has it as one token (Qwen, SmolLM2).
    Any other receiver would spell it out piece by piece, learn to write those pieces and
    never stop, so it gets its own end-of-sequence token instead.
    """
    if single_token(tokenizer, END) is not None:
        return END
    own = getattr(tokenizer, "eos_token", None)
    if single_token(tokenizer, own) is not None:
        return own
    raise ValueError("The receiver's tokenizer has neither <|im_end|> nor an end-of-sequence token of its own.")


def end_ids(tokenizer):
    """The token ids greedy decoding stops at: the end marker and the tokenizer's own
    end-of-sequence id when it has one. Never None and never the unknown token by accident."""
    ids = {single_token(tokenizer, end_marker(tokenizer))}
    own = getattr(tokenizer, "eos_token_id", None)
    if isinstance(own, int):
        ids.add(own)
    return ids


def doc_text(passage):
    return DOC_PREFIX + passage.strip()


def question_suffix(question):
    return (f"\n\nQuestion: {question.strip()}\nAnswer with a few words from the passage.{END}\n"
            "<|im_start|>assistant\n")


def closed_prompt(question):
    """The receiver with no passage at all: what it knows already."""
    return f"<|im_start|>user\nQuestion: {question.strip()}\nAnswer with a few words.{END}\n<|im_start|>assistant\n"


def summary_request(passage, words=40):
    """The T2T baseline's request text, without any chat template."""
    return f"Summarize this passage in at most {words} words. Keep every name, number and date.\n\n{passage.strip()}"


def summary_prompt(passage, words=40, tokenizer=None):
    """The T2T baseline's request; pair.sender_generate allows 96 tokens, enough for 40 words.

    Without a tokenizer it is the ChatML prompt run 1 used. A sender with another chat
    template (Phi-3.5 in the scale-up) passes its tokenizer, so it reads its own format.
    """
    if tokenizer is not None:
        return tokenizer.apply_chat_template([{"role": "user", "content": summary_request(passage, words)}],
                                             tokenize=False, add_generation_prompt=True)
    return f"<|im_start|>user\n{summary_request(passage, words)}{END}\n<|im_start|>assistant\n"


def _parquet(dataset, pattern):
    files = sorted(glob.glob(os.path.join(HUB, f"datasets--{dataset}", "snapshots", "*", pattern)))
    if not files:
        raise FileNotFoundError(f"{dataset} {pattern} is not in the Hugging Face cache under {HUB}")
    return files


def squad(split):
    """[{id, context, question, answers}] from SQuAD v1.1 (train or validation)."""
    import pyarrow.parquet as pq  # only needed for training and evals
    rows = []
    for path in _parquet("rajpurkar--squad", f"plain_text/{split}-*.parquet"):
        table = pq.read_table(path).to_pylist()
        for row in table:
            rows.append({"id": row["id"], "title": row["title"], "context": row["context"],
                         "question": row["question"], "answers": list(row["answers"]["text"])})
    return rows


def wikitext(split, min_chars=400, max_chars=1600, max_docs=150000):
    """Paragraph documents from WikiText-103 (headings dropped, short lines merged)."""
    import pyarrow.parquet as pq
    docs, current = [], []
    for path in _parquet("Salesforce--wikitext", f"wikitext-103-raw-v1/{split}-*.parquet"):
        for line in pq.read_table(path).column("text").to_pylist():
            line = line.strip()
            if not line or line.startswith("="):
                if sum(len(part) for part in current) >= min_chars:
                    docs.append(" ".join(current)[:max_chars])
                    if len(docs) >= max_docs:
                        return docs
                current = []
                continue
            current.append(line)
    return docs


def sample(rows, count, seed):
    rows = list(rows)
    random.Random(seed).shuffle(rows)
    return rows[:count]


CALIBRATION_DOCS = 16  # documents per calibration draw, and the most one prefill holds


def calibration_chunk(batch1):
    """How many of a draw's 16 documents are prefilled at once: all of them at the recipe's
    stage 1 batch of 4 (as every run so far), fewer when a run was started with smaller
    batches because it had run out of memory. The draws, and so the random stream that
    follows them, are the same either way."""
    return max(1, min(CALIBRATION_DOCS, batch1 * 4))


def close_torn_line(log_path):
    """End a log whose last line was cut off, so the next event starts on a line of its own
    and a reader that skips the broken line does not lose the event after it."""
    try:
        with open(log_path, "rb+") as handle:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                return
            handle.seek(-1, os.SEEK_END)
            if handle.read(1) != b"\n":
                handle.write(b"\n")
    except FileNotFoundError:
        pass


# SQuAD's official answer normalization and token F1.
def normalize(text):
    text = text.lower()
    text = "".join(ch for ch in text if ch not in set(string.punctuation))
    text = re.sub(r"\b(a|an|the)\b", " ", text)
    return " ".join(text.split())


def f1(prediction, answers):
    best = 0.0
    pred = normalize(prediction).split()
    for answer in answers:
        gold = normalize(answer).split()
        common = collections.Counter(pred) & collections.Counter(gold)
        same = sum(common.values())
        if not pred or not gold:
            score = float(pred == gold)
        elif same == 0:
            score = 0.0
        else:
            precision, recall = same / len(pred), same / len(gold)
            score = 2 * precision * recall / (precision + recall)
        best = max(best, score)
    return best


def contains(prediction, answers):
    """1.0 when a normalized gold answer appears inside the normalized prediction.

    Unlike F1, this does not punish a long but correct reply, so it separates "the
    passage reached the receiver" from "the receiver learned SQuAD's short answer style".
    """
    pred = f" {normalize(prediction)} "
    return float(any(f" {normalize(answer)} " in pred for answer in answers if normalize(answer)))
