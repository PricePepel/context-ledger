"""Which pairs get a mapper, in what order, and with what recipe. Standard library only.

The decisions are recorded in docs/evals.md (L5) and docs/architecture.md (ADR-19) and were
fixed before any run. Model keys are latent_compare's, so a trained pair's result lands in
the cell of its table.
"""
from latent_compare.models import MODELS, backend

# Half the M2b-S step counts, everything else as M2b-S (ADR-19).
RECIPE = {"stage1_steps": 8000, "stage2_steps": 10000, "batch1": 4, "batch2": 2, "lr1": 3e-4, "lr2": 1e-5,
          "qa_share": 0.7, "dim": 384, "heads": 6, "ffn": 1536, "blocks": 8, "max_tokens": 256, "seed": 0}
# The one retry of a pair that runs out of memory: the same number of examples per stage
# would double the time, so the steps stay and the record says the batches were halved.
SMALL_BATCHES = {"batch1": 2, "batch2": 1}
FULL_STEPS = {"stage1_steps": 15000, "stage2_steps": 20000}   # M2b-S, if the recipe proves too short

BUDGET_HOURS = 24

# L2's item sets (latent_compare.run.fingerprint of ~/l2-compare/run1/items.json) and the size
# of their main set. A result from any other set is not an L5 result (docs/evals.md, L5).
ITEMS_ID = "62078721512a88db"
MAIN_ITEMS = 200

# The first batch, in order (docs/evals.md, L5).
BATCH = [("phi3.5", "qwen1.5"), ("qwen3", "qwen1.5"), ("qwen1.5", "qwen3"), ("phi3.5", "qwen3"),
         ("granite2", "qwen1.5"), ("qwen3", "qwen0.5"), ("qwen1.5", "phi3.5"), ("qwen1.5", "granite2")]

# Weights of this size (GiB, bf16) leave no room for a second model and the training state on 16 GiB.
TOO_LARGE = {"mistral7": "has 14 GiB of bf16 weights, so no second model and training state fit beside it on 16 GiB"}
NO_CACHE = "runs through vLLM only, which does not hand over a KV cache, and no checkpoint of it loads in torch here"


def pair_name(sender, receiver):
    return f"{sender}__{receiver}"


def ordered_pairs():
    """Every ordered pair of two different registered models."""
    return [(sender, receiver) for sender in MODELS for receiver in MODELS if sender != receiver]


def untrainable(sender, receiver):
    """Why a pair cannot be trained on this machine, or None when it can."""
    for key in (sender, receiver):
        if backend(key) != "torch":
            return f"{key} {NO_CACHE}"
    for key in (sender, receiver):
        if key in TOO_LARGE:
            return f"{key} {TOO_LARGE[key]}"
    return None


def trainable_pairs():
    return [pair for pair in ordered_pairs() if untrainable(*pair) is None]


def recipe(full_steps=False, small_batches=False):
    """The training settings for one run."""
    settings = dict(RECIPE)
    if full_steps:
        settings.update(FULL_STEPS)
    if small_batches:
        settings.update(SMALL_BATCHES)
    return settings


def train_args(sender, receiver, out, settings, resume=None):
    """Arguments of `python -m latent_transfer.train` for one pair."""
    if untrainable(sender, receiver):
        raise ValueError(f"{sender} to {receiver} cannot be trained here: {untrainable(sender, receiver)}")
    args = ["--out", out, "--sender", MODELS[sender]["id"], "--receiver", MODELS[receiver]["id"]]
    for key, value in settings.items():
        args += [f"--{key.replace('_', '-')}", str(value)]
    if resume:
        args += ["--resume", resume]
    return args


def within_budget(hours_used, budget=BUDGET_HOURS):
    """Whether a new pair may start: none starts once the budget is spent."""
    return hours_used < budget


def out_of_memory(log_text):
    """Whether a failed training run's output says the GPU ran out of memory."""
    lowered = log_text.lower()
    return "out of memory" in lowered or "outofmemoryerror" in lowered
