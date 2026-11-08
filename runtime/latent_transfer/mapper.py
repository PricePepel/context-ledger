"""The SwaT-style mapper: sender KV cache -> receiver KV cache (arXiv 2610.15095, Sec. 3).

Reimplemented from the paper's description. Per block b:

    h <- h + SelfAttn(LN1(h))           causal, RoPE at receiver positions 0..R-1
    h <- h + CrossAttn(LN2(h), m_b)     cross-tokenizer causal mask, RoPE with
                                        fractional sender positions p_i
    h <- h + FFN(LN3(h))
    out_b = W_out_b(LN_out(h))          keys and values of receiver layer group b

The queries start as projected receiver token embeddings (one per receiver token of
the document). m_b is the sender's de-RoPEd keys and values of layer group b,
concatenated per token, normalized without learned parameters and projected to D.

Outputs are in calibrated units: the caller multiplies by a fixed per-(layer, head,
K/V) RMS taken from real receiver caches (`sigma`), so the stage 1 loss is a plain
MSE against target / sigma. One addition to the paper: a learned "sink" memory slot
that every receiver token can see, so a token with no visible sender token still has
a well-defined attention output.
"""
import math

import torch
import torch.nn as nn
import torch.nn.functional as F


def layer_groups(num_layers, blocks):
    """Contiguous layer groups, Eq. 9: U_b = {l : floor(b L / B) <= l < floor((b+1) L / B)}."""
    return [list(range(b * num_layers // blocks, (b + 1) * num_layers // blocks)) for b in range(blocks)]


class Rope(nn.Module):
    """Rotary embedding that accepts fractional positions."""

    def __init__(self, head_dim, base=10000.0):
        super().__init__()
        inv = 1.0 / (base ** (torch.arange(0, head_dim, 2, dtype=torch.float32) / head_dim))
        self.register_buffer("inv_freq", inv, persistent=False)

    def forward(self, x, positions):
        """x [B, H, T, d]; positions [B, T] (float)."""
        angles = positions.float()[..., None] * self.inv_freq  # [B, T, d/2]
        cos = torch.cat([angles.cos(), angles.cos()], -1)[:, None].to(x.dtype)
        sin = torch.cat([angles.sin(), angles.sin()], -1)[:, None].to(x.dtype)
        half = x.shape[-1] // 2
        rotated = torch.cat([-x[..., half:], x[..., :half]], -1)
        return x * cos + rotated * sin


class Attention(nn.Module):
    def __init__(self, dim, heads, rope):
        super().__init__()
        self.heads, self.head_dim = heads, dim // heads
        self.q = nn.Linear(dim, dim, bias=False)
        self.k = nn.Linear(dim, dim, bias=False)
        self.v = nn.Linear(dim, dim, bias=False)
        self.o = nn.Linear(dim, dim, bias=False)
        self.rope = rope

    def split(self, x):
        batch, tokens, _ = x.shape
        return x.view(batch, tokens, self.heads, self.head_dim).transpose(1, 2)

    def forward(self, x, memory, query_pos, key_pos, allowed):
        """allowed [B, Tq, Tk] bool."""
        q = self.rope(self.split(self.q(x)), query_pos)
        k = self.rope(self.split(self.k(memory)), key_pos)
        v = self.split(self.v(memory))
        out = F.scaled_dot_product_attention(q, k, v, attn_mask=allowed[:, None])
        return self.o(out.transpose(1, 2).reshape(x.shape))


class Block(nn.Module):
    def __init__(self, dim, heads, ffn, sender_width, receiver_width):
        super().__init__()
        rope = Rope(dim // heads)
        self.ln1, self.ln2, self.ln3 = nn.LayerNorm(dim), nn.LayerNorm(dim), nn.LayerNorm(dim)
        self.self_attn = Attention(dim, heads, rope)
        self.cross_attn = Attention(dim, heads, rope)
        self.ffn = nn.Sequential(nn.Linear(dim, ffn), nn.GELU(), nn.Linear(ffn, dim))
        self.mem_norm = nn.LayerNorm(sender_width, elementwise_affine=False)
        self.mem = nn.Linear(sender_width, dim, bias=False)
        self.sink = nn.Parameter(torch.zeros(dim))
        self.ln_out = nn.LayerNorm(dim)
        self.out = nn.Linear(dim, receiver_width, bias=False)

    def forward(self, h, memory, receiver_pos, sender_pos, self_allowed, cross_allowed):
        x = self.ln1(h)
        h = h + self.self_attn(x, x, receiver_pos, receiver_pos, self_allowed)
        m = self.mem(self.mem_norm(memory))
        m = torch.cat([self.sink.to(m.dtype).expand(m.shape[0], 1, -1), m], dim=1)
        h = h + self.cross_attn(self.ln2(h), m, receiver_pos, sender_pos, cross_allowed)
        h = h + self.ffn(self.ln3(h))
        return h, self.out(self.ln_out(h))


class Mapper(nn.Module):
    """Maps a sender's de-RoPEd KV cache to a receiver's (pre-RoPE, calibrated units)."""

    def __init__(self, sender_shape, receiver_shape, receiver_embed_dim, dim=512, heads=8, ffn=2048, blocks=8):
        super().__init__()
        self.sender_shape, self.receiver_shape = tuple(sender_shape), tuple(receiver_shape)
        s_layers, s_heads, s_dim = sender_shape
        r_layers, r_heads, r_dim = receiver_shape
        self.sender_groups = layer_groups(s_layers, blocks)
        self.receiver_groups = layer_groups(r_layers, blocks)
        if any(not group for group in self.sender_groups + self.receiver_groups):
            raise ValueError("More blocks than layers: every block needs at least one layer on each side.")
        self.config = dict(dim=dim, heads=heads, ffn=ffn, blocks=blocks, receiver_embed_dim=receiver_embed_dim)
        self.inp = nn.Linear(receiver_embed_dim, dim, bias=False)
        self.blocks = nn.ModuleList(
            Block(dim, heads, ffn, 2 * len(s_group) * s_heads * s_dim, 2 * len(r_group) * r_heads * r_dim)
            for s_group, r_group in zip(self.sender_groups, self.receiver_groups))
        # Fixed calibration RMS per receiver (layer, head, K/V); set from real caches.
        self.register_buffer("sigma", torch.ones(r_layers, r_heads, 2))

    @staticmethod
    def _memory(keys, values, layers):
        """[B, S, 2 * |group| * H * d]: keys then values of each layer, heads flattened."""
        parts = []
        for layer in layers:
            for tensor in (keys[layer], values[layer]):
                batch, heads, tokens, dim = tensor.shape
                parts.append(tensor.transpose(1, 2).reshape(batch, tokens, heads * dim))
        return torch.cat(parts, dim=-1)

    def forward(self, receiver_embeds, receiver_mask, sender_keys, sender_values, sender_pos, cross_allowed):
        """
        receiver_embeds [B, R, E]  receiver input embeddings of the document tokens
        receiver_mask   [B, R]     1 for real tokens
        sender_keys/values         L_S x [B, Hs, S, d], RoPE removed
        sender_pos      [B, S]     fractional positions on the receiver axis
        cross_allowed   [B, R, S]  sender token i visible to receiver token j

        Returns (keys, values): L_R x [B, Hr, R, d], keys before RoPE, in calibrated
        units (multiply by `sigma` to get receiver-scale tensors; see `scaled`).
        """
        batch, tokens, _ = receiver_embeds.shape
        device = receiver_embeds.device
        receiver_pos = torch.arange(tokens, device=device, dtype=torch.float32)[None].expand(batch, tokens)
        causal = torch.ones(tokens, tokens, dtype=torch.bool, device=device).tril()
        self_allowed = causal[None] & receiver_mask.bool()[:, None, :]
        self_allowed = self_allowed | torch.eye(tokens, dtype=torch.bool, device=device)[None]
        sink_col = torch.ones(batch, tokens, 1, dtype=torch.bool, device=device)
        cross = torch.cat([sink_col, cross_allowed.bool()], dim=-1)
        sink_pos = torch.zeros(batch, 1, device=device)
        key_pos = torch.cat([sink_pos, sender_pos.float()], dim=1)

        r_layers, r_heads, r_dim = self.receiver_shape
        out_keys, out_values = [None] * r_layers, [None] * r_layers
        h = self.inp(receiver_embeds)
        for block, s_group, r_group in zip(self.blocks, self.sender_groups, self.receiver_groups):
            memory = self._memory(sender_keys, sender_values, s_group)
            h, out = block(h, memory, receiver_pos, key_pos, self_allowed, cross)
            out = out.view(batch, tokens, len(r_group), 2, r_heads, r_dim)
            for index, layer in enumerate(r_group):
                out_keys[layer] = out[:, :, index, 0].transpose(1, 2)
                out_values[layer] = out[:, :, index, 1].transpose(1, 2)
        return out_keys, out_values

    def scaled(self, keys, values):
        """Calibrated units -> receiver scale."""
        sk = [k * self.sigma[layer, :, 0].to(k.dtype)[None, :, None, None] for layer, k in enumerate(keys)]
        sv = [v * self.sigma[layer, :, 1].to(v.dtype)[None, :, None, None] for layer, v in enumerate(values)]
        return sk, sv


def calibrate_sigma(keys_list, values_list, masks):
    """Per (layer, head, K/V) RMS of real receiver caches.

    keys_list/values_list: per batch, L_R x [B, H, T, d] (keys before RoPE); masks [B, T].
    """
    layers = len(keys_list[0])
    heads = keys_list[0][0].shape[1]
    total = torch.zeros(layers, heads, 2, dtype=torch.float64)
    count = 0.0
    for keys, values, mask in zip(keys_list, values_list, masks):
        weight = mask.float()[:, None, :, None]
        for layer in range(layers):
            total[layer, :, 0] += (keys[layer].float() ** 2 * weight).sum((0, 2, 3)).double().cpu()
            total[layer, :, 1] += (values[layer].float() ** 2 * weight).sum((0, 2, 3)).double().cpu()
        count += float(mask.sum()) * keys[0].shape[-1]
    return (total / count).sqrt().float()


def parameter_count(module):
    return sum(p.numel() for p in module.parameters() if p.requires_grad)


def init_weights(mapper):
    """Small output projections, so the first prediction is near zero in calibrated units."""
    for block in mapper.blocks:
        nn.init.normal_(block.out.weight, std=0.02 / math.sqrt(2 * len(mapper.blocks)))
    return mapper
