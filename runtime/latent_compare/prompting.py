"""Prompts as token ids, for any backend. Needs a tokenizer object, not torch.

Both engines (torch and vLLM) build their prompts here, so a model answers the same token
ids whichever engine runs it.
"""
import time

from latent_transfer.data import summary_request

from .prompts import (SENTINEL, chat_messages, closed_content, cut_passage, fit_tokens, prefix_token_count,
                      split_rendered, supports_system, user_content)

ANSWER_TOKENS = 24
SUMMARY_TOKENS = 96
# Slack for tokens that merge or split differently once the passage replaces the sentinel.
JOIN_SLACK = 8


class Prompter:
    """Subclasses set self.tok (a fast tokenizer with a chat template) and call setup_prompts()."""

    def setup_prompts(self):
        self.system_ok = supports_system(lambda messages: self.tok.apply_chat_template(messages, tokenize=False))

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
        ids = list(encoded["input_ids"])
        if limit is not None and len(ids) + ANSWER_TOKENS > limit:
            raise ValueError(f"Prompt of {len(ids)} tokens does not fit the context of {limit}.")
        return {"ids": ids, "prefixTokens": prefix_token_count(encoded["offset_mapping"], len(prefix)),
                "promptTokens": len(ids), "passageTokens": total, "keptTokens": kept, "truncated": truncated,
                "passageBytes": len(passage.encode("utf-8")), "prepareMs": (time.perf_counter() - start) * 1000}

    def closed_ids(self, question):
        return list(self.tok(self.render(chat_messages(closed_content(question))), add_special_tokens=False)["input_ids"])

    def summary_ids(self, passage, limit=None):
        rendered = self.render(chat_messages(summary_request(SENTINEL)))
        passage, total, kept, truncated = self.fit(passage.strip(), self.count(rendered), limit, SUMMARY_TOKENS)
        ids = list(self.tok(rendered.replace(SENTINEL, passage), add_special_tokens=False)["input_ids"])
        if limit is not None and len(ids) + SUMMARY_TOKENS > limit:
            raise ValueError(f"Summary prompt of {len(ids)} tokens does not fit the context of {limit}.")
        return ids, {"passageTokens": total, "keptTokens": kept, "truncated": truncated}

    def summarize(self, passage, limit=None, max_new_tokens=SUMMARY_TOKENS):
        """The sender's summary of a passage, timed from the raw text to the last token."""
        start = time.perf_counter()
        ids, info = self.summary_ids(passage, limit)
        result = self.timed(ids, max_new_tokens)
        return {"summary": result["answer"], "ms": (time.perf_counter() - start) * 1000,
                "newTokens": result["newTokens"], "bytes": len(result["answer"].encode("utf-8")), **info}
