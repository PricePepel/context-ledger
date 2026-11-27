"""A model served by vLLM, for checkpoints transformers cannot load here (AWQ 7B and 8B).

The prompts are the same token ids the torch engine would feed (Prompter), sent to vLLM's
completions route one request at a time, greedy. vLLM does not give a client its KV cache,
so this engine cannot run the cache hand-over arm; the runner records that as a refusal.

Standard library only apart from the tokenizer. The server is started on loopback and
stopped when the engine closes.
"""
import json
import os
import signal
import subprocess
import time
import urllib.error
import urllib.request

from .models import MODELS, shape_of
from .prompting import ANSWER_TOKENS, Prompter

PORT = 8017               # not 8000, so a pool or swarm server left running is never mistaken for ours
MAX_MODEL_LEN = 4096      # above the 2,048-token context of the long_passage group
READY_SECONDS = 600
CACHE_REFUSAL = "vLLM does not give a client its KV cache, so a cache cannot be handed over through it."


def post(url, body, timeout=300.0):
    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def completion_body(model, ids, max_new_tokens):
    """One greedy completion from token ids. The ids already hold the template's special
    tokens, so vLLM must not add its own."""
    return {"model": model, "prompt": [int(token) for token in ids], "max_tokens": max_new_tokens, "temperature": 0,
            "add_special_tokens": False, "skip_special_tokens": True}


def serve_command(vllm, model, port=PORT):
    """No FP8 KV cache: it breaks the AWQ checkpoints here, which carry no KV scales (cycle 11)."""
    return [vllm, "serve", model, "--host", "127.0.0.1", "--port", str(port), "--max-model-len", str(MAX_MODEL_LEN),
            "--gpu-memory-utilization", "0.85"]


class VllmEngine(Prompter):
    hands_over_cache = False

    def __init__(self, key, tokenizer=None, base_url=None, config=None):
        """base_url attaches to a server that is already up (tests); otherwise one is started."""
        spec = MODELS[key]
        self.key, self.name, self.process = key, spec["id"], None
        if tokenizer is None:
            from transformers import AutoConfig, AutoTokenizer
            tokenizer = AutoTokenizer.from_pretrained(self.name)
            config = AutoConfig.from_pretrained(self.name).to_dict()
        self.tok = tokenizer
        self.shape = shape_of(config)
        self.setup_prompts()
        self.base_url = base_url or self.start()

    def start(self):
        venv = os.path.expanduser(os.environ.get("VLLM_VENV", "~/venvs/latent"))
        log = open(os.path.expanduser(f"~/l2-vllm-{self.key}.log"), "w")
        environment = {**os.environ, "VLLM_USE_FLASHINFER_SAMPLER": "0"}
        self.process = subprocess.Popen(serve_command(os.path.join(venv, "bin", "vllm"), self.name), stdout=log,
                                        stderr=subprocess.STDOUT, env=environment, start_new_session=True)
        base, deadline = f"http://127.0.0.1:{PORT}/v1", time.time() + READY_SECONDS
        while time.time() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f"vLLM stopped while loading {self.name}; see {log.name}")
            try:
                with urllib.request.urlopen(base + "/models", timeout=5):
                    return base
            except (urllib.error.URLError, OSError):
                time.sleep(3)
        self.close()
        raise RuntimeError(f"vLLM did not serve {self.name} within {READY_SECONDS} s")

    def close(self):
        if self.process and self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
        self.process = None

    def recover(self):
        pass

    def describe(self):
        return {**MODELS[self.key], "key": self.key, **self.shape, "systemRole": self.system_ok,
                "cacheDtype": "not exposed", "gpuGiB": None}

    def timed(self, ids, max_new_tokens=ANSWER_TOKENS):
        start = time.perf_counter()
        reply = post(self.base_url + "/completions", completion_body(self.name, ids, max_new_tokens))
        return {"answer": reply["choices"][0]["text"].strip(), "ms": (time.perf_counter() - start) * 1000,
                "newTokens": reply["usage"]["completion_tokens"]}

    def answer_from_cache(self, prepared):
        raise NotImplementedError(CACHE_REFUSAL)
