# Mapper hub: one shared space instead of a mapper per pair (T1a)

Design only. Nothing here is trained or measured on a GPU. The eval and its pass rule are in [evals.md](evals.md) under T1a, written before any run. The CPU prototype is in `runtime/latent_hub/`.

## Summary

- **The problem.** M2b-S trains one mapper per ordered pair of models. A library of N models needs N × (N − 1) of them: 12 for 4 models, 56 for 8.
- **The recommendation.** Cut the direct mapper where it already has a seam. Every model gets an **encoder** (its cache to 8 × 384 numbers per token) and a **decoder** (those numbers to its own cache). A hand-off from A to B is A's encoder followed by B's decoder. This is the "split hub". N models need 2N parts, and a new model adds two.
- **What is proven.** The split costs nothing by itself: a direct mapper cut this way gives bit-identical output (a CPU test in this card). So a split hub can lose quality only because parts are shared, never because the route got narrower.
- **What is not known.** Whether shared parts keep the quality of direct mappers. No paper we opened compares a hub with pairwise mappers across model families. The closest one built a hub for small models of one architecture and reports that it grows without retraining (section 7). The eval below measures it against L5's direct mappers on the M2b-S items, with a 0.05 F1 margin.
- **A test that needs no training.** L5's batch is a star around Qwen2.5-1.5B. Chaining two of its mappers through that model's cache (the "pivot hub") reaches Phi-3.5 to Qwen2.5-3B, a pair L5 also trains directly. That comparison is an eval-only run of about 1.5 GPU hours after L5 ends. My expectation is that the chain loses quality, for the reason in section 3.
- **It is not a privacy feature.** The runtime holds the document's text at both ends, and caches can be turned back into text.

## 1. The hub's shape

### What the direct mapper already does

`latent_transfer/mapper.py` runs 8 blocks. Block `b` does two separate things:

1. It takes the sender's keys and values of layer group `b`, normalises them without learned weights (`mem_norm`) and maps them through one linear layer (`mem`) to 384 numbers per sender token.
2. Everything else reads only those 384 numbers: cross-attention from the receiver's token embeddings, self-attention, the FFN and the output head that writes receiver layer group `b`.

Step 1 depends on the sender alone. Step 2 depends on the receiver alone. The direct mapper is an encoder followed by a decoder; it just never stored them apart.

### The split hub (recommended)

