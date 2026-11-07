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

**Metrics.** Accuracy, total generated tokens (latent steps count as zero tokens; they are reported separately), and wall time per question.

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

## Serving

- **Runtime.** `POST /latent/team` with `{question, latentSteps?}` returns the solver's answer and a receipt.
- **OpenAI-compatible endpoint for Open WebUI.** `POST /v1/chat/completions` with model `ctm-latent-team`, plus `GET /v1/models`. Open WebUI adds it as an OpenAI connection with no plugin.
- **Ledger.** The `latent_team` MCP tool forwards a question. The answer comes back on one line, marked unverified.
