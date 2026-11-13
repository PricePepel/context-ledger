"""The turn texts of the latent team, taken from the model's own chat template.

The team (team.py) writes one conversation in which several agents speak in turn:

    FIRST(planner prompt) <latent steps> CLOSE LATER(critic prompt) <latent steps> CLOSE ... LATER(solver prompt)

FIRST is the template's own rendering of one user message with a generation prompt, so it
keeps whatever the template puts before the first turn (a bos token, a default system
block). A LATER turn must not repeat that: if it carries a system block, the working memory
reads as a system prompt inside an assistant reply and the solver copies it (the bug fixed
for ChatML in a8808ad; Llama 3.x and Granite 3.x inject a default system block too).

Instead of hard-coding each family, CLOSE and LATER come from string differences of three
small renders of `tokenizer.apply_chat_template`, with sentinel contents U1, A1 and U2:

    first = [user U1] + generation prompt              = HEAD U1 SUFFIX
    ended = [user U1, assistant A1]                    = ... A1 CLOSE [end of conversation]
    later = [user U1, assistant A1, user U2] + prompt  = ... A1 CLOSE PREFIX U2 SUFFIX

CLOSE is the longest common prefix of what follows A1 in `ended` and in `later`, cut back so
it never ends inside a special token (Phi-3.5 ends a conversation with <|endoftext|> and
opens a user turn with <|user|>: the common prefix "<|end|>\\n<|" is cut to "<|end|>\\n").
PREFIX U2 SUFFIX is the rest, and SUFFIX must equal the first turn's SUFFIX, so every
agent's assistant turn opens the same way.

ChatML templates (Qwen, SmolLM) keep the hard-coded strings the measured results used; for
them the derivation gives the same strings byte for byte (tests/test_chat_templates.py).

This module needs neither torch nor transformers, so the template tests run anywhere.
"""
from dataclasses import dataclass

# Contents no template rewrites: letters only, nothing to trim or escape.
USER_1, ASSISTANT_1, USER_2 = "qzxUSERONEqzx", "qzxASSISTANTONEqzx", "qzxUSERTWOqzx"


class ChatTemplateError(ValueError):
    """The latent team cannot build its turns from this model's chat template."""

    def __init__(self, model_name, reason):
        super().__init__(f"{model_name}: the latent team cannot use this chat template: {reason}")
        self.model_name = model_name
        self.reason = reason


@dataclass(frozen=True)
class ChatTurns:
    close: str           # ends an agent's (latent) assistant turn
    later_prefix: str    # opens a later agent's user turn, without a system block
    later_suffix: str    # closes that user turn and opens the assistant turn
    chatml: bool = False

    def later(self, prompt):
        return self.later_prefix + prompt + self.later_suffix

    def as_dict(self):
        return {"close": self.close, "laterPrefix": self.later_prefix, "laterSuffix": self.later_suffix,
                "chatml": self.chatml}


# The strings every ChatML result so far was measured with.
CHATML = ChatTurns(close="<|im_end|>\n", later_prefix="<|im_start|>user\n",
                   later_suffix="<|im_end|>\n<|im_start|>assistant\n", chatml=True)


def template_text(tokenizer):
    template = getattr(tokenizer, "chat_template", None)
    if isinstance(template, dict):  # named templates: the default one is used for chat
        template = template.get("default")
    return template if isinstance(template, str) else ""


def is_chatml(tokenizer):
    return "<|im_start|>" in template_text(tokenizer)


def first_turn(tokenizer, prompt):
    """The first agent's turn: the template's own rendering, system block included."""
    return tokenizer.apply_chat_template([{"role": "user", "content": prompt}], tokenize=False,
                                         add_generation_prompt=True)


def special_tokens(tokenizer):
    """Special and added token strings, longest first."""
    names = set()
    for attr in ("all_special_tokens", "additional_special_tokens"):
        names.update(t for t in (getattr(tokenizer, attr, None) or []) if isinstance(t, str))
    for attr in ("bos_token", "eos_token", "pad_token", "unk_token"):
        value = getattr(tokenizer, attr, None)
        if isinstance(value, str):
            names.add(value)
    added = getattr(tokenizer, "get_added_vocab", None)
    if callable(added):
        names.update(t for t in added() if isinstance(t, str))
    return sorted((t for t in names if t), key=len, reverse=True)


def _outside_tokens(text, end, tokens):
    """Move `end` back until it does not fall strictly inside a token occurring in text."""
    moved = True
    while moved:
        moved = False
        for token in tokens:
            start = text.find(token)
            while start != -1 and start < end:
                if start < end < start + len(token):
                    end, moved = start, True
                start = text.find(token, start + 1)
    return end


