# M2c: a latent agent team (subagents think and talk without text)

Leo's direction (2026-11-07):
- Subagents should not translate their thinking into English for each other.
- They work in the model's own representation space, and only one orchestrator turns the final result into text.
- The ledger's MCP makes that available to open-weight models, for example behind Open WebUI.

This is the setting of LatentMAS (Zou et al., ICML 2026, arXiv 2511.20639), reimplemented here from the paper.

## How it works

The team runs on one open model, served by our runtime:

1. **Planner, critic and refiner are subagents.** Each reads its role prompt and the question, then "thinks" for `m` latent steps instead of writing tokens.
   - A latent step takes the last-layer hidden state `h`, maps it into the input-embedding space, and feeds it back as the next input: `e = h W_a`, with `W_a = (W_outᵀ W_out + λI)⁻¹ W_outᵀ W_in`.
   - The output is rescaled to the mean norm of real input embeddings.
2. **Working memory moves between agents as a KV cache.** Everything a subagent read and thought is a list of per-layer keys and values. The next agent starts with that cache prepended to its own, so it attends to the previous agent's thoughts directly. Nothing is decoded, and no text is re-read.
3. **The solver is the orchestrator.** It reads the accumulated working memory plus its prompt, and it is the only agent that writes text: the final answer.

No training is needed: all agents are the same frozen model.

## What is different from the earlier layers

| Layer | Who talks | Medium | Works with closed models |
|---|---|---|---|
| Graphs (M0) | Any agents, any vendor | Typed JSON graph, explicit and auditable | Yes |
| M2a warm pool | Roles inside one read | Shared prefix cache, but roles still write JSON text | Reader only |
| M2b transfer | Two different open models | KV cache through a trained mapper | No |
| **M2c latent team** | **Subagents of one open model** | **Latent thoughts plus KV working memory; text only at the end** | **No** |

## Caveats (and what we do about each)

1. **"The data is already a semantic graph" is half true.**
   - A model's internal state is a sequence of high-dimensional vectors per layer, not a graph of goals and decisions. The latent channel is the model's own language, and the graph is the language people and closed models can read.
   - So we keep both. Latent between open subagents for speed and quality, and the graph as the audit trail and the bridge to Claude, Codex and people.
2. **Closed models cannot join.** Claude, GPT and Gemini do not expose hidden states or caches. They stay on graphs and text, and can call the latent team as a tool.
3. **An MCP server alone cannot do this.** MCP carries tool calls and text. Latent collaboration needs the process that runs the model.
   - So the product is the runtime as the inference layer: an OpenAI-compatible endpoint for Open WebUI and agent frameworks.
   - The MCP is the control surface: `latent_team` as a tool.
4. **Same model only, for now.** Latent thoughts and caches are only meaningful to the model that made them. Across model families this needs a mapper per pair (M2b), and the paper's results are for one model.
5. **No one can read the intermediate thoughts.** That is the point, and also the risk: the critic's feedback cannot be inspected or cited.
   - The orchestrator's final text is the only output, marked unverified like every model answer here.
   - Receipts record what ran: steps per agent, tokens, times.
   - The graph layer is where decisions get confirmed by people.
6. **Latent steps can drift.** Too many steps feed the model inputs unlike any real token. `m` is a parameter, and the eval measures it.
7. **Tool use still needs text.** An agent that must call a tool has to emit the call as text. Latent agents here only reason.
8. **Small models may not benefit.** The paper reports Qwen3 4–14B and Llama 3–8B. We test Qwen2.5-3B on a 16 GB laptop GPU, so the result is a finding either way.

## Evals (written before the code)

**Task.** GSM8K test, 200 fixed questions (seed 0). Greedy decoding. Correct when the last number in the answer equals the gold number.

**Systems, all on the same model:**

| System | What runs |
|---|---|
| `single` | The solver alone, reasoning in text |
| `text_mas` | Planner, critic and refiner write text (up to 256 tokens each); each next agent's prompt includes the earlier texts; the solver answers |
| `latent_mas` | Planner, critic and refiner each take `m` latent steps (m = 40); KV working memory passes forward; the solver answers |

