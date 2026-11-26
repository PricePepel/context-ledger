"""Optional norm calibration of transferred states (L3; idea from arXiv 2608.13317).

A state written by one model can point the right way and still be the wrong length for
the model that reads it. Calibration rescales states so their L2 norm matches what the
receiver sees in its own data: its input-embedding norms for states fed in as
embeddings, or its own cache statistics (the mapper's `sigma`) for mapped KV caches.

Off by default everywhere. Nothing here is trained.

    scale = target / observed, optionally kept within [1 / max_scale, max_scale]

- per group: one scale for a whole row (all real tokens of one document), from the
  mean norm of its real tokens; relative lengths between tokens are kept.
- per token: every real token is rescaled to the target on its own.

Padding (mask 0) is left out of the statistics and is not rescaled.

The list functions are the reference arithmetic and need no torch; the tensor functions
do the same on batches.
"""
import math


def scale_factor(observed, target, max_scale=None):
    """target / observed, clamped to [1 / max_scale, max_scale]; 1 for a zero observed norm."""
    if max_scale is not None and max_scale < 1:
        raise ValueError("max_scale must be at least 1.")
    if observed <= 0:
        return 1.0
    scale = target / observed
    if max_scale is not None:
        scale = min(max_scale, max(1.0 / max_scale, scale))
    return scale


def l2(vector):
    return math.sqrt(sum(x * x for x in vector))


def mean_norm(rows, mask=None):
    """Mean L2 norm of the real rows."""
    norms = [l2(row) for index, row in enumerate(rows) if mask is None or mask[index]]
    return sum(norms) / len(norms) if norms else 0.0


def calibrate_rows(rows, target, mask=None, per_token=False, max_scale=None):
    """Reference arithmetic on a list of vectors (one document's tokens)."""
    group = scale_factor(mean_norm(rows, mask), target, max_scale)
    out = []
    for index, row in enumerate(rows):
        if mask is not None and not mask[index]:
            out.append(list(row))
            continue
        scale = scale_factor(l2(row), target, max_scale) if per_token else group
        out.append([x * scale for x in row])
    return out


# Tensor versions -------------------------------------------------------------------

def norm_stats(vectors, mask=None):
    """Mean, standard deviation and median of the L2 norms of [..., D] vectors (mask [...])."""
    norms = vectors.float().norm(dim=-1)
    norms = norms[mask.bool()] if mask is not None else norms.reshape(-1)
    return {"mean": float(norms.mean()), "std": float(norms.std()) if norms.numel() > 1 else 0.0,
            "median": float(norms.median()), "count": int(norms.numel())}


def embedding_norm_stats(model):
    """Norm statistics of a model's input-embedding rows: the target for states that are
    fed to it as embeddings."""
    return norm_stats(model.get_input_embeddings().weight.detach())


def _scale(observed, target, max_scale):
    """target / observed where observed > 0, else 1; safe to differentiate at zero."""
    import torch
    if max_scale is not None and max_scale < 1:
        raise ValueError("max_scale must be at least 1.")
    positive = observed > 0
    scale = target / torch.where(positive, observed, torch.ones_like(observed))
    if max_scale is not None:
        scale = scale.clamp(min=1.0 / max_scale, max=max_scale)
    return torch.where(positive, scale, torch.ones_like(scale))


def _root(energy):
    """sqrt that is 0 with a zero gradient at 0 (plain sqrt gives an infinite one)."""
    import torch
    positive = energy > 0
    return torch.where(positive, torch.where(positive, energy, torch.ones_like(energy)).sqrt(),
                       torch.zeros_like(energy))


def calibrate_states(states, target, mask=None, per_token=False, max_scale=None):
    """states [B, T, D] -> the same shape with norms moved to `target` (a number).

    mask [B, T] marks real tokens. Each row of the batch is calibrated on its own, so a
    row gives the same result alone and inside a padded batch. Padding is returned as it
    came in and never enters the statistics, whatever it holds.
    """
    import torch
    real = torch.ones(states.shape[:-1], dtype=torch.bool, device=states.device) if mask is None \
        else mask.to(states.device).bool()
    values = torch.where(real[..., None], states.float(), torch.zeros((), device=states.device))
    norms = _root((values ** 2).sum(-1))                         # [B, T], 0 on padding
    if per_token:
        observed = norms
    else:
        observed = (norms.sum(-1) / real.sum(-1).clamp(min=1))[:, None].expand_as(norms)
    scale = _scale(observed, target, max_scale)
    return torch.where(real[..., None], (values * scale[..., None]).to(states.dtype), states)


def calibrate_cache(keys, values, sigma, mask, max_scale=None):
    """Mapped receiver cache -> the same cache with each document's per-(layer, head) RMS
    moved to the receiver's own (`sigma[layer, head, 0]` for keys, `[..., 1]` for values).

    keys/values: L x [B, H, T, d] at receiver scale, keys before RoPE; mask [B, T].
    `sigma` is the RMS per element, as `mapper.calibrate_sigma` measures it on real
    receiver caches, so no new statistics are needed. Padding is returned as it came in
    and never enters the statistics.
    """
    import torch
    real = mask.to(keys[0].device).bool()[:, None, :, None]      # [B, 1, T, 1]
    count = (real.sum((2, 3)).clamp(min=1) * keys[0].shape[-1]).float()        # [B, 1]
    out = ([], [])
    for kind, tensors in enumerate((keys, values)):
        for layer, tensor in enumerate(tensors):
            inside = torch.where(real, tensor.float(), torch.zeros((), device=tensor.device))
            observed = _root((inside ** 2).sum((2, 3)) / count)                # [B, H]
            scale = _scale(observed, sigma[layer, :, kind].float().to(observed.device)[None], max_scale)
            out[kind].append(torch.where(real, (inside * scale[:, :, None, None]).to(tensor.dtype), tensor))
    return out