| Question | Answer |
| --- | --- |
| Per layer or one space | **8 depth slots**, each its own space of 384 numbers per sender token. Slot `b` holds layer group `b` of the sender and is read when writing layer group `b` of the receiver. This is `layer_groups`, unchanged |
| Size | 8 × 384 = 3,072 numbers per token, 6 kB in 16-bit floats. Phi-3.5's own cache is 196,608 numbers per token, Qwen2.5-1.5B's 14,336 |
| Different layer counts | Each model's layers fall into 8 contiguous groups by relative depth. A model needs at least 8 layers |
| Different head counts and head sizes | Heads are flattened into the encoder's input and the decoder's output, as today |
| Different RoPE | Keys lose their rotation before the encoder and get the receiver's rotation after the decoder (`kv.py`), as today |
| Different tokenizers | The hub state stays on the **sender's** token axis and travels with the sender's character spans. The decoder aligns those spans with its own tokens by L3's rule 2 (`align.py`): fractional positions and the causal mask. No shared token axis is needed |
| What the receiver side needs | Its own token embeddings of the document (the decoder's queries), so the runtime tokenizes the text for the receiver. The receiver model does not prefill it |

The encoder is linear and works token by token, so the hub state at sender token `i` holds nothing about later text that the sender's own cache does not hold. The decoder's causal mask relies on that. A deeper encoder would have to keep it with causal attention; the prototype tests it.

### The pivot hub (the alternative that needs no training)

The hub space is one real model's cache, the pivot's. Every other model has a direct mapper into the pivot's cache and one out of it. A hand-off runs two mappers and needs the pivot's tokenizer and embedding table, not its layers.

L5's first batch already is this, with Qwen2.5-1.5B as the pivot:

| L5 pair | Role in a pivot hub |
| --- | --- |
| 1 Phi-3.5 → Qwen2.5-1.5B, 2 Qwen2.5-3B → Qwen2.5-1.5B, 5 Granite-3.1-2B → Qwen2.5-1.5B | Into the pivot |
| 3 Qwen2.5-1.5B → Qwen2.5-3B, 7 Qwen2.5-1.5B → Phi-3.5, 8 Qwen2.5-1.5B → Granite-3.1-2B | Out of the pivot |
| 4 Phi-3.5 → Qwen2.5-3B | A direct mapper for a route the chain 1 then 3 also reaches |
| 6 Qwen2.5-3B → Qwen2.5-0.5B | Not part of the star |

Qwen2.5-1.5B suits the role: Apache-2.0, a small cache (2 KV heads), and the receiver of the one mapper that has passed its gates.

### Alternatives considered

| Alternative | Why not first |
| --- | --- |
| Direct mappers only | Works (M2b-S). 12 trainings for 4 models, 56 for 8, and every new model retrains against all the others |
| Pivot hub | Free to test. Two mapper passes per hand-off. The second mapper was trained on real pivot caches and now reads predicted ones (section 3) |
| One hub space for all layers | The mapper's blocks are tied to depth; one space would need a new decoder design and gives up the proven one |
| A hub on a neutral axis (characters or fixed slots) | Removes the sender's spans from the message, but needs a resampling step nobody has tested. The sender axis with L3's alignment is already audited |
| Hidden states instead of the cache | The receiver is driven through its cache either way, so hidden states only change the encoder's input. No evidence it helps; the cache path is the one with a passing eval |
| A closed-form shared space (anchors, rotations) | L4 measured the closed-form route on these models: 0 of 28 checks passed |
| Text | The baseline: 0.460 F1 against 0.872 for the mapper (M2b-S) |

## 2. Training

### Jointly, in pair blocks

All parts of the founding set train together, so no model's space is privileged.

- **Each step trains one route.** Sample a sender and a receiver, run the sender's encoder and the receiver's decoder, and apply M2b's two losses: stage 1 is the reconstruction error against the receiver's own cache, stage 2 is the receiver's answer loss through the frozen receiver.
- **Self routes in stage 1.** A model's encoder into its own decoder is trained as well. It costs one model, and it is the only route a single model can train alone.
- **Memory decides the schedule.** Phi-3.5 (7.6 GiB of weights), Qwen2.5-3B (6.2 GiB) and Qwen2.5-1.5B (3.1 GiB) do not fit a 16 GB GPU together. Training keeps two models loaded, trains every route between them for 1,000 steps, then swaps one model and moves to the next pair. Whether the hub forgets a pair while training the others is a risk the eval's per-route numbers show.
- **Budget.** Each part gets about as many updates as an L5 mapper: for three models, 3 × 8,000 stage 1 steps and 3 × 10,000 stage 2 steps. That is three mappers' worth of GPU time for six routes.

### One model at a time, against a frozen hub

A model that joins later trains only its own two parts. Every existing part is frozen.

- Its encoder trains against the frozen decoders of at least two members, and its decoder against their frozen encoders, in the same pair blocks.
- Old routes cannot change: none of their weights are touched. The eval checks this by comparing outputs before and after.
- Whether the new model's routes are as good as a jointly trained one is the growth test (step 3 of the eval). Prior work suggests routes that never trained together lose more than routes that did (section 7).

A hub retrained from scratch is a new hub with a new id. Parts of different hubs are never mixed, and the manifest refuses it.

## 3. Expected quality loss, and the test

### What to expect

No number exists for this. What is known:

- **The split itself: zero.** Proven here on CPU. A split hub can represent every direct mapper.
- **Sharing: unknown, plausibly small on trained routes.** One encoder must suit every decoder. The published analogue is a shared translation model, which lost little on the pairs it was trained on and more on pairs it never saw (section 7). A model added later is in the second case.
- **The chain: probably a real loss.** Stage 2 lets a mapper drift from the true cache to a useful one: in M2b run 1 the reconstruction error rose from 0.155 to 0.26 while dev F1 rose from 0.32 to 0.72. The chain's second mapper trained on real pivot caches and reads the first mapper's drifted ones. No part was trained for that. If the chain holds anyway, the library ships from L5's files with no further training, so it is worth the 1.5 hours.

### The test

Defined in full in [evals.md](evals.md), T1a. In short:

- **Items.** The 300 SQuAD v1.1 validation questions of M2b-S (seed 0, IDs checked by the runner), token F1, plain greedy decoding.
- **Arms per route.** `hub`, `direct` (the L5 mapper, re-evaluated on the same items), `mismatched` (the next item with a different passage, through the same route), `zeroed`, `t2t`, `text`, `closed`.
- **Pass rule per route, fixed before any run.**
  1. Carries the passage: `hub − mismatched` and `hub − zeroed` have paired 95% intervals above zero.
  2. Beats the text summary: `hub − t2t` has its interval above zero.
  3. Keeps direct quality: the lower end of the paired 95% interval of `hub − direct` is above −0.05 F1.
- **Three steps, cheapest first.**
  1. The chain of L5's mappers through Qwen2.5-1.5B. Eval only.
  2. A jointly trained split hub on Phi-3.5, Qwen2.5-1.5B and Qwen2.5-3B, against up to five L5 direct mappers.
  3. Granite-3.1-2B added against the frozen hub.

One route with a direct comparator (step 1) is evidence about that route. "The hub keeps direct quality" is claimed for the library only after step 2, where five routes are compared.

## 4. Cost

Sizes are exact counts from the mapper's definition (`latent_hub/plan.py`, checked against the trained M2b-S mapper's 100,509,696 parameters). Times are estimates until L5 reports its measured seconds per step.