**Control.** `latent_random` runs the same pipeline, but each latent step feeds a random vector at the same norm instead of the aligned hidden state. If `latent_mas` does not beat it, the gain comes from the extra prompts and memory, not from latent thinking. The `m = 0` point of the step sweep separates "memory of the prompts" from "thinking".

**Metrics.**
- Accuracy, with a paired 95% bootstrap interval of `latent_mas` minus `text_mas` over the same questions. At n = 200 one standard error is about 3 points, so the 2-point gate is read together with the interval.
- Generated text tokens, plus `meanLatentVectors` and `meanForwardSteps`, so the token saving is read next to the forward passes latent thinking still costs.
- Wall time per question, which is batch time divided by batch size. A batch is as slow as its longest row, and this weighs most on `text_mas` with its four generating agents.
- The share of text subagents that hit their 256-token cap. A high share would mean truncated plans handicap `text_mas`.

**Notes.**
- Qwen2.5-3B ties its input and output embeddings, so `W_a` is close to the identity and alignment is mostly the norm rescaling. The ridge solve matters for untied models (Qwen3, Llama 3.1 8B); a result here is not evidence for it.
- Decoding is greedy, where the paper samples at 0.6: one deterministic path per question, the same for every system.

**Gate.**
- `latent_mas` accuracy ≥ `text_mas` accuracy − 2 points.
- At least 50% fewer generated tokens than `text_mas`.
- Faster than `text_mas` in wall time.
- The paper reports accuracy within ±2 points, 60–80% fewer tokens and a 2–6× speedup.

**Checks before measuring:**
- **Alignment matrix.**
  - `W_a` maps real output embeddings close to the matching input embeddings.
  - The rescaled norm equals the mean input-embedding norm.
- **Working memory equals the text cache.** With zero latent steps, passing agent A's KV cache to agent B gives exactly the logits of B reading A's prompt as text.
- **Batching.** A batched latent run gives the same answers as running each question alone.

## Live findings before measuring (Qwen2.5-3B, 6 GSM8K questions)

1. **An open assistant turn broke the working memory.**
   - Each agent's prompt ended in `<|im_start|>assistant\n`, and the next agent's prompt, system block included, followed straight after it.
   - The accumulated memory read as a conversation in which the assistant answers with a system prompt. The solver copied that and wrote `<tool_call>system\nYou are Qwen…`: 0/6 correct, even with zero latent steps.
   - Fix: each subagent's turn is closed with `<|im_end|>` after its latent steps, and only the first agent carries the system block. That gives 4/6 at m = 0.
2. **The paper's alignment collapses on a tied-embedding model.**
   - Qwen2.5-3B shares its input and output embedding matrix, so `W_a` is the identity: a latent step feeds back the last hidden state, rescaled.
   - That vector has a high dot product with the next token's embedding but is not close to any embedding. Within a step or two the thoughts go off distribution.
   - Decoded to nearest tokens, the planner's thoughts read "To tockeruser UserController thiết thiết…", then blank space. The team scores 0/6 at m = 10 and m = 40.
3. **Soft thoughts stay in distribution.**
   - Our deviation from the paper: each latent step feeds the probability-weighted mean of the top-16 token embeddings at temperature 1. This is in the spirit of training-free "soft thinking".
   - The vector is a continuous mixture of real token embeddings, never a chosen token.
   - Result: 6/6 at m = 40 (5/6 at m = 10 with top-8 at temperature 0.5). The planner's thoughts decode to a coherent plan: "To solve this problem, you can follow these steps: 1. **Calculate the total miles run by Amber and Micah:**…"
   - `latent_mas` now uses soft thoughts. The paper's version stays measurable as `latent_aligned`, and random vectors as `latent_random`.

## Measurement status (2026-11-07, stopped by Leo)

These are GSM8K test results, seed 0, with Qwen2.5-3B-Instruct, greedy decoding and batches of 32. The run was stopped on Leo's request before the latent systems ran.

| System | Questions | Accuracy | Text tokens per question | Seconds per question |
|---|---|---|---|---|
| `single` | 200 | 0.820, reproduced in two runs | 291 | 1.30 |
| `text_mas` | 200, earlier run | 0.780 | 894 | 3.56 |
| `text_mas` | 96 of 200, rerun, incomplete | 0.740 | n/a | n/a |
| `latent_mas` (soft), `latent_aligned`, `latent_random` | none | not measured | n/a | n/a |

