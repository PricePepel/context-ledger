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

## Serving

- **Runtime (`POST /latent/transfer`).** It takes `{sender, receiver, text, question}`, and the registry keys trained mappers by (sender, receiver).
  - The response is the receiver's answer text, a receipt (mapper id, token counts, timings), and no tensors.
  - KV tensors never leave the machine.
- **Ledger (`latent_transfer` tool).** The ledger forwards the request. The answer comes back marked as unverified text, the same trust rule as the M2a answer field.

## Next steps after the gate

- **Attention Matching compaction.** Compress the mapped cache to the summary's token budget, so swat and t2t compare at equal size. That is the paper's headline comparison.
- **The 7B pair.** Scale to the 7B model already served for M2a (Qwen2.5-7B) and a Llama-family receiver.
- **Continuous mapper learning** on the user's GPU (M3).