### Files (16-bit floats)

| Model | Cache, numbers per token | Encoder | Decoder |
| --- | --- | --- | --- |
| Phi-3.5-mini | 196,608 | 75.5M parameters, 151 MB | 95.6M, 191 MB |
| Qwen2.5-1.5B | 14,336 | 5.5M, 11 MB | 25.0M, 50 MB |
| Qwen2.5-3B | 18,432 | 7.1M, 14 MB | 26.8M, 54 MB |
| Granite-3.1-2B | 40,960 | 15.7M, 31 MB | 35.4M, 71 MB |

A part's size follows the width of its model's cache. Phi-3.5 has 32 KV heads and no grouped-query attention, so its two parts are larger than everything else together.

| Library of these 4 models | Files | Total size |
| --- | --- | --- |
| Direct, all 12 pairs | 12 | 1.72 GB |
| Pivot hub | 6 | 0.70 GB |
| Split hub | 8 | 0.57 GB |

### GPU hours

One L5 mapper is about 2.8 hours on the laptop GPU. This is an estimate from the M2b-S log (5.4 hours for twice the steps); L5 is measuring it.

| | 4 models | 8 models | One more model |
| --- | --- | --- | --- |
| Direct | 12 mappers, about 34 h | 56, about 157 h | 2 × (N) more mappers: 8 for a fifth model |
| Pivot hub | 6 mappers, about 17 h. **None new if L5 finishes pairs 1, 2, 3, 5, 7 and 8** | 14, about 39 h | 2 mappers, about 6 h |
| Split hub | About 4 mappers' worth, 11 h, plus model swaps | About 8, 22 h | About 2, 6 h |

The split hub's row assumes each part needs as many updates as a direct mapper gets. If shared parts need more, the row grows; the eval records the steps used.

Three of L2's eight models cannot be trained on this machine at all (Mistral-7B in bf16, and the two 4-bit models that only vLLM serves), whichever design is chosen. That is L5's finding and a hub does not change it.

### Load time and per-hand-off overhead

| | Split hub | Pivot hub |
| --- | --- | --- |
| Compute per hand-off | The same as a direct mapper: it is the same function. M2b-S measured 52 ms for the mapper in a 426 ms hand-off | Two mapper passes and two alignments. Roughly 55 ms more; not measured |
| Extra memory | None beyond the two parts | The pivot's embedding table, about 0.5 GB for Qwen2.5-1.5B |
| Load | Two files of 11 to 191 MB, each hashed before loading | Two files of 64 to 202 MB |

Load time is not measured. It is bounded by reading and hashing at most 400 MB, and is part of the step 1 report.

## 5. The library

The prototype is `runtime/latent_hub/library.py`. It needs only the standard library.

### What a mapper is keyed by

A mapper fits one exact cache. The key of a model build is the SHA-256 of:

- the repository id and the commit the files came from;
- the SHA-256 of every weights file;
- how the weights are loaded (`bf16`, `awq-int4`, …) and the type of the cache handed over (`bf16`, `fp8`);
- the SHA-256 of the tokenizer files, because alignment depends on them;
- the cache shape.

Today's registry (`latent_pool/mappers.py`) hashes only the model's name. Two quantisations of one model share that name and write different caches, so the name is not enough.

### The manifest

One JSON file, shipped inside the npm package, so the package's own integrity covers it.

