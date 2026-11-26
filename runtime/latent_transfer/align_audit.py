"""L3 audit: how two tokenizers line up on hard text (CPU only, tokenizers only).

    python -m latent_transfer.align_audit --out audit.json
    python -m latent_transfer.align_audit --natural 200 --pairs phi:qwen,llama:qwen

For every ordered pair it reports the vocabulary overlap, how the sender's positions
sit on the receiver's tokens, and what alignment rule 1 (raw offsets) and rule 2
(refined spans) each drop or leave unread. Per tokenizer it reports tokens whose
reported span is not the characters the token stands for.

The edge-case texts are synthetic. The natural column reads SQuAD validation passages
from the local Hugging Face cache; the pipeline column is the same passages behind the
ChatML header that M2b documents start with. Only counts leave this program.
"""
import argparse
import json
import math
import re

from .align import (KINDS, RULE_RAW, RULE_REFINED, align_document, blind_receiver, causal_mask, classify,
                    refine_spans, sender_positions, unread_sender)

TOKENIZERS = {
    "phi": "microsoft/Phi-3.5-mini-instruct",
    "qwen": "Qwen/Qwen2.5-1.5B-Instruct",
    "llama": "RedHatAI/Meta-Llama-3.1-8B-Instruct-quantized.w4a16",
    "mistral": "RedHatAI/Mistral-7B-Instruct-v0.3-quantized.w4a16",
    "granite": "RedHatAI/granite-3.1-8b-instruct-quantized.w4a16",
}


def c(*points):
    return "".join(chr(point) for point in points)


GRIN, MAN, WOMAN, GIRL, ZWJ = 0x1F600, 0x1F468, 0x1F469, 0x1F467, 0x200D
ACUTE, DIAERESIS = 0x301, 0x308
CJK = c(0x4F60, 0x597D, 0xFF0C, 0x4E16, 0x754C, 0x3002, 0x6771, 0x4EAC, 0x90FD)
ARABIC = c(0x645, 0x631, 0x62D, 0x628, 0x627, 0x20, 0x628, 0x627, 0x644, 0x639, 0x627, 0x644, 0x645)
EDGE_CASES = [
    ("plain", "The quick brown fox jumps over the lazy dog."),
    ("leading-space", " Hello world"),
    ("leading-spaces", "    indented four spaces"),
    ("repeated-spaces", "a  b   c    d     e"),
    ("trailing-spaces", "ends with spaces   "),
    ("only-space", " "),
    ("only-newlines", "\n\n\n"),
    ("crlf", "line one\r\nline two\r\n\r\nline four"),
    ("tabs", "col1\tcol2\t\tcol4\n\tindented"),
    ("mixed-whitespace", " \t \r\n  x \n"),
    ("emoji", "hi " + c(GRIN) + " ok " + c(GRIN, GRIN)),
    ("emoji-first", c(GRIN) + " starts the text"),
    ("emoji-joined", "family: " + c(MAN, ZWJ, WOMAN, ZWJ, GIRL) + " done"),
    ("astral", "math " + c(0x1D54F, 0x1D7D9) + " gothic " + c(0x10330) + " han " + c(0x20BB7)),
    ("combining", "cafe" + c(ACUTE) + " nai" + c(DIAERESIS) + "ve re" + c(ACUTE) + "sume" + c(ACUTE)),
    ("combining-last", "ends in e" + c(ACUTE)),
    ("precomposed", "caf" + c(0xE9) + " na" + c(0xEF) + "ve"),
    ("cjk", CJK),
    ("cjk-mixed", "Tokyo " + c(0x6771, 0x4EAC) + " is big, " + c(0x5927, 0x304D, 0x3044) + "."),
    ("arabic", ARABIC),
    ("arabic-mixed", "The word " + ARABIC + " means hello."),
    ("long-word", "pneumonoultramicroscopicsilicovolcanoconiosis and supercalifragilisticexpialidocious"),
    ("long-run", "a" * 120),
    ("long-hex", "0x" + "deadbeef" * 12),
    ("numbers", "3.14159 1,000,000 -42 1e-9 2026-11-26 12:34:56 +1 (555) 010-9999"),
    ("code", "def f(x):\n    return {'a': x**2, \"b\": [i for i in range(10)]}  # ok\n"),
    ("code-symbols", "if (a != b && c <= d) { x >>= 2; } // done -> end"),
    ("url", "https://example.com/a/b?c=1&d=%20e#frag user@example.org"),
    ("chatml", "<|im_start|>user\nRead this passage.\n\nShort passage.<|im_end|>\n<|im_start|>assistant\n"),
    ("special-strings", "x<|endoftext|>y</s>z<s>w[INST]v[/INST]<|eot_id|><|end_of_text|>"),
    ("near-special", "<|im_start <im_start|> < |im_end| >"),
    ("one-to-many", "antidisestablishmentarianism\r\n\r\n....... ______ !!!!!!"),
    ("many-to-one", "Mr. O'Neil-Smith's co-op re-entry, i.e. e.g. U.S.A."),
    ("zero-width", "zero" + c(0x200B) + "width" + c(0xFEFF) + "marks" + c(0x200D)),
    ("nbsp", "non" + c(0xA0) + "breaking" + c(0x2003) + "spaces"),
]