def _common_prefix(a, b):
    n = 0
    while n < min(len(a), len(b)) and a[n] == b[n]:
        n += 1
    return n


def _ids(tokenizer, text):
    row = tokenizer([text], add_special_tokens=False)["input_ids"][0]
    return row.tolist() if hasattr(row, "tolist") else list(row)


def derive_turns(tokenizer, model_name):
    """CLOSE, PREFIX and SUFFIX from the template itself. Raises ChatTemplateError."""
    def render(messages, prompt, what):
        try:
            text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=prompt)
        except Exception as exc:  # no template, or the template raised (raise_exception, bad roles)
            raise ChatTemplateError(model_name, f"rendering {what} failed ({type(exc).__name__}: {exc})") from exc
        if not isinstance(text, str):
            raise ChatTemplateError(model_name, f"rendering {what} did not return text")
        return text

    def at(text, marker, what):
        if text.count(marker) != 1:
            raise ChatTemplateError(model_name, f"the message content does not appear exactly once in {what}; "
                                                "the template rewrites or drops it")
        return text.index(marker)

    user_1 = {"role": "user", "content": USER_1}
    assistant_1 = {"role": "assistant", "content": ASSISTANT_1}
    first = render([user_1], True, "a user turn")
    ended = render([user_1, assistant_1], False, "a conversation that ends with an assistant turn")
    later = render([user_1, assistant_1, {"role": "user", "content": USER_2}], True, "a second user turn")

    first_suffix = first[at(first, USER_1, "the first turn") + len(USER_1):]
    after_ended = ended[at(ended, ASSISTANT_1, "the ended conversation") + len(ASSISTANT_1):]
    after_later = later[at(later, ASSISTANT_1, "the two-turn conversation") + len(ASSISTANT_1):]
    if USER_2 not in after_later:
        raise ChatTemplateError(model_name, "the second user turn does not follow the assistant turn")
    cut = _common_prefix(after_ended, after_later)
    cut = _outside_tokens(after_later, cut, special_tokens(tokenizer))
    close = after_later[:cut]
    if not close:
        raise ChatTemplateError(model_name, "no text closes an assistant turn before the next user turn")
    rest = after_later[cut:]
    if rest.count(USER_2) != 1:
        raise ChatTemplateError(model_name, "the second user turn's content does not appear exactly once")
    prefix, suffix = rest.split(USER_2)
    if suffix != first_suffix:
        raise ChatTemplateError(model_name, f"a later turn opens the assistant differently ({suffix!r}) from the "
                                            f"first turn ({first_suffix!r})")
    turns = ChatTurns(close=close, later_prefix=prefix, later_suffix=suffix)
    if callable(tokenizer):
        # The team tokenizes CLOSE and each later turn separately: that must give the
        # tokens of the template's own text, or the split cut through a token.
        try:
            whole = _ids(tokenizer, close + turns.later(USER_2))
            parts = _ids(tokenizer, close) + _ids(tokenizer, turns.later(USER_2))
        except Exception as exc:
            raise ChatTemplateError(model_name, f"tokenizing the turns failed ({type(exc).__name__}: {exc})") from exc
        if whole != parts:
            raise ChatTemplateError(model_name, f"the close text {close!r} does not end on a token boundary")
    return turns


def chat_turns(tokenizer, model_name):
    """The turns the team uses: the measured ChatML strings, or ones derived from the template."""
    if is_chatml(tokenizer):
        return CHATML
    return derive_turns(tokenizer, model_name)


def close_token(tokenizer, close):
    """The special token the close text starts with (<|im_end|>, <|eot_id|>, </s>, ...), if any."""
    for token in special_tokens(tokenizer):
        if close.startswith(token):
            return token
    return None


def stop_ids(tokenizer, generation_config, close):
    """Decoding stops at the tokenizer's eos, the generation config's eos ids and the close token."""
    ids = set()

    def add(value):
        if isinstance(value, (list, tuple, set)):
            for item in value:
                add(item)
        elif isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            ids.add(value)

    add(getattr(tokenizer, "eos_token_id", None))
    add(getattr(generation_config, "eos_token_id", None))
    token = close_token(tokenizer, close)
    if token is not None:
        token_id = tokenizer.convert_tokens_to_ids(token)
        if token_id != getattr(tokenizer, "unk_token_id", None):  # an unknown token maps to unk
            add(token_id)
    return ids
