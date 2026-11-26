"""The models the harness knows, and which pairs have a trained mapper. Standard library only.

Licence and tokenizer family are facts about the published checkpoints, written here so the
report can print them without a network call. The KV shape is read from each model's config
when it loads and saved with the run, so the table shows what was measured.
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
        "weights": "FP8 (compressed-tensors)", "licence": "Apache-2.0",
        "tokenizer": "byte-level BPE, 151k (Qwen2)", "template": "ChatML", "dtype": "auto",
    },
    "phi3.5": {
        "id": "microsoft/Phi-3.5-mini-instruct", "family": "Phi-3", "params": "3.8B", "weights": "bf16",
        "licence": "MIT", "tokenizer": "SentencePiece BPE, 32k (Llama-2 style)", "template": "Phi-3",
    },
    "llama8": {
        "id": "RedHatAI/Meta-Llama-3.1-8B-Instruct-quantized.w4a16", "family": "Llama 3.1", "params": "8B",
        "weights": "4-bit (compressed-tensors)", "licence": "Llama 3.1 Community",
        "tokenizer": "byte-level BPE, 128k (tiktoken style)", "template": "Llama 3", "dtype": "auto",
    },
    "mistral7": {
        "id": "RedHatAI/Mistral-7B-Instruct-v0.3-quantized.w4a16", "family": "Mistral", "params": "7B",
        "weights": "4-bit (compressed-tensors)", "licence": "Apache-2.0",
        "tokenizer": "SentencePiece BPE, 32.8k (Mistral v3)", "template": "Mistral [INST]", "dtype": "auto",
    },
    "granite8": {
        "id": "RedHatAI/granite-3.1-8b-instruct-quantized.w4a16", "family": "Granite 3.1", "params": "8B",
        "weights": "4-bit (compressed-tensors)", "licence": "Apache-2.0",
        "tokenizer": "byte-level BPE, 49k (GPT-2 style)", "template": "Granite 3", "dtype": "auto",
    },
}

# (sender, receiver) -> where the trained mapper's checkpoint is looked for. Only pairs
# listed here get the latent arm; every other cross-model cell is reported as "no mapper yet".
MAPPERS = {
    ("phi3.5", "qwen1.5"): {"checkpoint": "~/m2b-scale/run1/best.pt", "card": "M2b-S", "id": "ade79c34041fd529"},
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
