"""Prompts for the cross-model harness. Standard library only.

Every model reads the same words in its own chat template. The passage sits inside the
user turn, and the rendered prompt is split right after the passage: the part before the
split is what a sender can prefill and hand over as a cache, the part after it (the
question and the template's closing tokens) is what the receiver always reads itself.
"""

# Stands in for the passage while the template renders, so the split point is found even
# for an empty passage or one that repeats words of the instructions. Plain ASCII without
# template syntax, leading or trailing space (some templates trim message content).
SENTINEL = "L2PASSAGE7F3A9C"

INSTRUCTION = "Read this passage.\n\n"
ANSWER_RULE = "Answer with a few words from the passage."
ABSTAIN_REPLY = "not in passage"
ABSTAIN_RULE = f"If the passage does not contain the answer, reply exactly: {ABSTAIN_REPLY}"
SYSTEM_TEXT = "You answer questions about a passage. Reply with only the answer, never a full sentence."
SYSTEM_MARK = "L2SYSTEMMARK"


def user_content(passage, question, abstain=False):
    """The user turn: instruction, passage, question, answer rule."""
    rule = f"{ANSWER_RULE} {ABSTAIN_RULE}" if abstain else ANSWER_RULE
    return f"{INSTRUCTION}{passage}\n\nQuestion: {question.strip()}\n{rule}"


def closed_content(question):
    """The floor: the receiver with no passage at all."""
    return f"Question: {question.strip()}\nAnswer with a few words."


def supports_system(render):
    """Whether a chat template carries a system message.

    `render(messages)` returns the rendered prompt or raises. A template that raises
    (Mistral, Gemma) and one that renders but leaves the system text out both count as
    having no system role, because either way the instruction would not reach the model.
    """
    try:
        text = render([{"role": "system", "content": SYSTEM_MARK}, {"role": "user", "content": "hi"}])
    except Exception:  # noqa: BLE001 - a template raises its own error types
        return False
    return SYSTEM_MARK in text


def chat_messages(user, system=None, system_ok=True):
    """Messages for one turn. With no system role, the system text opens the user turn."""
    if not system:
        return [{"role": "user", "content": user}]
    if system_ok:
        return [{"role": "system", "content": system}, {"role": "user", "content": user}]
    return [{"role": "user", "content": f"{system}\n\n{user}"}]


def split_rendered(rendered, passage):
    """(prefix, suffix) of a prompt rendered with SENTINEL in the passage's place.

    prefix ends with the passage; suffix starts right after it. Raises when the template
    lost or repeated the sentinel, since the split would then be a guess.
    """
    if rendered.count(SENTINEL) != 1:
        raise ValueError("The chat template did not render the passage exactly once.")
    head, tail = rendered.split(SENTINEL)
    return head + passage, tail


def prefix_token_count(offsets, boundary):
    """How many leading tokens lie wholly inside the first `boundary` characters.

    offsets are (start, end) character spans of the full prompt's tokens, in order. A token
    that straddles the boundary (a tokenizer may merge the passage's last character with
    the newline after it) belongs to the suffix, so the handed-over cache never contains
    question text.
    """
    count = 0
    for _, end in offsets:
        if end > boundary:
            break
        count += 1
    return count


def fit_tokens(passage_tokens, other_tokens, limit, reserve):
    """How many passage tokens fit a context of `limit` tokens.

    other_tokens is everything in the prompt that is not passage (template, instruction,
    question) and reserve is the answer budget. Returns (kept, truncated). The head of the
    passage is kept: a served model with a hard context has to drop something, and the
    harness records that it did instead of sending an over-long prompt.
    """
    room = max(0, limit - other_tokens - reserve)
    if passage_tokens <= room:
        return passage_tokens, False
    return room, True


def cut_passage(passage, offsets, kept):
    """The passage cut to its first `kept` tokens (offsets are spans within the passage)."""
    if kept >= len(offsets):
        return passage
    if kept <= 0:
        return ""
    return passage[:offsets[kept - 1][1]]
