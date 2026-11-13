"""C13 level 2: a projection adapter for thought vectors.

The model stays frozen. For the soft and aligned modes the vector fed back for one latent
step becomes

    e' = e + delta(h),   delta(h) = B(A(h)),   A: d -> r,   B: r -> d,

where h is the last-layer hidden state the thought was made from and e the thought the
mode makes without the adapter. B starts at zero, so a fresh adapter is an exact no-op and
training starts from the untrained behaviour. The random mode never uses it: it is the
control, and its thoughts must stay noise at the soft-thought norm.

The adapter works in fp32; team.think() casts the vector back to the model dtype where it
is fed in.
"""
import json
import os

import torch
from torch import nn

WEIGHTS = "adapter.pt"
CONFIG = "adapter.json"


class ThoughtAdapter(nn.Module):
    def __init__(self, dim, rank=16, out_dim=None):
        super().__init__()
        if rank < 1:
            raise ValueError("the adapter rank must be at least 1")
        self.dim, self.rank, self.out_dim = int(dim), int(rank), int(out_dim or dim)
        self.A = nn.Linear(self.dim, self.rank, bias=False, dtype=torch.float32)
        self.B = nn.Linear(self.rank, self.out_dim, bias=False, dtype=torch.float32)
        nn.init.zeros_(self.B.weight)  # an exact no-op until trained

    def forward(self, hidden):
        return self.B(self.A(hidden.float()))

    def config(self):
        return {"kind": "thought-adapter", "dim": self.dim, "rank": self.rank, "outDim": self.out_dim}

    def save(self, directory, extra=None):
        os.makedirs(directory, exist_ok=True)
        torch.save({k: v.detach().cpu() for k, v in self.state_dict().items()}, os.path.join(directory, WEIGHTS))
        with open(os.path.join(directory, CONFIG), "w") as handle:
            json.dump({**self.config(), **(extra or {})}, handle, indent=1)

    @classmethod
    def load(cls, directory, device="cpu"):
        with open(os.path.join(directory, CONFIG)) as handle:
            config = json.load(handle)
        if config.get("kind") != "thought-adapter":
            raise ValueError(f"{directory} does not hold a thought adapter")
        adapter = cls(config["dim"], config["rank"], config["outDim"])
        state = torch.load(os.path.join(directory, WEIGHTS), map_location="cpu", weights_only=True)
        adapter.load_state_dict(state, strict=True)
        return adapter.to(device), config
