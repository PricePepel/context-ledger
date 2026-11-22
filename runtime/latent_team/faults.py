"""W1 eval only: the faults of eval 1, injected into one LatentTeam instance.

    mode, undo = inject(team, "cache-swapped")
    ... team.latent_mas(questions, mode=mode, watch=...) ...
    undo()

Each fault changes the runtime the way a bug or other code could, never the watchdog.
NAMED says which exact check the design names for each fault; eval 1 passes when every
faulted question fails that check.
"""
import torch

NAMED = {
    "noise": "legibility", "aligned": "legibility", "adapter": "configuration",
    "missing-close": "turnStructure", "repeated-system": "turnStructure",
    "span-inserted": "spanLedger", "span-lengthened": "spanLedger", "span-removed": "spanLedger",
    "cache-random": "memoryChecksum", "cache-scaled": "memoryChecksum", "cache-values": "memoryChecksum",
    "cache-swapped": "memoryChecksum", "subagent-text": "budgets", "extra-steps": "budgets",
    # Added after the first review: the same kinds of change made inside the runtime's own
    # steps rather than at the hand-off seam.
    "think-swapped": "memoryChecksum", "decode-swapped": "memoryChecksum",
    "forward-hidden": "spanLedger", "positions-shifted": "spanLedger",
}
FAULTS = tuple(NAMED)


def each_layer(memory, change):
    for layer in memory.layers:
        layer.keys, layer.values = change(layer.keys, layer.values)
    return memory


def _between(team, at, change):
    def between(index, memory, mask):
        if index == at:
            memory, mask = change(memory, mask)
        return memory, mask
    team.between = between
    return lambda: team.__dict__.pop("between", None)


def _insert(memory, mask):
    memory = each_layer(memory, lambda k, v: (torch.cat([k, k[:, :, -4:]], 2), torch.cat([v, v[:, :, -4:]], 2)))
    return memory, torch.cat([mask, mask[:, -4:]], 1)


def _lengthen(memory, mask):
    middle = mask.shape[1] // 2

    def grow(t):
        return torch.cat([t[..., :middle, :], t[..., middle - 4:middle, :], t[..., middle:, :]], -2)
    memory = each_layer(memory, lambda k, v: (grow(k), grow(v)))
    return memory, torch.cat([mask[:, :middle], mask[:, middle - 4:middle], mask[:, middle:]], 1)


def _remove(memory, mask):
    return each_layer(memory, lambda k, v: (k[:, :, :-4], v[:, :, :-4])), mask[:, :-4]


def _random(memory, mask):
    return each_layer(memory, lambda k, v: ((torch.randn_like(k.float()) * k.float().std()).to(k.dtype),
                                            (torch.randn_like(v.float()) * v.float().std()).to(v.dtype))), mask


def _scaled(memory, mask):
    return each_layer(memory, lambda k, v: (k * 8, v * 8)), mask


def _values(memory, mask):
    return each_layer(memory, lambda k, v: (k, (torch.randn_like(v.float()) * v.float().std()).to(v.dtype))), mask


def swapped(memory, mask):
    """Another question's memory for every row: the batch's rows rolled by one."""
    return each_layer(memory, lambda k, v: (k.roll(1, 0), v.roll(1, 0))), mask.roll(1, 0)


def _emitting(team, words=3):
    think = team.think

    def emitting(memory, memory_mask, prompts, steps, mode="soft", first=True, hide=None):
        if not first:
            return think(memory, memory_mask, prompts, steps, mode=mode, first=first, hide=hide)
        dtype = team.model.dtype
        ids, mask = team.render(prompts, first=first)
        out, full = team.forward(memory, memory_mask, ids=ids, mask=mask, hidden_only=True, hide=hide)
        memory, hidden = out.past_key_values, out.last_hidden_state[:, -1]
        for _ in range(steps):
            vector = team.thought(hidden, mode)
            out, full = team.forward(memory, full, embeds=vector.to(dtype)[:, None, :], hidden_only=True, hide=hide)
            memory, hidden = out.past_key_values, out.last_hidden_state[:, -1]
        for _ in range(words):   # the planner writes text before closing its turn
            token = team.model.get_output_embeddings()(hidden.to(dtype)).argmax(-1)[:, None]
            out, full = team.forward(memory, full, ids=token, hidden_only=True, hide=hide)
            memory, hidden = out.past_key_values, out.last_hidden_state[:, -1]
        close = team.tokenizer([team.close_turn()] * len(prompts), return_tensors="pt", add_special_tokens=False)
        out, full = team.forward(memory, full, ids=close["input_ids"].to(team.device),
                                 mask=close["attention_mask"].to(team.device), hidden_only=True, hide=hide)
        return out.past_key_values, full

    team.think = emitting
    return lambda: team.__dict__.pop("think", None)


