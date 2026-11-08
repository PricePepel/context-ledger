# M2b: cross-family latent transfer

M2a shares one warm KV cache between calls of **one** model. M2b moves meaning between **two different model families** through their KV caches. The receiver decodes from a cache it never computed, without prefilling the text. This is the technique of SwaT ("Swarm Telepathy", arXiv 2610.15095), reimplemented from the paper. SwaT's code has no license, so none of it is used or read here.

## How it works

1. **Sender prefill.** The sender (Qwen2.5-0.5B-Instruct) reads the document `d` once. Its per-layer keys and values are taken from the cache, and the keys have their rotary position embedding removed.
2. **Alignment.** The two tokenizers split `d` differently, and character spans connect them:
   - Each sender token gets a fractional position on the receiver's token axis.
   - Receiver token `j` may attend to sender token `i` only when `i`'s span ends no later than `j`'s.
3. **Mapper.** A small transformer turns the sender cache into the receiver's cache:
   - B blocks; block `b` reads sender layer group `b` and writes receiver layer group `b`.
   - Its queries are projected receiver token embeddings, one per receiver token of `d`.
   - Each block runs causal self-attention, then causal cross-attention over the sender cache, then an FFN.
   - Each block's output head predicts keys and values for its receiver layers in units of a fixed per-(layer, head) RMS calibration.
4. **Receiver decode.** Receiver RoPE is applied to the predicted keys. The cache is injected as the receiver's past, and the receiver reads only the question and answers.

Both language models stay frozen; only the mapper trains.

- **Stage 1: reconstruction.** MSE between the predicted cache and the receiver's own prefill cache, both divided by the calibration RMS, with keys compared before RoPE.
- **Stage 2: task loss.** The receiver's next-token loss on the answer, with the predicted cache in place of the text. Gradients pass through the frozen receiver into the mapper.

The paper reports that dropping either stage costs about 37 points.

## Scaled-down setting (one 16 GB laptop GPU)

| | Paper | Here |
|---|---|---|
| Pair | 3B to 32B models | Qwen2.5-0.5B → SmolLM2-360M (Qwen2 → Llama architecture, different tokenizers and RoPE bases) |
| Mapper | D=1024, 16 heads, F=4096, B=7–9, about 300M parameters | D=512, 8 heads, F=2048, B=8, about 48M parameters |
| Data | about 44M tokens, 9 training sets | WikiText-103 and SQuAD train, a few million tokens |
| Steps | 5k + 24k | set by the eval below |

Nothing below 3B is reported in the paper. This is a reproduction at about one-tenth the paper's scale, so the gate result is a finding either way.

## Evals (written before the code)

`evals/transfer/` holds the harness. All scoring uses greedy decoding and token F1 against the gold answers (the best over the references).

**Task.** 300 SQuAD v1.1 validation questions, fixed seed, with contexts of at most 384 receiver tokens. SQuAD's validation articles are disjoint from its training articles.

**Conditions, all with the same receiver and prompt text:**

| Condition | What the receiver gets |
|---|---|
| `text` | Its own prefill of `d`, then the question. This is the upper reference. |
| `closed` | No `d` at all, only the question. This is the floor: what it knows already. |
| `swat` | The mapped sender cache of `d`, then the question. |
| `t2t` | A summary of `d` written by the sender, then the question. This is the text-to-text baseline. |

**Metrics:**
- **Retention** = F1(swat) / F1(text). This is the paper's metric.
- **Lift** = (F1(swat) − F1(closed)) / (F1(text) − F1(closed)). This is reported because a small receiver's priors inflate plain retention.
- **Timing:** sender prefill plus mapper time vs receiver prefill time.
- **Reconstruction:** normalized MSE on held-out WikiText.

**Gate (roadmap M2b).** Retention ≥ 0.90 on the SQuAD set. Swat must also beat `closed` by a margin outside the bootstrap 95% interval, so the cache demonstrably carries the document.

**Correctness checks, run before any training:**
- **Identity.** The receiver's own de-RoPEd cache, passed through the same re-RoPE and injection path, must give exactly the `text` condition's greedy output. This proves the plumbing, so training failures are the mapper's.
- **RoPE.** Removing and re-applying RoPE is an exact round trip.
- **Alignment.**
  - With identical tokenizers, sender positions equal token indices.
  - The mask never lets a receiver token see a sender token that ends after it.