- In the complete earlier run, 70.5% of `text_mas` subagents hit their 256-token cap. Truncated plans handicap the text team, which scores below the solver alone.
- The gate is not decided. The 6-question live check (soft thoughts 6/6 at m = 40, paper thoughts 0/6) is a debug signal, not a measurement.
- To resume, run `latent_team.evaluate --systems single,text_mas,latent_mas,latent_aligned,latent_random --steps 40 --count 200 --batch 32`, then the step sweep. On one RTX 4090 Laptop GPU this takes about 40 minutes.

## Result: the full measurement (2026-11-09, cycle 9)

The resumed run, as the section above says, then a sweep of `latent_mas` and `latent_random` at m = 0, 10, 20 and 80. Same model, seed, 200 GSM8K test questions, greedy decoding and batches of 32. The first pass took 36 minutes and the sweep 49 minutes.

| System | Accuracy | Text tokens per question | Forward steps | Seconds per question |
|---|---|---|---|---|
| `single` | 0.820 | 291 | 291 | 1.26 |
| `text_mas` | 0.780, 70.5% of agents capped | 894 | 894 | 3.56 |
| `latent_mas` m = 40 | **0.835** | **251** | 371 | **1.92** |
| `latent_aligned` m = 40 | 0.000 | 441 | 561 | 2.06 |
| `latent_random` m = 40 | 0.505 | 235 | 355 | 2.02 |

**Gate: passed.** `latent_mas` minus `text_mas` is +0.055, with a paired 95% interval of +0.005 to +0.105. It uses 72% fewer generated tokens and is 1.85× faster. `single` and `text_mas` reproduce the numbers above exactly.

Paired 95% intervals for `latent_mas` at m = 40:
- Against `single`: −0.03 to +0.06. **The latent team is not better than the solver alone**, and it is slower (1.92 s against 1.26 s). It beats the text team, which is held back by its truncated plans.
- Against `latent_random`: +0.26 to +0.41. The gain needs the real hidden states, not just the extra prompts and memory.
- Against `latent_aligned`: +0.78 to +0.885. The paper's alignment collapses on this tied-embedding model, as the live check found (0/6 there, 0/200 here).

**Step sweep:**

| m | `latent_mas` | `latent_random` |
|---|---|---|
| 0 | 0.775 | 0.775 (the same run: no vectors) |
| 10 | 0.770 | 0.635 |
| 20 | 0.785 | 0.610 |
| 40 | 0.835 | 0.505 |
| 80 | 0.795 | 0.235 |

- m = 0 is the working memory without thinking. At m = 40, latent thinking adds +0.06 over it, with an interval of +0.01 to +0.115.
- m = 40 also beats m = 20 (+0.005 to +0.10) and m = 80 (0 to +0.08).
- The curve peaks rather than rising, so treat the m = 40 result as one good setting, not a trend. m = 40 was the preset before measuring, not picked after. Only m = 40 clears `text_mas` with an interval above zero.
- Random vectors hurt more the more steps they get, while real thoughts never fall below memory-only.
- Next checks: a second seed at m = 30, 40 and 50, and an untied model (Qwen3 or Llama 3.1 8B), where the paper's alignment is expected to matter.

### Second seed (2026-11-10)

The same settings with `--seed 1`, which is another 200 GSM8K test questions.

| System | Accuracy | Text tokens | Seconds per question |
|---|---|---|---|
| `single` | 0.840 | 282 | 1.38 |
| `text_mas` | 0.805, 66.2% of agents capped | 883 | 3.40 |
| `latent_mas` m = 30 | 0.860 | 251 | 1.92 |
| `latent_mas` m = 40 | 0.825 | 247 | 2.01 |
| `latent_mas` m = 50 | 0.850 | 242 | 2.01 |
| `latent_random` m = 40 | 0.535 | 238 | 2.09 |

