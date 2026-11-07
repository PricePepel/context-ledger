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


def doc_text(passage):
    return DOC_PREFIX + passage.strip()


def question_suffix(question):
    return (f"\n\nQuestion: {question.strip()}\nAnswer with a few words from the passage.{END}\n"
            "<|im_start|>assistant\n")


def closed_prompt(question):
    """The receiver with no passage at all: what it knows already."""
    return f"<|im_start|>user\nQuestion: {question.strip()}\nAnswer with a few words.{END}\n<|im_start|>assistant\n"


def summary_prompt(passage, words=40):
    """The T2T baseline's request; pair.sender_generate allows 96 tokens, enough for 40 words."""
    return (f"<|im_start|>user\nSummarize this passage in at most {words} words. Keep every name, number "
            f"and date.\n\n{passage.strip()}{END}\n<|im_start|>assistant\n")


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