def gpt2_bytes():
    """The byte <-> printable character table of byte-level BPE vocabularies."""
    keep = list(range(ord("!"), ord("~") + 1)) + list(range(0xA1, 0xAD)) + list(range(0xAE, 0x100))
    table, extra = {}, 0
    for byte in range(256):
        if byte in keep:
            table[chr(byte)] = byte
        else:
            table[chr(256 + extra)] = byte
            extra += 1
    return table


BYTE_OF = gpt2_bytes()
SP_BYTE = re.compile(r"^<0x([0-9A-Fa-f]{2})>$")


def surface(token, byte_level):
    """The bytes a vocabulary entry stands for, so vocabularies of different families compare."""
    if byte_level:
        if all(char in BYTE_OF for char in token):
            return bytes(BYTE_OF[char] for char in token)
        return token.encode("utf-8")
    match = SP_BYTE.match(token)
    if match:
        return bytes([int(match.group(1), 16)])
    return token.replace(c(0x2581), " ").encode("utf-8")


class Audited:
    def __init__(self, name, model):
        from transformers import AutoTokenizer
        self.name, self.model = name, model
        self.tok = AutoTokenizer.from_pretrained(model)
        vocab = self.tok.get_vocab()
        self.byte_level = sum(1 for token in vocab if token.startswith(c(0x120))) > \
            sum(1 for token in vocab if token.startswith(c(0x2581)))
        self.special = set(self.tok.get_added_vocab()) | set(self.tok.all_special_tokens)
        self.surfaces = {surface(token, self.byte_level) for token in vocab if token not in self.special}
        self.cache = {}

    def encode(self, text):
        """(token strings, raw spans) of the whole text, without BOS or EOS."""
        if text not in self.cache:
            encoded = self.tok(text, add_special_tokens=False, return_offsets_mapping=True, verbose=False)
            self.cache[text] = (self.tok.convert_ids_to_tokens(encoded["input_ids"]),
                                [tuple(span) for span in encoded["offset_mapping"]])
        return self.cache[text]

    def bos_eos(self):
        ids = self.tok("Hi")["input_ids"]
        bare = self.tok("Hi", add_special_tokens=False)["input_ids"]
        return {"addsBos": ids[:1] != bare[:1], "addsEos": ids[-1:] != bare[-1:],
                "bos": self.tok.bos_token, "eos": self.tok.eos_token}

    def span_check(self, text):
        """Counts of tokens by how their reported span relates to what they stand for."""
        tokens, spans = self.encode(text)
        counts = {"tokens": len(tokens), "exact": 0, "piece": 0, "wrong": 0, "zeroWidth": 0, "examples": []}
        covered = set()
        for token, (start, end) in zip(tokens, spans):
            covered.update(range(start, end))
            if end == start:
                counts["zeroWidth"] += 1
                continue
            got = text[start:end].encode("utf-8")
            want = token.encode("utf-8") if token in self.special else surface(token, self.byte_level)
            if want == got or (not self.byte_level and want[:1] == b" " and want[1:] == got):
                counts["exact"] += 1          # the second form is SentencePiece's word marker
            elif want and want in got:
                counts["piece"] += 1          # part of a character, or a span rounded out to one
            else:
                counts["wrong"] += 1
                if len(counts["examples"]) < 3:
                    counts["examples"].append([ascii(token), ascii(text[start:end])])
        counts["uncoveredChars"] = len(text) - len(covered)
        return counts


