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
#
# Opt-in speed settings measured in cycle 11 (docs/evals.md), both off by default:
# - VLLM_NGRAM=1: n-gram (prompt lookup) speculative decoding, 4 draft tokens.
#   7B: reads 29% faster at p50, same accuracy.
# - VLLM_KV_FP8=1: FP8 KV cache on the Triton attention backend (FLASH_ATTN on
#   this GPU does not take FP8 KV, and FlashInfer needs nvcc). Fine with the 14B
#   AWQ model (one answer of 24 lost, reads 15% faster); it breaks the 7B AWQ
#   model's structured replies (0 of 24), because these checkpoints carry no KV
#   scales.
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

OPTIONAL=()
if [ "${VLLM_NGRAM:-0}" = "1" ]; then
  OPTIONAL+=(--speculative-config '{"method":"ngram","num_speculative_tokens":4,"prompt_lookup_max":4,"prompt_lookup_min":2}')
fi
if [ "${VLLM_KV_FP8:-0}" = "1" ]; then
  OPTIONAL+=(--kv-cache-dtype fp8 --attention-backend TRITON_ATTN)
fi

exec "$VENV/bin/vllm" serve "$MODEL" \
  --enable-prefix-caching \
  --enable-prompt-tokens-details \
  --max-model-len "${VLLM_MAX_MODEL_LEN:-32768}" \
  --gpu-memory-utilization "${VLLM_GPU_UTIL:-0.85}" \
  --host 127.0.0.1 \
  --port "${VLLM_PORT:-8000}" \
  ${OPTIONAL[@]+"${OPTIONAL[@]}"} \
  "$@"
