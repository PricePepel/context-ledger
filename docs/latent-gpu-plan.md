# Many agents on one small GPU: research and plan

Written 2026-11-21 from three research passes (KV memory, weights and serving, latent communication at scale). The full reports, with every source, were kept outside the repository; this page keeps the decisions and the numbers we rely on. Each number is marked **measured** (by the cited source), **computed** (from model configs) or **estimated** (our arithmetic). Nothing here was measured on our laptop yet; the checks at the end turn the estimates into measurements.

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
- **Starting configuration:** Qwen2.5-7B-AWQ, `--gpu-memory-utilization 0.90`, prefix caching and chunked prefill on, KV offload on, `--max-num-seqs 32` then raise.

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

## Measure first

Before building on the estimates: read vLLM's startup log (weights, CUDA graph memory, KV tokens), run 25, 50 and 100 agents with n-gram speculation on and off, record the prefix-cache hit rate, and run a short multi-turn tool eval comparing the 7B with a 3B.

## Closed models

Claude, GPT and other closed models expose text, not caches, so none of this applies to them. Provider prompt caching lowers the cost of re-reading a shared prefix inside one provider, but nothing can inject a cache into a closed model or read one out. For closed-model agents the cited graph stays the channel; the latent path is for open models on the customer's own GPU.