def identity_ok(spans, rule):
    """With the same tokenizer on both sides: position i for token i, and no token reads a later one."""
    size = len(spans)
    mask = causal_mask(spans, spans, rule)
    return sender_positions(spans, spans, rule) == [float(i) for i in range(size)] and         not any(mask[j][i] for j in range(size) for i in range(j + 1, size))


def covered(spans):
    """The characters under the tokens (a character shared with a neighbour counts)."""
    return {char for start, end in spans for char in range(math.floor(start), math.ceil(end))}


def pair_stats(sender, receiver, texts, max_tokens=None):
    """Counts over the texts for one ordered pair. Without max_tokens nothing is truncated.

    sameBoundaries and the five kinds are measured on refined spans (rule 2). Per rule:
    dropped = tokens within the budget that the cut removed; unreadSender = kept sender
    tokens no kept receiver token may read; blindReceiver = kept receiver tokens that read
    no sender token; lostCoverageChars = characters under one side's kept tokens and not
    under the other's; emptyTexts = texts where a side kept nothing (make_pair refuses them).
    """
    def rule_stats():
        return {"dropped": 0, "unreadSender": 0, "blindReceiver": 0, "lostCoverageChars": 0, "emptyTexts": 0}
    out = {"texts": 0, "noTokens": 0, "sameBoundaries": 0, "senderTokens": 0, **{kind: 0 for kind in KINDS},
           "rule1": rule_stats(), "rule2": rule_stats(), "changedTexts": 0, "changedSenderTokens": 0}
    for text in texts:
        (_, s_raw), (_, r_raw) = sender.encode(text), receiver.encode(text)
        if not s_raw or not r_raw:
            out["noTokens"] += 1
            continue
        out["texts"] += 1
        s_ref, r_ref = refine_spans(s_raw, len(text)), refine_spans(r_raw, len(text))
        if max_tokens is None:
            out["sameBoundaries"] += s_ref == r_ref
            out["senderTokens"] += len(s_ref)
            for kind in classify(s_ref, r_ref):
                out[kind] += 1
        results = {}
        for rule, key in ((RULE_RAW, "rule1"), (RULE_REFINED, "rule2")):
            s_in = s_raw[:max_tokens] if rule == RULE_RAW else s_raw
            r_in = r_raw[:max_tokens] if rule == RULE_RAW else r_raw
            keep_s, s_spans, keep_r, r_spans = align_document(s_in, r_in, len(text), max_tokens, rule)
            limit_s, limit_r = (min(len(s_raw), max_tokens or len(s_raw)), min(len(r_raw), max_tokens or len(r_raw)))
            stats = out[key]
            stats["dropped"] += limit_s - len(keep_s) + limit_r - len(keep_r)
            stats["unreadSender"] += sum(unread_sender(s_spans, r_spans, rule))
            stats["blindReceiver"] += sum(blind_receiver(s_spans, r_spans, rule))
            stats["lostCoverageChars"] += len(covered(s_spans) ^ covered(r_spans))
            if not keep_s or not keep_r:
                stats["emptyTexts"] += 1
                continue
            results[rule] = (keep_s, keep_r, sender_positions(s_spans, r_spans, rule),
                             causal_mask(s_spans, r_spans, rule))
        if len(results) == 2:
            a, b = results[RULE_RAW], results[RULE_REFINED]
            if a[:2] != b[:2]:
                out["changedTexts"] += 1
                out["changedSenderTokens"] += max(len(a[0]), len(b[0]))
            else:
                moved = sum(1 for i in range(len(a[0]))
                            if a[2][i] != b[2][i] or any(a[3][j][i] != b[3][j][i] for j in range(len(a[1]))))
                out["changedTexts"] += moved > 0
                out["changedSenderTokens"] += moved
        elif results:
            out["changedTexts"] += 1
    return out


def jaccard(a, b):
    return len(a.surfaces & b.surfaces) / len(a.surfaces | b.surfaces)


def containment(a, b):
    """Share of the smaller vocabulary that the larger one also has. Jaccard cannot exceed
    the ratio of the two sizes, so a 32k and a 150k vocabulary score low even when one
    holds most of the other."""
    return len(a.surfaces & b.surfaces) / min(len(a.surfaces), len(b.surfaces))


