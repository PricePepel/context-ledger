"""KV-cache plumbing for Hugging Face decoder models (Qwen2, Llama, SmolLM).

The cache a model keeps holds keys *after* rotary position embedding (RoPE). A
mapper between families works on position-free keys, so keys are rotated back
("de-RoPEd") on the way in and rotated forward to the receiver's positions on the
way out. Values carry no position and pass through unchanged.

Shapes follow transformers: keys and values are [batch, kv_heads, tokens, head_dim].
"""
from dataclasses import dataclass

import torch
from transformers import DynamicCache


def rotate_half(x):
    half = x.shape[-1] // 2
    return torch.cat((-x[..., half:], x[..., :half]), dim=-1)


def rope_tables(model, positions, dtype):
    """cos and sin of shape [batch, tokens, head_dim] from the model's own rotary module,
    so any rope scaling in its config is honoured."""
    rotary = model.model.rotary_emb
    dummy = torch.zeros(1, device=positions.device, dtype=dtype)
    cos, sin = rotary(dummy.float(), positions)
    return cos.float(), sin.float()


def apply_rope(keys, cos, sin):
    """keys [B, H, T, D]; cos/sin [B, T, D]. Rotates in fp32 and casts back, so a bf16
    remove-then-apply round trip adds no rounding beyond the final cast."""
    k, c, s = keys.float(), cos.float()[:, None], sin.float()[:, None]
    return (k * c + rotate_half(k) * s).to(keys.dtype)


def remove_rope(keys, cos, sin):
    """Inverse of apply_rope: rotate each pair by the negative angle (in fp32)."""
    k, c, s = keys.float(), cos.float()[:, None], sin.float()[:, None]
    return (k * c - rotate_half(k) * s).to(keys.dtype)


@dataclass
class Prefill:
    """One model's prefill of a text: per-layer keys (RoPE removed) and values."""
    keys: list      # num_layers x [B, kv_heads, T, head_dim], position-free
    values: list    # num_layers x [B, kv_heads, T, head_dim]
    input_ids: torch.Tensor  # [B, T]
    attention_mask: torch.Tensor  # [B, T]


def model_shape(model):
    """(layers, kv_heads, head_dim) of a decoder model."""
    config = model.config.get_text_config(decoder=True)
    heads = config.num_attention_heads
    head_dim = getattr(config, "head_dim", None) or config.hidden_size // heads
    kv_heads = getattr(config, "num_key_value_heads", None) or heads
    return config.num_hidden_layers, kv_heads, head_dim


@torch.no_grad()
def prefill(model, input_ids, attention_mask):
    """Run the model over the text once and return its cache with RoPE removed.

    Left padding is not supported: rows are right-padded, so position t is token t.
    """
    positions = torch.arange(input_ids.shape[1], device=input_ids.device)[None].expand_as(input_ids)
    out = model(input_ids=input_ids, attention_mask=attention_mask, use_cache=True, position_ids=positions)
    cache = out.past_key_values
    dtype = next(model.parameters()).dtype
    cos, sin = rope_tables(model, positions, dtype)
    keys, values = [], []
    for layer in cache.layers:
        keys.append(remove_rope(layer.keys.to(dtype), cos, sin))
        values.append(layer.values.to(dtype))
    return Prefill(keys, values, input_ids, attention_mask)


def build_cache(model, keys, values):
    """A receiver cache from position-free keys: RoPE for positions 0..T-1 is applied here.

    Gradients flow through, so the receiver's loss can train whatever produced keys and values.
    """
    batch, _, tokens, _ = keys[0].shape
    positions = torch.arange(tokens, device=keys[0].device)[None].expand(batch, tokens)
    cos, sin = rope_tables(model, positions, keys[0].dtype)
    data = [(apply_rope(k, cos, sin), v) for k, v in zip(keys, values)]
    return DynamicCache(ddp_cache_data=data, config=model.config)


def continue_from_cache(model, cache, prefix_mask, suffix_ids, suffix_mask):
    """Run the receiver over suffix tokens (a question) after an injected cache.

    prefix_mask [B, P] marks which cached positions are real (right padding is masked).
    Each row's suffix starts at that row's real prefix length, so a padded row sees the
    same relative positions as an unpadded one. Returns the model output; logits cover
    the suffix tokens only.
    """
    lengths = prefix_mask.sum(dim=1, keepdim=True)
    positions = lengths + torch.arange(suffix_ids.shape[1], device=suffix_ids.device)[None]
    mask = torch.cat([prefix_mask, suffix_mask], dim=1)
    return model(input_ids=suffix_ids, attention_mask=mask, past_key_values=cache,
                 position_ids=positions, use_cache=True)


@torch.no_grad()
def greedy_after_cache(model, cache, prefix_mask, suffix_ids, max_new_tokens, eos_ids):
    """Greedy decoding for a single row (batch 1) after an injected cache."""
    assert suffix_ids.shape[0] == 1, "greedy_after_cache decodes one row at a time"
    suffix_mask = torch.ones_like(suffix_ids)
    out = continue_from_cache(model, cache, prefix_mask, suffix_ids, suffix_mask)
    cache = out.past_key_values
    mask = torch.cat([prefix_mask, suffix_mask], dim=1)
    position = int(mask.sum())
    generated = []
    next_id = out.logits[:, -1].argmax(-1)
    for _ in range(max_new_tokens):
        token = int(next_id)
        if token in eos_ids:
            break
        generated.append(token)
        mask = torch.cat([mask, torch.ones_like(mask[:, :1])], dim=1)
        out = model(input_ids=next_id[:, None], attention_mask=mask, past_key_values=cache,
                    position_ids=torch.tensor([[position]], device=mask.device), use_cache=True)
        position += 1
        cache = out.past_key_values
        next_id = out.logits[:, -1].argmax(-1)
    return generated
