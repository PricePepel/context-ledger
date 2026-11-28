"""A causal LM whose decoder layers need not all fit on the GPU: each streamed layer is loaded
just before it runs and dropped right after (the AirLLM idea, without AirLLM or accelerate).

Embeddings, the final norm, the LM head and the first `resident_layers` decoder layers stay on
the GPU. The other layers come either from pinned host memory (`source="cpu"`) or from the
checkpoint's safetensors files on every pass (`source="disk"`). The weights that reach the GPU are
the checkpoint's own bf16 tensors, so a streamed pass computes the same thing as a resident one.

Needs torch, transformers and safetensors (the WSL venv). Built for decoder-only models whose
layers live at `model.layers.<i>` (Mistral, Qwen2, Llama); anything else is refused at load.
"""
import gc
import json
import os
import time

import torch
from safetensors import safe_open

LAYER_PREFIX = "model.layers."


def checkpoint_dir(model_id):
    if os.path.isdir(model_id):
        return model_id
    # Not snapshot_download(local_files_only=True): it refuses a snapshot that lacks files this
    # streamer never reads (the Mistral cache has no consolidated.safetensors or README).
    from huggingface_hub.constants import HF_HUB_CACHE
    snapshots = os.path.join(HF_HUB_CACHE, "models--" + model_id.replace("/", "--"), "snapshots")
    found = sorted(os.listdir(snapshots)) if os.path.isdir(snapshots) else []
    found = [os.path.join(snapshots, name) for name in found if os.path.exists(os.path.join(snapshots, name, "config.json"))]
    if len(found) != 1:
        raise FileNotFoundError(f"{model_id}: expected one cached snapshot with a config, found {len(found)}.")
    return found[0]


def weight_files(directory):
    """{tensor name: file path} from the safetensors index, or the single file."""
    index = os.path.join(directory, "model.safetensors.index.json")
    if os.path.exists(index):
        with open(index, encoding="utf-8") as handle:
            mapping = json.load(handle)["weight_map"]
        return {name: os.path.join(directory, file) for name, file in mapping.items()}
    single = os.path.join(directory, "model.safetensors")
    with safe_open(single, "pt") as handle:
        return {name: single for name in handle.keys()}


def layer_of(name):
    """The decoder layer index a checkpoint tensor belongs to, or None."""
    if not name.startswith(LAYER_PREFIX):
        return None
    head = name[len(LAYER_PREFIX):].split(".", 1)[0]
    return int(head) if head.isdigit() else None


def split_names(names, layers, resident_layers):
    """(names loaded once to the GPU, {layer: names streamed for it}). Layers below
    `resident_layers` stay resident; the rest stream."""
    if not 0 <= resident_layers <= layers:
        raise ValueError(f"resident_layers must be between 0 and {layers}, not {resident_layers}.")
    resident, streamed = [], {}
    for name in names:
        index = layer_of(name)
        if index is None or index < resident_layers:
            resident.append(name)
        else:
            streamed.setdefault(index, []).append(name)
    return resident, streamed


def put(root, name, tensor):
    """Set a parameter or buffer by its dotted name, replacing whatever tensor was there."""
    module_name, _, attr = name.rpartition(".")
    module = root.get_submodule(module_name) if module_name else root
    if attr in module._parameters:
        module._parameters[attr] = torch.nn.Parameter(tensor, requires_grad=False)
    elif attr in module._buffers:
        module._buffers[attr] = tensor
    else:
        raise KeyError(f"The model has no tensor named {name}.")


def read_tensors(files, names):
    """{name: CPU tensor} read from the safetensors files, one open per file."""
    by_file, out = {}, {}
    for name in names:
        by_file.setdefault(files[name], []).append(name)
    for file, group in by_file.items():
        with safe_open(file, "pt", device="cpu") as handle:
            for name in group:
                out[name] = handle.get_tensor(name)
    return out