def natural_texts(count, seed=0):
    from .data import sample, squad
    return [row["context"].strip() for row in sample(squad("validation"), count, seed)]


def share(part, whole):
    return round(part / whole, 4) if whole else None


def run(names, pairs, natural, truncate):
    audited = {name: Audited(name, TOKENIZERS.get(name, name)) for name in names}
    from .data import doc_text
    edge = [text for _, text in EDGE_CASES]
    pipeline = [doc_text(text) for text in natural]
    report = {"edgeCases": [name for name, _ in EDGE_CASES], "naturalTexts": len(natural), "tokenizers": {}, "pairs": []}
    for name, item in audited.items():
        entry = {"model": item.model, "vocabulary": len(item.surfaces), "byteLevel": item.byte_level, **item.bos_eos()}
        for label, texts in (("edge", edge), ("natural", natural)):
            total = {"tokens": 0, "exact": 0, "piece": 0, "wrong": 0, "zeroWidth": 0, "uncoveredChars": 0,
                     "identityFailsRule1": 0, "identityFailsRule2": 0, "examples": []}
            for text in texts:
                check = item.span_check(text)
                for key in ("tokens", "exact", "piece", "wrong", "zeroWidth", "uncoveredChars"):
                    total[key] += check[key]
                total["examples"] = (total["examples"] + check["examples"])[:6]
                raw = item.encode(text)[1]
                total["identityFailsRule1"] += not identity_ok(raw, RULE_RAW)
                total["identityFailsRule2"] += not identity_ok(refine_spans(raw, len(text)), RULE_REFINED)
            entry[label] = total
        entry["emptyText"] = len(item.encode("")[1])
        report["tokenizers"][name] = entry
    for sender, receiver in pairs:
        a, b = audited[sender], audited[receiver]
        entry = {"sender": sender, "receiver": receiver, "vocabularyJaccard": round(jaccard(a, b), 4),
                 "vocabularyContainment": round(containment(a, b), 4),
                 "edge": pair_stats(a, b, edge), "natural": pair_stats(a, b, natural),
                 # The texts the M2b pipeline aligns: the passage behind its ChatML header.
                 "pipeline": pair_stats(a, b, pipeline),
                 "pipelineTruncated": pair_stats(a, b, pipeline, truncate), "truncateAt": truncate}
        report["pairs"].append(entry)
    return report


def table(report):
    lines = ["| Sender to receiver | Vocabulary Jaccard | Smaller vocabulary found in the larger | Same boundaries "
             "(edge / natural texts) | One-to-one (edge / natural) | One-to-many | Many-to-one | Crossing | Unaligned |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for entry in report["pairs"]:
        edge, natural = entry["edge"], entry["natural"]

        def both(key, whole):
            return f"{share(edge[key], edge[whole])} / {share(natural[key], natural[whole])}"
        lines.append(f"| {entry['sender']} to {entry['receiver']} | {entry['vocabularyJaccard']} | "
                     f"{entry['vocabularyContainment']} | "
                     f"{both('sameBoundaries', 'texts')} | {both('one_to_one', 'senderTokens')} | "
                     f"{both('one_to_many', 'senderTokens')} | {both('many_to_one', 'senderTokens')} | "
                     f"{both('crossing', 'senderTokens')} | {both('unaligned', 'senderTokens')} |")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tokenizers", default=",".join(TOKENIZERS), help="names from TOKENIZERS or Hugging Face ids")
    parser.add_argument("--pairs", help="sender:receiver,... (default: every ordered pair)")
    parser.add_argument("--natural", type=int, default=200, help="SQuAD validation passages; 0 to skip")
    parser.add_argument("--truncate", type=int, default=64, help="token budget for the truncation column")
    parser.add_argument("--out")
    args = parser.parse_args()
    names = [name for name in args.tokenizers.split(",") if name]
    if args.pairs:
        pairs = [tuple(pair.split(":")) for pair in args.pairs.split(",")]
    else:
        pairs = [(a, b) for a in names for b in names if a != b]
    report = run(names, pairs, natural_texts(args.natural) if args.natural else [], args.truncate)
    if args.out:
        with open(args.out, "w") as handle:
            json.dump(report, handle, indent=1)
    print(table(report))


if __name__ == "__main__":
    main()
