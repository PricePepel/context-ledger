"""The models the harness knows, and which pairs have a trained mapper. Standard library only.

Licence and tokenizer family are facts about the published checkpoints, written here so the
report can print them without a network call. The KV shape is read from each model's config
when it loads and saved with the run, so the table shows what was measured.

Only checkpoints that load in torch with the venv as it is are listed. The 4-bit Llama-3.1-8B
and Mistral-7B checkpoints on this machine are GPTQ format and need `optimum`, and the 4-bit
Granite-3.1-8B decompresses to 16 GB of dense weights, so those three are not here
(docs/evals.md, L2). Llama-3.2-3B is gated and needs a Hugging Face token.
"""

MODELS = {
    "qwen1.5": {
        "id": "Qwen/Qwen2.5-1.5B-Instruct", "family": "Qwen2.5", "params": "1.5B", "weights": "bf16",
        "licence": "Apache-2.0", "tokenizer": "byte-level BPE, 151k (Qwen2)", "template": "ChatML",
    },
    "qwen3": {
        "id": "Qwen/Qwen2.5-3B-Instruct", "family": "Qwen2.5", "params": "3B", "weights": "bf16",
        "licence": "Qwen Research (non-commercial)", "tokenizer": "byte-level BPE, 151k (Qwen2)",
        "template": "ChatML",
    },
    "qwen7": {
        "id": "RedHatAI/Qwen2.5-7B-Instruct-FP8-dynamic", "family": "Qwen2.5", "params": "7B",
        "weights": "FP8 checkpoint, decompressed to bf16 in torch", "licence": "Apache-2.0",
        "tokenizer": "byte-level BPE, 151k (Qwen2)", "template": "ChatML", "dtype": "auto",
    },
    "phi3.5": {
        "id": "microsoft/Phi-3.5-mini-instruct", "family": "Phi-3", "params": "3.8B", "weights": "bf16",
        "licence": "MIT", "tokenizer": "SentencePiece BPE, 32k (Llama-2 style)", "template": "Phi-3",
    },
    "granite2": {
        "id": "ibm-granite/granite-3.1-2b-instruct", "family": "Granite 3.1", "params": "2.5B", "weights": "bf16",
        "licence": "Apache-2.0", "tokenizer": "byte-level BPE, 49k (GPT-2 style)", "template": "Granite 3",
    },
    "mistral7": {
        "id": "mistralai/Mistral-7B-Instruct-v0.3", "family": "Mistral", "params": "7.2B", "weights": "bf16",
        "licence": "Apache-2.0", "tokenizer": "SentencePiece BPE, 32.8k (Mistral v3)", "template": "Mistral [INST]",
    },
}

# (sender, receiver) -> where the trained mapper's checkpoint is looked for. Only pairs
# listed here get the latent arm; every other cross-model cell is reported as "no mapper yet".
MAPPERS = {
    ("phi3.5", "qwen1.5"): {"checkpoint": "~/m2b-scale/run1/best.pt", "card": "M2b-S", "id": "ade79c34041fd529",
                            "referenceF1": 0.872, "referenceItems": 300},
}

# Candidates of the card that are not in MODELS, and why. The report prints them.
NOT_RUN = {
    "Llama-3.1-8B (4-bit, RedHatAI w4a16)": "GPTQ format: transformers needs `optimum` to load it, which the venv does not have",
    "Mistral-7B v0.3 (4-bit, RedHatAI w4a16)": "GPTQ format, same reason; the bf16 checkpoint runs instead",
    "Granite-3.1-8B (4-bit, RedHatAI w4a16)": "loads, then decompresses to 15.9 GiB of dense weights and spills to host "
                                              "memory (352 s for one answer); Granite-3.1-2B runs instead",
    "Llama-3.2-3B": "gated on Hugging Face and this machine has no token",
}


def keys(names=None):
    """Model keys for a run: all of them, or the comma-separated ones asked for, in table order."""
    if not names:
        return list(MODELS)
    wanted = [name.strip() for name in names.split(",") if name.strip()]
    unknown = [name for name in wanted if name not in MODELS]
    if unknown:
        raise ValueError(f"Unknown model key: {', '.join(unknown)}. Known: {', '.join(MODELS)}.")
    if len(set(wanted)) != len(wanted):
        raise ValueError("A model key is listed twice.")
    return wanted


def latent_status(sender, receiver):
    """What the latent cell of a pair holds: 'self' (same model, cache handed straight over),
    'mapper' (a trained mapper exists) or 'none' (no mapper yet)."""
    if sender == receiver:
        return "self"
    return "mapper" if (sender, receiver) in MAPPERS else "none"


def shape_of(config):
    """{layers, kvHeads, headDim, hidden, context} from a model config dict."""
    heads = config["num_attention_heads"]
    return {
        "layers": config["num_hidden_layers"],
        "kvHeads": config.get("num_key_value_heads") or heads,
        "headDim": config.get("head_dim") or config["hidden_size"] // heads,
        "hidden": config["hidden_size"],
        "context": config.get("max_position_embeddings"),
    }