def _extra_steps(team, more=5):
    think, calls = team.think, []

    def longer(memory, memory_mask, prompts, steps, **kwargs):
        calls.append(1)
        return think(memory, memory_mask, prompts, steps + (more if len(calls) == 2 else 0), **kwargs)

    team.think = longer
    return lambda: team.__dict__.pop("think", None)


def _in_place_swap(memory, mask):
    """Roll the rows of the memory object itself, so the same object reaches the model."""
    swapped(memory, mask)
    return mask.roll(1, 0)


def _think_swapped(team):
    think, calls = team.think, []

    def tampered(memory, memory_mask, prompts, steps, **kwargs):
        calls.append(1)
        if len(calls) == 2:   # the critic starts on another question's memory
            memory_mask = _in_place_swap(memory, memory_mask)
        return think(memory, memory_mask, prompts, steps, **kwargs)

    team.think = tampered
    return lambda: team.__dict__.pop("think", None)


def _decode_swapped(team):
    decode = team.decode

    def tampered(memory, memory_mask, prompts, max_new_tokens, **kwargs):
        if memory is not None:
            memory_mask = _in_place_swap(memory, memory_mask)
        return decode(memory, memory_mask, prompts, max_new_tokens, **kwargs)

    team.decode = tampered
    return lambda: team.__dict__.pop("decode", None)


def _forward_hidden(team):
    """Every agent after the planner stops attending to the planner's prompt (C15's sealed
    behaviour without the sealed flag)."""
    forward, width = team.forward, []

    def hiding(memory, memory_mask, ids=None, mask=None, embeds=None, hidden_only=False, hide=None):
        if not width and ids is not None:
            width.append(ids.shape[1])
        if memory_mask is not None and width and memory_mask.shape[1] > width[0] + 4 and hide is None:
            hide = torch.ones(memory_mask.shape[0], width[0], dtype=memory_mask.dtype, device=memory_mask.device)
        return forward(memory, memory_mask, ids=ids, mask=mask, embeds=embeds, hidden_only=hidden_only, hide=hide)

    team.forward = hiding
    return lambda: team.__dict__.pop("forward", None)


def _positions_shifted(team):
    positions = type(team).positions
    team.positions = lambda full_mask, new_tokens: positions(full_mask, new_tokens) + 1
    return lambda: team.__dict__.pop("positions", None)


def inject(team, name):
    """(thought mode to run with, undo) for one fault."""
    if name == "noise":
        return "random", lambda: None
    if name == "aligned":
        return "aligned", lambda: None
    if name == "adapter":
        from .adapter import ThoughtAdapter
        dim = team.model.get_input_embeddings().weight.shape[1]
        team.adapter = ThoughtAdapter(team.model.config.hidden_size, rank=16, out_dim=dim).to(team.device)

        def undo():
            team.adapter = None
        return "soft", undo
    if name == "missing-close":
        team.close_turn = lambda: ""
        return "soft", lambda: team.__dict__.pop("close_turn", None)
    if name == "repeated-system":
        render = team.render
        team.render = lambda prompts, first=True: render(prompts, first=True)
        return "soft", lambda: team.__dict__.pop("render", None)
    changes = {"span-inserted": _insert, "span-lengthened": _lengthen, "span-removed": _remove,
               "cache-random": _random, "cache-scaled": _scaled, "cache-values": _values, "cache-swapped": swapped}
    if name in changes:
        return "soft", _between(team, 0, changes[name])
    if name == "subagent-text":
        return "soft", _emitting(team)
    if name == "extra-steps":
        return "soft", _extra_steps(team)
    inside = {"think-swapped": _think_swapped, "decode-swapped": _decode_swapped,
              "forward-hidden": _forward_hidden, "positions-shifted": _positions_shifted}
    if name in inside:
        return "soft", inside[name](team)
    raise ValueError(f"unknown fault {name}")


def swap_before_solver(team):
    """Eval 3's fault: another question's memory swapped in after the last thinker."""
    from .team import chain_roles
    return _between(team, len(chain_roles(3)) - 1, swapped)
