"""C13 level 3: LoRA without peft (no new dependency).

Every nn.Linear whose qualified name matches a target pattern is wrapped:

    y = base(x) + (dropout(x) @ A^T @ B^T) * alpha / r

with A: [r, in] (Kaiming uniform, as nn.Linear and peft initialise it), B: [out, r] at zero,
so an injected model computes exactly what the base model did until B is trained. Base
weights are frozen. The LoRA factors are stored and updated in fp32 and cast to the
input's dtype (bf16 for a run) for the matmuls, as autocast would.

A pattern matches a module when it equals the module's last name component (q_proj) or
fnmatch-es its qualified name (model.layers.*.self_attn.o_proj). The default covers the
attention projections of both families the cycle uses: Phi-3.5 (qkv_proj, o_proj) and
Qwen / Llama (q_proj, k_proj, v_proj, o_proj).

Checkpoints hold only the LoRA factors (lora.pt) and the config (lora.json), never the
base weights; load_lora() injects the same modules into a freshly loaded model and loads
the factors into them.
"""
import fnmatch
import json
import math
import os

import torch
from torch import nn

DEFAULT_TARGETS = ("q_proj", "k_proj", "v_proj", "o_proj", "qkv_proj")
WEIGHTS = "lora.pt"
CONFIG = "lora.json"


class LoRALinear(nn.Module):
    def __init__(self, base, rank=16, alpha=32.0, dropout=0.0):
        super().__init__()
        if not isinstance(base, nn.Linear):
            raise TypeError("LoRA wraps nn.Linear modules only")
        if rank < 1:
            raise ValueError("the LoRA rank must be at least 1")
        self.base = base
        self.rank, self.alpha = int(rank), float(alpha)
        self.scaling = self.alpha / self.rank
        device = base.weight.device
        self.lora_A = nn.Parameter(torch.empty(self.rank, base.in_features, dtype=torch.float32, device=device))
        self.lora_B = nn.Parameter(torch.zeros(base.out_features, self.rank, dtype=torch.float32, device=device))
        nn.init.kaiming_uniform_(self.lora_A, a=math.sqrt(5))
        self.dropout = nn.Dropout(dropout) if dropout > 0 else nn.Identity()
        for parameter in self.base.parameters():
            parameter.requires_grad_(False)

    # Code that reads a projection's weight directly still finds the base one.
    @property
    def weight(self):
        return self.base.weight

    @property
    def bias(self):
        return self.base.bias

    @property
    def in_features(self):
        return self.base.in_features

    @property
    def out_features(self):
        return self.base.out_features

    def forward(self, x):
        result = self.base(x)
        # Mixed precision as autocast does it: the fp32 factors are cast to the input dtype
        # for the matmuls, so backward keeps the same x the base layer saved instead of an
        # fp32 copy (with dropout 0) and the factors' gradients land in fp32.
        dtype = x.dtype
        delta = (self.dropout(x) @ self.lora_A.T.to(dtype)) @ self.lora_B.T.to(dtype)
        return result + delta * self.scaling


def _matches(name, targets):
    leaf = name.rsplit(".", 1)[-1]
    return any(leaf == pattern or fnmatch.fnmatchcase(name, pattern) for pattern in targets)


def lora_modules(model):
    """(qualified name, LoRALinear) of every injected module, in model order."""
    return [(name, module) for name, module in model.named_modules() if isinstance(module, LoRALinear)]


def inject_lora(model, targets=DEFAULT_TARGETS, rank=16, alpha=32.0, dropout=0.0):
    """Freeze every base weight and wrap the matching nn.Linear modules. Returns their names."""
    if lora_modules(model):
        raise ValueError("this model already has LoRA modules")
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    targets = tuple(targets)
    names = [name for name, module in model.named_modules()
             if isinstance(module, nn.Linear) and name and _matches(name, targets)]
    if not names:
        raise ValueError(f"no nn.Linear module matches the LoRA targets {list(targets)}")
    for name in names:
        parent_name, _, child = name.rpartition(".")
        parent = model.get_submodule(parent_name) if parent_name else model
        setattr(parent, child, LoRALinear(getattr(parent, child), rank=rank, alpha=alpha, dropout=dropout))
    model._lora_config = {"kind": "lora", "targets": list(targets), "rank": int(rank), "alpha": float(alpha),
                          "dropout": float(dropout), "modules": names}
    return names


def lora_parameters(model):
    """The trainable LoRA factors, A and B of every injected module."""
    return [p for _, module in lora_modules(model) for p in (module.lora_A, module.lora_B)]


def lora_state_dict(model):
    state = {}
    for name, module in lora_modules(model):
        state[f"{name}.lora_A"] = module.lora_A.detach().cpu().clone()
        state[f"{name}.lora_B"] = module.lora_B.detach().cpu().clone()
    return state


def set_lora_training(model, training):
    """Only the LoRA dropout reacts to train mode; the base model stays in eval mode."""
    for _, module in lora_modules(model):
        module.train(training)


def save_lora(model, directory, extra=None):
    config = getattr(model, "_lora_config", None)
    if config is None:
        raise ValueError("this model has no LoRA modules to save")
    os.makedirs(directory, exist_ok=True)
    torch.save(lora_state_dict(model), os.path.join(directory, WEIGHTS))
    with open(os.path.join(directory, CONFIG), "w") as handle:
        json.dump({**config, **(extra or {})}, handle, indent=1)


def load_lora(model, directory):
    """Inject the saved modules into a freshly loaded model and load the saved factors."""
    with open(os.path.join(directory, CONFIG)) as handle:
        config = json.load(handle)
    if config.get("kind") != "lora":
        raise ValueError(f"{directory} does not hold LoRA weights")
    names = inject_lora(model, config["targets"], config["rank"], config["alpha"], config["dropout"])
    if names != config["modules"]:
        raise ValueError("the saved LoRA modules do not match this model's modules")
    state = torch.load(os.path.join(directory, WEIGHTS), map_location="cpu", weights_only=True)
    expected = {f"{name}.lora_{part}" for name in names for part in "AB"}
    if set(state) != expected:
        raise ValueError("the saved LoRA weights do not match the saved modules")
    with torch.no_grad():
        for name, module in lora_modules(model):
            for part in ("A", "B"):
                parameter = getattr(module, f"lora_{part}")
                saved = state[f"{name}.lora_{part}"]
                if saved.shape != parameter.shape:
                    raise ValueError(f"{name}.lora_{part}: saved shape {tuple(saved.shape)}, "
                                     f"model shape {tuple(parameter.shape)}")
                parameter.copy_(saved.to(parameter.device, parameter.dtype))
    return config