- **The gate passes again** at m = 40: within 2 points of `text_mas` (+0.02, interval −0.035 to +0.075), 72% fewer tokens, 1.7× faster. On this seed the gain over `text_mas` is not significant.
- **Not better than `single` on either seed:** −0.07 to +0.04 here.
- **The control holds:** +0.215 to +0.36 over random vectors.
- **The m = 40 peak of seed 0 does not reproduce.** m = 30, 40 and 50 are within noise of each other: m = 40 minus m = 30 is −0.075 to +0.005, and minus m = 50 is −0.065 to +0.015. Read the step curve as a plateau from about 30 to 50 steps, with no sharp optimum.
- **Conclusion for M2c on Qwen2.5-3B.** Latent thinking keeps text-team accuracy at a quarter of the tokens and about half the time. It needs real hidden states, but it does not beat one model solving alone. The untied-model check is still open.

### A disjoint second sample (2026-11-12)

The seed-1 sample shared 30 of its 200 questions with seed 0, so it was not an independent replication (PR #7 review). `--block` fixes that: `--seed 0 --block 1` takes questions 200 to 399 of the seed-0 shuffle, which share none with seed 0's questions 0 to 199. That was checked on the saved question text: 0 shared, against 30 for seed 1. The run used the seed-1 systems and steps, with the same model, greedy decoding and batches of 32. It took about 50 minutes on the same GPU.

| System | Accuracy | Text tokens | Seconds per question |
|---|---|---|---|
| `single` | 0.850 | 285 | 1.17 |
| `text_mas` | 0.830, 66.7% of agents capped | 880 | 3.19 |
| `latent_mas` m = 30 | 0.825 | 248 | 1.63 |
| `latent_mas` m = 40 | 0.855 | 246 | 1.78 |
| `latent_mas` m = 50 | 0.875 | 248 | 1.86 |
| `latent_random` m = 40 | 0.475 | 239 | 1.84 |

- **The gate passes** at m = 40.
  - It is no more than 2 points below `text_mas`, the gate's criterion; in fact it is 2.5 points above (interval −0.03 to +0.08). It uses 72% fewer tokens and is 1.8× faster.
  - As on seed 1, the gain over `text_mas` is not significant.
- **Not better than `single`:** −0.045 to +0.055.
- **The control holds:** +0.31 to +0.45 over random vectors.
- **No stable optimum.** m = 40 minus m = 30 is −0.015 to +0.075, and m = 40 minus m = 50 is −0.06 to +0.02, so m = 40 is within noise of both. m = 50 does beat m = 30 here (+0.05, interval +0.01 to +0.09), and it is the best value on this sample (0.875; −0.005 to +0.10 over `text_mas`). On seed 1 the order was the reverse, with m = 30 best. Read 30 to 50 steps as a range where the best value moves between samples, not as a flat plateau.
- **The conclusion above holds on an independent sample:**
  - Latent thinking matches the text team at about a quarter of its tokens and half its time.
  - It needs real hidden states.
  - It does not beat one model solving alone.

## Serving

- **Runtime.** `POST /latent/team` with `{question, latentSteps?}` returns the solver's answer and a receipt.
- **OpenAI-compatible endpoint for Open WebUI.** `POST /v1/chat/completions` with model `ctm-latent-team`, plus `GET /v1/models`. Open WebUI adds it as an OpenAI connection with no plugin.
  - Like vLLM and Ollama, the endpoint ignores unknown fields and sampling knobs. It refuses only tool calling, non-text `response_format` and `n > 1`.
  - System and developer messages, where Open WebUI puts its RAG and file context, become the team's instructions. Earlier turns become context.
  - An oversized conversation keeps its head and its tail.
  - Streaming sends the reply as one chunk, then the finish reason, then usage only when `stream_options.include_usage` is set.
  - Set a separate task model in Open WebUI for titles, tags and follow-ups. Otherwise each of those runs a full team pass and holds the one GPU slot.
  - There is no authentication. The server listens on 127.0.0.1, and `LATENT_ALLOWED_HOSTS=host.docker.internal:4320` opts in Open WebUI running in Docker Desktop. On Linux Docker, `host.docker.internal` is the bridge gateway, so run Open WebUI with host networking instead.
  - A caller that leaves while waiting for the slot gets no GPU work.
- **Ledger.** The `latent_team` MCP tool forwards a question. The answer comes back on one line, marked unverified.
