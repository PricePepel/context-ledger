#!/usr/bin/env bash
# Start vLLM for the warm latent pool (WSL Ubuntu, venv ~/venvs/latent).
#
#   bash runtime/serve-vllm.sh
#
# Prefix caching keeps the shared prefix warm between calls, and
# prompt-token details make vLLM report usage.prompt_tokens_details.cached_tokens,
# which the receipts and the cachedShare stat read. The flags were checked
# against `vllm serve --help` for vLLM 0.33.0 in ~/venvs/latent.
#
# Overrides: LATENT_MODEL, VLLM_VENV, VLLM_PORT, VLLM_MAX_MODEL_LEN, VLLM_GPU_UTIL.
set -euo pipefail

VENV="${VLLM_VENV:-$HOME/venvs/latent}"
MODEL="${LATENT_MODEL:-Qwen/Qwen2.5-7B-Instruct-AWQ}"

if [ ! -x "$VENV/bin/vllm" ]; then
  echo "vllm not found in $VENV (set VLLM_VENV)" >&2
  exit 1
fi

# Verified live on 2026-11-07 (RTX 4090 Laptop, WSL Ubuntu 24.04, vLLM 0.33.0):
# - torch.compile and Triton need a C compiler and Python headers:
#   apt-get install -y build-essential python3-dev
# - FlashInfer's sampler JIT-compiles with nvcc, which a pip-only setup lacks, so
#   use vLLM's built-in sampler unless the caller opts back in.
if ! command -v cc > /dev/null; then
  echo "No C compiler: run apt-get install -y build-essential python3-dev" >&2
  exit 1
fi
export VLLM_USE_FLASHINFER_SAMPLER="${VLLM_USE_FLASHINFER_SAMPLER:-0}"

exec "$VENV/bin/vllm" serve "$MODEL" \
  --enable-prefix-caching \
  --enable-prompt-tokens-details \
  --max-model-len "${VLLM_MAX_MODEL_LEN:-32768}" \
  --gpu-memory-utilization "${VLLM_GPU_UTIL:-0.85}" \
  --host 127.0.0.1 \
  --port "${VLLM_PORT:-8000}" \
  "$@"