| Section | Holds |
| --- | --- |
| `hub` | Its id, kind (`split` or `pivot`), slots, width, alignment rule, the token cap the parts were trained with, the document format, and the pivot's build key for a pivot hub |
| `builds` | Each build key with the model's name, revision, quantisation, cache type, shape and licence |
| `parts` | One encoder and one decoder per build: file name, SHA-256, size, the result of its own gate, and the card that measured it |
| `routes` | Every measured ordered pair: passed or failed, its F1, and the card |
| `canary` | A synthetic passage, a question and the expected answer |

The files themselves are not in the package: 0.6 GB is too large for it.

### Download and load

- **Download is a command the user runs,** for example `context-ledger mappers pull` for the models they have. The runtime never fetches on its own (AGENTS.md section 6: no background collection).
- `fetch` reads over https only, stops when a file exceeds its declared size, and keeps the file only when size and SHA-256 match. A file that fails is deleted.
- **Every load checks again.** The library folder is writable by other local programs, so `verify` hashes a part before it is loaded.
- **Format: safetensors.** The file holds tensors and no code. Today's checkpoints are `torch.save` files loaded with `weights_only=True`.
- **Canary.** After loading a route's parts for the first time, the runtime hands off the manifest's passage and checks the answer. A part that fails is not used.

### How `latent_transfer` picks the parts

MCP carries text only, and that does not change. The tool's schema stays as it is: `sender` and `receiver` are model names.

1. The ledger forwards the request to the runtime (`POST /latent/transfer`), as today.
2. The runtime knows which builds it has loaded and their keys. It asks the library for the route from the sender's build to the receiver's.
3. The library returns the sender's encoder and the receiver's decoder, or a refusal.
4. The runtime runs the hand-off in its own process. Tensors never leave it.
5. The answer comes back as unverified text with a receipt. The receipt gains the hub id, the route's kind and both parts' SHA-256.

### Refusals

Every refusal names the model and the reason. The tool then falls back to returning the text, as it does today for a missing mapper.

| Case | What the message says |
| --- | --- |
| A model the library does not hold | "no mapper for `<name>`", and the models it covers |
| A covered model in another build | Which build is covered (weights, cache type, key) and that a mapper fits only the exact build |
| A part is missing | Which side: no encoder to send from it, or no decoder to hand off to it |
| A part failed or skipped its gate | That part, and the card that tested it |
| A route was measured and failed | The pair, its F1 and the card |
| A route nobody measured | Refused by default. Both parts exist, but the pair was never run |

A model name that is not a plain model id is never echoed back.

## 6. Risks

- **Not a privacy feature.** The runtime tokenizes the document for the receiver, so the text is present at both ends. Published attacks recover prompts from KV caches and from hidden states (section 7). A hub state is a linear image of the cache and should be treated as the text itself. A shared hub adds that any member's decoder can read any member's state.
- **It may not generalise beyond the founding models.** Three or four small models define the space. Step 3 measures the first model added afterwards. A model from a family unlike the founders may still fail, and its routes are then refused by name.
- **One bad encoder poisons every route from its model.** Three guards:
  - each part has its own gate and is not used unless it passed;
  - a hub is frozen once published, so a new part cannot change old routes;
  - a part is withdrawn by one manifest change, and `Library.through` lists the routes that stop.
- **One measured task.** Everything here is SQuAD passages of at most 256 tokens. Stage 2 teaches SQuAD's short answer style.
- **A mapper file steers the receiver.** A file with other weights makes the receiver say other things. The checksum ties the file to the manifest, and the answer is marked unverified.
- **Licences.** Qwen2.5-3B is under the Qwen Research licence (non-commercial). Whether a part trained through it can ship in a public library needs Ruslan's decision before any file is published.
- **Signing.** The manifest is covered by the package it ships in. Signing it with the P4a key would also cover a manifest fetched separately. That touches signing, so it needs Ruslan's yes and is not part of this card.

## 7. Prior work

Every paper below was opened on 2026-11-27 (the arXiv abstract page and the HTML full text). Nothing is cited from memory. One paper on the reading list was not opened and is not cited: "I Know What You Asked" (NDSS 2025).

**No opened paper compares a hub with pairwise-trained mappers on the same pairs of different model families.** That comparison is what steps 1 and 2 of the eval would add.