class StreamedModel:
    def __init__(self, model_id, resident_layers=None, source="cpu", device="cuda", dtype=torch.bfloat16,
                 pin=True):
        from transformers import AutoConfig, AutoModelForCausalLM
        if source not in ("cpu", "disk"):
            raise ValueError("source must be 'cpu' or 'disk'.")
        self.directory = checkpoint_dir(model_id)
        self.device, self.source, self.dtype = torch.device(device), source, dtype
        config = AutoConfig.from_pretrained(self.directory)
        with torch.device("meta"):
            model = AutoModelForCausalLM.from_config(config, dtype=dtype)
        model.eval()
        decoder = getattr(getattr(model, "model", None), "layers", None)
        if decoder is None:
            raise ValueError(f"{model_id}: no model.layers, so this streamer cannot run it.")
        self.layers = len(decoder)
        self.resident_layers = self.layers if resident_layers is None else resident_layers
        self.files = weight_files(self.directory)
        resident, streamed = split_names(self.files, self.layers, self.resident_layers)

        for name, tensor in read_tensors(self.files, resident).items():
            put(model, name, tensor.to(self.device, dtype=dtype))
        if "lm_head.weight" not in self.files and getattr(config, "tie_word_embeddings", False):
            model.lm_head.weight = model.model.embed_tokens.weight
        # Buffers are not in the checkpoint; on the meta device they hold nothing. Rotary
        # frequencies are the only ones these architectures have; rebuild them on the GPU.
        rotary = model.model.rotary_emb
        with torch.device(self.device):
            model.model.rotary_emb = type(rotary)(config=config)

        self.model, self.config = model, config
        self.streamed = {}       # layer -> {name inside the layer: host tensor, or None for disk}
        self.shapes = {}         # layer -> {name inside the layer: (shape, dtype)}
        self.pinned = False
        self.stats = {"bytes": 0, "readSeconds": 0.0, "layersLoaded": 0}
        for index, names in sorted(streamed.items()):
            prefix = f"{LAYER_PREFIX}{index}."
            if source == "cpu":
                host = {}
                for name, tensor in read_tensors(self.files, names).items():
                    tensor = tensor.to(dtype)
                    if pin:
                        try:
                            tensor = tensor.pin_memory()
                            self.pinned = True
                        except RuntimeError:
                            pin, self.pinned = False, False
                    host[name[len(prefix):]] = tensor
                self.streamed[index] = host
                self.shapes[index] = {local: (t.shape, t.dtype) for local, t in host.items()}
            else:
                self.streamed[index] = {name[len(prefix):]: None for name in names}
                self.shapes[index] = {}
                for name in names:
                    with safe_open(self.files[name], "pt") as handle:
                        sliced = handle.get_slice(name)
                        self.shapes[index][name[len(prefix):]] = (torch.Size(sliced.get_shape()), dtype)
            self.drop(index)
            layer = decoder[index]
            layer.register_forward_pre_hook(self._pre_hook(index))
            layer.register_forward_hook(self._post_hook(index))
        gc.collect()
        left = [name for name, tensor in list(model.named_parameters()) + list(model.named_buffers())
                if tensor.is_meta and layer_of(name) not in self.streamed]
        if left:
            raise ValueError(f"Tensors not loaded from the checkpoint: {left[:5]}")

    # Streaming hooks --------------------------------------------------------
    def drop(self, index):
        layer = self.model.model.layers[index]
        for local, (shape, dtype) in self.shapes[index].items():
            put(layer, local, torch.empty(shape, dtype=dtype, device="meta"))

    def fetch(self, index):
        if self.source == "cpu":
            return self.streamed[index]
        start = time.perf_counter()
        prefix = f"{LAYER_PREFIX}{index}."
        names = [prefix + local for local in self.streamed[index]]
        tensors = {name[len(prefix):]: t.to(self.dtype) for name, t in read_tensors(self.files, names).items()}
        self.stats["readSeconds"] += time.perf_counter() - start
        return tensors

    def _pre_hook(self, index):
        def hook(module, args):
            for local, tensor in self.fetch(index).items():
                put(module, local, tensor.to(self.device, non_blocking=self.pinned))
                self.stats["bytes"] += tensor.numel() * tensor.element_size()
            self.stats["layersLoaded"] += 1
        return hook

    def _post_hook(self, index):
        def hook(module, args, output):
            self.drop(index)
        return hook

    # Use ------------------------------------------------------------------
    def streamed_bytes(self):
        """Bytes of decoder weights that cross to the GPU on every pass."""
        total = 0
        for shapes in self.shapes.values():
            for shape, dtype in shapes.values():
                total += shape.numel() * torch.empty((), dtype=dtype).element_size()
        return total

    def resident_bytes(self):
        seen, total = set(), 0
        for tensor in list(self.model.parameters()) + list(self.model.buffers()):
            if tensor.is_meta or id(tensor) in seen:
                continue
            seen.add(id(tensor))
            total += tensor.numel() * tensor.element_size()
        return total

    def sync(self):
        if self.device.type == "cuda":
            torch.cuda.synchronize(self.device)

    @torch.no_grad()
    def forward(self, ids, cache=None, logits_to_keep=1):
        feed = torch.tensor([ids], device=self.device) if not torch.is_tensor(ids) else ids
        return self.model(input_ids=feed, past_key_values=cache, use_cache=True, logits_to_keep=logits_to_keep)

    @torch.no_grad()
    def greedy(self, ids, eos, max_new_tokens=24, cache=None, cached=0):
        """Greedy continuation of ids (the first `cached` already in `cache`). Returns token ids."""
        feed, generated = list(ids[cached:]), []
        for _ in range(max_new_tokens):
            out = self.forward(feed, cache)
            cache = out.past_key_values
            token = int(out.logits[0, -1].argmax())
            if token in eos:
                break
            generated.append(token)
            feed = [token]
        self.sync()
        return generated

    def close(self):
        self.model, self.streamed = None, {}
        gc.collect()
        if self.device.type == "cuda":
            torch.cuda.empty_cache()