- **Gradients.** The stage 2 loss reaches the mapper's parameters through the frozen receiver.

## Result: run 1 (2026-11-07)

**Gate: passed.** Details are in `evals/transfer/run1-summary.json`, with the training log in the same file.

**Training.**
- 5,000 stage 1 steps, then 6,000 stage 2 steps (lr 2e-5, batch 8, 70% SQuAD QA and 30% WikiText continuation).
- One RTX 4090 Laptop GPU, about 1 h 50 min in total, for a mapper of 47.7M parameters.
- Stage 1 brought the normalized reconstruction error from 1.01 to 0.155.
- Stage 2 lifted held-out dev F1 from 0.32 to 0.72. Over the same steps, reconstruction error rose to 0.26: the mapper trades exact cache copies for useful ones.

**Eval:** 300 SQuAD v1.1 validation questions, greedy decoding, receiver SmolLM2-360M.

| Condition | F1 | Gold answer contained | Words per answer |
|---|---|---|---|
| `text`: the receiver reads the passage | 0.407 | 0.587 | 9.3 |
| `closed`: no passage | 0.105 | 0.043 | 5.4 |
| **`swat`: sender cache → mapper → receiver** | **0.757** | **0.700** | 2.7 |
| `zeroed`: the same mapper, sender cache zeroed | 0.156 | 0.097 | 2.7 |
| `t2t`: the sender's 40-word summary, as text | 0.293 | 0.340 | 8.0 |

**What this shows.**
1. **The passage travels through the sender's KV cache.**
   - With the sender's cache zeroed, the same mapper and the same receiver tokens fall to the no-passage level: 10% contained against 70%.
   - The paired 95% interval of `swat` − `zeroed` is +0.55 to +0.65 F1, and of `swat` − `closed` +0.60 to +0.70.
2. **The receiver decodes from a cache it never computed, across families.**
   - The sender is Qwen2 with RoPE base 1e6 and 2 KV heads × 24 layers.
   - The receiver is Llama with RoPE base 1e5 and 5 KV heads × 32 layers.
   - Their tokenizers differ.
3. **Retention above 1 is not "better than reading".**
   - F1 retention is 1.86, inflated by answer style: the mapper's stage 2 trained on SQuAD answers, so its replies are 2.7 words, while the untrained receiver reading the text writes 9.3.
   - By containment, which does not punish long replies, retention is 0.70 / 0.59 = 1.19. Still above 1, because the receiver itself was never trained on SQuAD.
   - The fair upper reference is a receiver fine-tuned on the same SQuAD data and reading the text. It is not run yet, and it is the next control.
4. **Against text-to-text:** the cache transfer beats the sender's written summary at 0.76 vs 0.29 F1. That summary is not budget-matched; Attention Matching compaction is still to come.
5. **Cost:** sender prefill 49 ms plus mapper 54 ms per question. End to end, 0.39 s against 0.80 s for `text`, but shorter answers account for part of that.

**Training notes for the next run.**
- Dev F1 swings ±5 points between checks, since there are 100 dev questions.
- The paper's stage 2 learning rate is 3e-6, ours 2e-5. A lower rate, or a larger dev set for checkpoint selection, should steady it.

## Serving

- **Runtime (`POST /latent/transfer`).** It takes `{sender, receiver, text, question}`, and the registry keys trained mappers by (sender, receiver).
  - The response is the receiver's answer text, a receipt (mapper id, token counts, timings), and no tensors.
  - KV tensors never leave the machine.
- **Ledger (`latent_transfer` tool).** The ledger forwards the request. The answer comes back marked as unverified text, the same trust rule as the M2a answer field.

## Next steps after the gate

- **Attention Matching compaction.** Compress the mapped cache to the summary's token budget, so swat and t2t compare at equal size. That is the paper's headline comparison.
- **The 7B pair.** Scale to the 7B model already served for M2a (Qwen2.5-7B) and a Llama-family receiver.
- **Continuous mapper learning** on the user's GPU (M3).
