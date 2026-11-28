"""Two ways to route a hand-off through a hub, built on the direct mapper. Needs torch.

split(mapper)   A direct mapper is already an encoder followed by a decoder: each block
                first maps the sender's cache to `dim` numbers per token (a normalisation
                without weights and one linear map, Block.mem), and everything after that
                reads only those numbers. `split` cuts a mapper there. The encoder
                belongs to the sender model, the decoder to the receiver model, and the
                hub state between them is [slots, sender tokens, dim].

chain(...)      Two direct mappers, sender -> pivot and pivot -> receiver, run one after
                the other. The hub state is the pivot model's own cache, as predicted by
                the first mapper.

Neither is trained here. The tests prove that split costs nothing (encoder then decoder
gives the mapper's output exactly) and that both routes keep the mapper's causal order.
"""
import torch
import torch.nn as nn

from latent_transfer.mapper import Mapper


class HubEncoder(nn.Module):
    """One model's way into the hub: per slot, its layers' keys and values -> dim."""

    def __init__(self, shape, dim, groups):
        super().__init__()
        self.shape, self.dim, self.groups = tuple(shape), dim, [list(group) for group in groups]
        _, heads, head_dim = shape
        widths = [2 * len(group) * heads * head_dim for group in self.groups]
        self.norm = nn.ModuleList(nn.LayerNorm(width, elementwise_affine=False) for width in widths)
        self.mem = nn.ModuleList(nn.Linear(width, dim, bias=False) for width in widths)

    def forward(self, keys, values):
        """keys/values: layers x [B, H, S, d], RoPE removed. Returns [B, slots, S, dim].

        The state at sender token i is computed from token i's cache alone, so it holds
        nothing of the text after token i that the model's own cache does not hold.
        """
        return torch.stack([mem(norm(Mapper._memory(keys, values, group)))
                            for norm, mem, group in zip(self.norm, self.mem, self.groups)], dim=1)


class HubDecoder(nn.Module):
    """One model's way out of the hub: a Mapper whose blocks read the hub state directly."""

    def __init__(self, mapper):
        super().__init__()
        self.mapper = mapper

    def forward(self, receiver_embeds, receiver_mask, hub, sender_pos, cross_allowed):
        """hub [B, slots, S, dim]; the other arguments as Mapper.forward. Returns the
        receiver's keys and values in calibrated units, keys before RoPE."""
        mapper = self.mapper
        if hub.shape[1] != len(mapper.blocks) or hub.shape[-1] != mapper.config["dim"]:
            raise ValueError("The hub state is not the shape this decoder reads.")
        batch, tokens, _ = receiver_embeds.shape
        device = receiver_embeds.device
        receiver_pos = torch.arange(tokens, device=device, dtype=torch.float32)[None].expand(batch, tokens)
        causal = torch.ones(tokens, tokens, dtype=torch.bool, device=device).tril()
        self_allowed = causal[None] & receiver_mask.bool()[:, None, :]
        self_allowed = self_allowed | torch.eye(tokens, dtype=torch.bool, device=device)[None]
        sink_col = torch.ones(batch, tokens, 1, dtype=torch.bool, device=device)
        cross = torch.cat([sink_col, cross_allowed.bool()], dim=-1)
        key_pos = torch.cat([torch.zeros(batch, 1, device=device), sender_pos.float()], dim=1)
        r_layers, r_heads, r_dim = mapper.receiver_shape
        out_keys, out_values = [None] * r_layers, [None] * r_layers
        h = mapper.inp(receiver_embeds)
        for slot, (block, r_group) in enumerate(zip(mapper.blocks, mapper.receiver_groups)):
            x = block.ln1(h)
            h = h + block.self_attn(x, x, receiver_pos, receiver_pos, self_allowed)
            m = hub[:, slot]
            m = torch.cat([block.sink.to(m.dtype).expand(batch, 1, -1), m], dim=1)
            h = h + block.cross_attn(block.ln2(h), m, receiver_pos, key_pos, cross)
            h = h + block.ffn(block.ln3(h))
            out = block.out(block.ln_out(h)).view(batch, tokens, len(r_group), 2, r_heads, r_dim)
            for index, layer in enumerate(r_group):
                out_keys[layer] = out[:, :, index, 0].transpose(1, 2)
                out_values[layer] = out[:, :, index, 1].transpose(1, 2)
        return out_keys, out_values

    def scaled(self, keys, values):
        return self.mapper.scaled(keys, values)


def split(mapper):
    """(encoder, decoder) of a direct mapper. The encoder gets copies of the mapper's
    weights; the decoder reads the mapper's own blocks and never touches their `mem`."""
    encoder = HubEncoder(mapper.sender_shape, mapper.config["dim"], mapper.sender_groups)
    with torch.no_grad():
        for target, block in zip(encoder.mem, mapper.blocks):
            target.weight.copy_(block.mem.weight)
    return encoder, HubDecoder(mapper)


def decoder_state(mapper):
    """The decoder's weights alone: a mapper's state without any block's `mem`."""
    return {name: value for name, value in mapper.state_dict().items() if ".mem." not in name}


def mapper_input(batch):
    """A batch's alignment as Mapper.forward takes it: sender padding is never read."""
    return batch.sender_pos, batch.cross_allowed & batch.sender_mask.bool()[:, None, :]


def chain(first, second, pivot_embeds, receiver_embeds, sender_keys, sender_values, to_pivot, from_pivot):
    """sender -> pivot -> receiver through two direct mappers.

    first, second   Mapper(sender -> pivot) and Mapper(pivot -> receiver)
    pivot_embeds    the pivot's input embeddings of the document, [B, P, E]: only the
                    pivot's embedding table and tokenizer are needed, not its layers
    to_pivot        the aligned batch of the (sender, pivot) tokenizers
    from_pivot      the aligned batch of the (pivot, receiver) tokenizers
    Returns (pivot_keys, pivot_values, keys, values): the predicted pivot cache, which is
    the hub state, and the receiver's cache, both at model scale, keys before RoPE.

    Both batches must hold the same pivot tokens. A document that one alignment cut
    shorter than the other is refused, because the second mapper's positions would then
    point at tokens the first never wrote.
    """
    if first.receiver_shape != second.sender_shape:
        raise ValueError("The two mappers do not share a pivot: the first writes a cache the second cannot read.")
    same = (to_pivot.receiver_ids.shape == from_pivot.sender_ids.shape
            and torch.equal(to_pivot.receiver_ids, from_pivot.sender_ids)
            and torch.equal(to_pivot.receiver_mask, from_pivot.sender_mask))
    if not same:
        raise ValueError("The two alignments kept different pivot tokens for this document.")
    position, allowed = mapper_input(to_pivot)
    pivot_keys, pivot_values = first.scaled(*first(pivot_embeds, to_pivot.receiver_mask, sender_keys, sender_values,
                                                   position, allowed))
    position, allowed = mapper_input(from_pivot)
    keys, values = second.scaled(*second(receiver_embeds, from_pivot.receiver_mask, pivot_keys, pivot_values,
                                         position, allowed))
    return pivot_keys, pivot_values, keys, values
