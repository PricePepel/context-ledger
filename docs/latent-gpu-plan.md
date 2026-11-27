# Many agents on one small GPU: research and plan

Written 2026-11-21 from three research passes (KV memory, weights and serving, latent communication at scale). The full reports, with every source, were kept outside the repository; this page keeps the decisions and the numbers we rely on. Each number is marked **measured** (by the cited source), **computed** (from model configs) or **estimated** (our arithmetic). The levers were measured on our laptop in card L1 (2026-11-26 and 27); the section "What to turn on" below gives the measured result, and the rest of this page still marks which numbers are computed or estimated.

## The question

Can 100 agents run on one 16 GB laptop GPU (RTX 4090 Laptop), hand each other content through latent caches rather than text, and be faster and cheaper than text at equal or better quality?

## What costs memory

At 100 agents the KV cache, not the weights, is the budget. KV bytes per token = 2 × layers × KV heads × head dim × bytes per value (MLA models: layers × (latent rank + rope dim) × bytes).

| Model | KV per token, fp16 (computed) | 100 agents × 4K tokens, fp16 / fp8 / int4 (computed) |
| --- | --- | --- |
| Qwen2.5-7B (4 KV heads) | 56 KiB | 21.9 / 10.9 / 5.5 GiB |
| Qwen2.5-3B | 36 KiB | 14.1 / 7.0 / 3.5 GiB |
| Llama-3.1-8B (8 KV heads) | 128 KiB | 50 / 25 / 12.5 GiB |
| DeepSeek-V2-Lite (MLA) | 30.4 KiB | 11.9 / 5.9 / 3.0 GiB |

Qwen2.5-7B is unusually cheap per token for its size; newer Qwen3 4B–8B models cost about 2.6× more per token. Next to the 7B AWQ weights (about 5.3 GiB) the card leaves about 7–7.7 GiB for KV (estimated).

## The levers, ranked by memory saved per agent

1. **Keep idle agents off the GPU.** Most of 100 agents wait at any moment (estimated 10–30% active). vLLM's native KV offload (`--kv_offloading_backend native`) moves an idle agent's cache to CPU or NVMe. Measured on H100: 50–83 GB/s copies and 2–22× lower time to first token than recomputing. Estimated here: 10–25 ms to bring a 4K agent back against about 1 s to recompute it. Supported in vLLM today.
2. **Share the common prefix.** Agents on one task share a system prompt and the task context. vLLM's automatic prefix caching stores it once (on by default). With 3K of 4K tokens shared, 100 agents need 5.6 GiB in fp16, about 58 MiB each, 3.9× less than without sharing (computed).
3. **Compact what an agent hands over.** Attention Matching (Zweiger et al. 2026, arXiv 2602.16284; the compaction SwaT uses) measured QuALITY 71.1% full vs 70.1% at 20× and 65.0% at 50×, and RULER 95.7 full vs 95.1 at 8×. It needs no training. Eviction methods are riskier for agents that must quote exactly (on RULER at 12.5% kept: SnapKV 67.7, PyramidKV 27.2). vLLM cannot apply Attention Matching (it needs a per-key attention bias), so it runs in our runtime, not in vLLM.
4. **FP8 KV.** Halves KV memory at a measured 1–2 point cost. On this laptop it needs `--attention-backend TRITON_ATTN` and breaks Qwen2.5-7B AWQ (no KV scales); calibrated scales should fix that.
5. **Int4 or 2-bit KV** (KIVI, KVQuant, QServe) loses little in the papers but is not in vLLM.

**Worked estimate (estimated):** sharing plus offload in fp16, about 58 MiB per agent, no new code. With working FP8, about 29 MiB. With Attention Matching at 10× on idle agents, about 8 MiB. 100 agents then need well under the 7 GiB left beside the weights. Compute, not memory, becomes the limit: past about 32–64 concurrent decodes each step is bandwidth-bound, so start with `--max-num-seqs 32` and measure.

## Weights and serving

- **Stay on vLLM.** SGLang's prefix cache is the only rival worth an A/B test, and only for long identical prompts.
- **Formats:** AWQ or GPTQ with Marlin for 3B and up; FP8 W8A8 for 2B and below (measured: INT4 kept 93.5% of reasoning accuracy at 1.5B, FP8 100%; arXiv 2411.02355). No 2-bit weights in vLLM.
- **Personas, not adapters:** a rank-16 LoRA on Qwen2.5-7B is about 81 MB (computed). Give 100 agents system prompts and memory; keep 2–4 skill adapters at most.
- **Small models are weak at multi-turn tool use** (BFCL V4, measured: Llama-3.2-3B 4.0, Gemma-3-4B 0.4, Qwen3-1.7B 11). Workers below 7B need a tool-tuned model, and its licence must be checked before customer use.
- **Speculative decoding:** n-gram only (no extra memory). No draft models on 16 GB. Never offload weights to CPU.
- **Starting configuration (before L1, superseded by "What to turn on"):** Qwen2.5-7B-AWQ, `--gpu-memory-utilization 0.90`, prefix caching and chunked prefill on, KV offload on, `--max-num-seqs 32` then raise.

## Latent hand-offs at this scale