| Paper | What it says that matters here |
| --- | --- |
| Swarm Telepathy (SwaT), arXiv 2610.15095 | The method M2b reimplements: one mapper per ordered pair, reconstruction then task loss. Its limitations section says n families need n(n − 1) mappers and names a shared latent space with 2n mappers as future work. It reports no hub experiment |
| Dery et al., Latent Space Communication via K-V Cache Alignment, arXiv 2601.06123 | **The closest prior hub.** One adapter into a shared space and one out per frozen model, so parameters grow linearly. A fourth model was added with the others frozen, and paths never trained worked zero-shot at a loss comparable to trained paths. Limits: its models are 100M to 400M Gemma-2 models the authors pretrained themselves, all with one vocabulary, and there is no pairwise baseline. So it shows the frozen-hub growth step can work between seeds of one architecture, not between families |
| Cache-to-Cache (C2C), arXiv 2510.03215 | A fuser trained per pair with both models frozen. It reports 3.1 to 5.4% over text and 2.5× the speed. Its limitations name the per-pair training cost as open. An appendix tries projectors into one shared KV space plus per-model fusers on a 2 × 2 setup, without comparing it to pairwise fusers |
| Vision Wormhole, arXiv 2602.15382 | Hub and spoke with a number of parts linear in N: per-model codecs, and affine maps to one reference model fitted on shared anchor texts. The channel is image tokens of vision-language models, not a KV cache. No comparison with pairwise |
| vec2vec, arXiv 2505.12540 | Per-model adapters around one shared space, trained without paired data, for sentence embeddings. Also a security result: translated embeddings leaked information about most of a set of emails |
| Google's multilingual NMT, arXiv 1611.04558 | The published analogue of routes through a shared space. Portuguese to Spanish BLEU: 31.50 trained directly, 30.91 bridged through English, 21.62 and 24.75 zero-shot, and 31.77 once a little direct data was added. Spanish to Japanese: 18.00 bridged, 9.14 zero-shot. Routes that never trained together lost the most, and a little direct training closed the gap |
| Relative representations, arXiv 2209.15430 | A shared space with no trained map: each sample is described by its similarity to fixed anchors. It assumes spaces differ by rotation, reflection and scale only, and the decoders must be trained on that representation. L4 measured the closed-form route on our models and it failed |
| Model stitching, arXiv 2106.07682 | A small trained layer joins two frozen networks. Networks of one architecture trained differently stitch with almost no loss. It makes no claim across architectures |
| The Platonic Representation Hypothesis, arXiv 2405.07987 | A position paper: representations converge toward a shared model of reality. Its own caveats: not all representations converge and measured alignment is low. It is a reason to hope, not evidence that a hub works |
| KVComm, arXiv 2510.03346, and KVCOMM, arXiv 2510.12872 | Both share or reuse KV caches between copies or fine-tunes of one model. Neither crosses model families |
| Communicating Activations, arXiv 2501.14082; LatentMAS, arXiv 2511.20639; A Universal Context-Reuse Layer, arXiv 2608.30963 | A linear map learned per pair; a training-free method for one backbone; and a pairwise module despite its title. None is a hub |

**Caches and hidden states can be turned back into text:**

| Paper | Result |
| --- | --- |
| Shadow in the Cache, arXiv 2508.09442 | Recovers the prompt from a plaintext KV cache, from any single layer |
| Language Models are Injective and Hence Invertible, arXiv 2510.15511 | Recovers the exact prompt from one layer's hidden states, given the model's weights |
| Text Embeddings Reveal (Almost) As Much As Text, arXiv 2310.06816 | Recovers 92% of 32-token inputs exactly from a single embedding |

**Three citations in this repository's other docs do not say quite what the docs claim.** They are outside this card and are listed as a follow-up:

- arXiv 2603.18908 is "Ventriloquist LLMs: Linear Alignment of Late-Stage Representations". It does find that tokenizer overlap predicts quality. It is not an audit and does not use KV caches, and its size limit is on the source model, not on receivers under 2B.
- arXiv 2608.04893 uses a mismatched-cache control but discusses earlier work that also did, so it did not introduce the control.
- arXiv 2608.13317 (StateBridge) is training-free as cited. It passes hidden states as an input prefix between copies of one model; L4's section already notes that the cross-model version is ours.

## 8. Next cards

| Card | What | GPU |
| --- | --- | --- |
| T1b Chain test | Step 1 of the eval: the runner, then the chain of L5's mappers against direct | About 1.5 h, eval only, after L5 |
| T1c Split hub | Step 2: joint training on three models, then step 3 with Granite | About 8 h and 5.5 h of training, 1.5 h of eval each |
| T1d Library in the runtime | Build keys from the loaded models, the registry on `Library`, safetensors files, the pull command, the receipt fields | None |

T1d does not depend on which hub wins: the manifest describes both kinds.