- **What carries content:** KV transfer of the sender's reading of a document through a trained mapper (SwaT; our M2b). Measured in SwaT: 92–108% of full-text accuracy, and with Attention Matching it beats text hand-offs at the same budget (Qwen3-4B to Llama3-8B: 57.8 vs 42.9).
- **What does not:** latent "thoughts" between untrained agents (LatentMAS; our C13–C15). Independent audits agree: arXiv 2608.04893 found no example-specific transfer through C2C's released projector; AVP's cross-model mode scores 7.5% exact match on HotpotQA; arXiv 2607.26773 finds much of the gain is not content-specific. Every gate we run therefore includes a mismatched-cache control.
- **Size in bytes:** a latent message is small in tokens but not in bytes: about 144 KB per token for Qwen3-4B in fp16 (computed), so a 128-token compacted message is about 18 MB, against about 0.5 KB as text. Latent hand-offs belong on one machine (or one rack); across the internet, text wins.
- **Avoiding a mapper per pair:** agents on one base model can share caches without a mapper. Full reuse across fine-tuned variants loses quality (DroidSpeak: over 50% on HotpotQA), but recomputing about 11% of layers keeps it within 1–5% at up to 4× throughput. Activated LoRA (arXiv 2504.12397) accepts the base model's cache with no recompute. Shared hub spaces (2n mappers) are proposed but unmeasured; high alignment scores alone proved nothing in arXiv 2606.03280.
- **Audit:** "When Latent Agents Lie" (arXiv 2606.28958) shows text checks miss KV tampering; an HMAC-SHA256 manifest rejected 295/295 tampered payloads and accepted 774/774 honest ones (measured). This is where the ledger fits: a signed receipt per latent message, receivers cite source spans, and a sample is spot-checked against the text.

## Recommended architecture (estimated 12–14 GB)

- One base model in 4-bit as the shared reader; agents are personas on it, with a few skill adapters.
- Shared prefix stored once; idle agents' caches offloaded to CPU.
- A document is read once, compacted to 64–256 tokens, and the compacted cache is handed to every agent that needs it, by reference.
- Cross-family hand-offs go through SwaT mappers, one per model family in use, one or two resident.
- Every latent message carries a signed receipt in the ledger.

## Experiments that would prove it

| # | Experiment | Pass when |
| --- | --- | --- |
| 1 | M2b-S (this branch): cross-family transfer at 4B scale | Beats the zeroed and mismatched caches and the text summary (intervals above zero), faster end to end than the summary |
| 2 | Attention Matching on the transferred cache, budget-matched against the summary | Equal or better than the summary at equal size, receiver first token at least 2× faster |
| 3 | Same-base hand-off without a mapper (Activated LoRA or partial recompute) | At least 95% of full-text accuracy, at least 5 points above a summary, real minus mismatched cache at least 15 points |
| 4 | 100 agents on one GPU, latent vs text | Peak memory at most 15 GB, at least 2× faster, accuracy at least equal to text |
| 5 | Combining 1–8 messages, plus tampering | At 4 messages at least 90% of single-message accuracy; the manifest rejects all tampering |

## What to turn on (measured, card L1)

Measured on one RTX 4090 Laptop (16 GB), vLLM 0.33.0, Qwen2.5-7B-AWQ at `--gpu-memory-utilization 0.85`, one synthetic task; every number is in [docs/evals.md](evals.md), section "L1".

- **Prefix caching: on (it already is).** 100 agents with about 4K tokens each (3K shared) all fit with peak KV use at 82% of a 137,136-token pool, in 42.6 s; a 23.5K-token shared prefix served 100 agents in 29.9 s at a 98.7% hit rate.
- **Native KV offload (`--kv-offloading-backend native`): leave off.** It exists in 0.33 but cost 10% of the KV pool, took about 4.5 minutes from process start to ready (the other starts took 45 to 125 s), and made 100 agents 2.1× slower (90.8 s against 42.6 s); the same prompts a second time gained nothing (hit rate 54.1% against 53.5%). The buffer is capped by `/dev/shm` (7.8 GiB free here).
- **FP8 KV: only for the 14B, plain `fp8`.** On the 14B AWQ it doubled the KV pool (17,104 to 34,112 tokens) with no answer lost on the dev set (22 against 21 of 24, one round each) and reads 17% faster at p50. On the 7B AWQ it is not usable: `fp8_per_token_head` gave 1.74× the pool but garbled every answer (0 of 100 on the swarm task). Calibrated scales were not produced, so the estimate that they "should fix" the 7B is unproven.
- **`--max-num-seqs`: leave at the default.** 32, 64 and 100 were all slower than the default at 100 agents (swarm task 7.3, 6.2, 5.7 s against 4.8 s) and only freed about 0.7 GiB of GPU memory.
- **Edge cases:** more agents than KV capacity queue and finish (100 × 5.4K tokens: 104 s, no preemption); a 23.5K shared prefix costs 11.5 s once, then is shared; the first request after startup took 1.07 s and the next 0.98 s (one pair, not a repeated test).
- **Still open:** calibrated or per-channel KV scales for the 7B, and agent counts above 100.

## Measure first

Done in L1 for the startup log (weights 5.29 GiB, CUDA graphs 0.61 GiB, KV pool 7.32 GiB = 137,136 tokens) and for 25, 50 and 100 agents with the prefix-cache hit rate. Still to do: 100 agents with n-gram speculation on and off, and a short multi-turn tool eval comparing the 7B with a 3B.

## Closed models

Claude, GPT and other closed models expose text, not caches, so none of this applies to them. Provider prompt caching lowers the cost of re-reading a shared prefix inside one provider, but nothing can inject a cache into a closed model or read one out. For closed-model agents the cited graph stays the channel; the latent path is for open models on the customer's own GPU.
