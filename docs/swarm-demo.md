# Swarm demo: many agents on one GPU

The page at `/swarm/` runs up to 200 agents at once on local open models, shows each one working, checks every agent's quote against its source, and combines the answers. It is for showing what many small agents on one laptop GPU can do. The data is synthetic: incident reports generated from a fixed seed (`src/swarm-task.mjs`).

## What the audience sees

- **The grid:** one tile per agent. Grey is waiting, yellow is working, coloured by model when done. Orange means the agent's quote was not found in its report, so its answer is left out.
- **The numbers:** wall time from start to the last answer, and the sum of every agent's own time ("one after another"), so the speed-up is the sum divided by the wall time. It is not a measured single-agent run. Tokens per second, and from the model server its KV-cache use and prefix-cache hit rate (the shared instructions every agent reuses).
- **The answer:** which services went down because of a configuration change and their total downtime, from verified answers only, beside the truth from the generator.
- **One agent:** click a tile to see its report with the quote marked, its answer, and whether the facts match the truth.

## Run it live (WSL, vLLM 0.33)

Start one model server. The settings follow `docs/latent-gpu-plan.md` (branch `claude/m2b-scale`): prefix caching is on in the script, a short context leaves room for many agents, and the number of sequences at once is capped:

```sh
VLLM_MAX_MODEL_LEN=4096 bash runtime/serve-vllm.sh --max-num-seqs 64
```

Then start the ledger with the server's address and open `/swarm/`:

```sh
SWARM_URLS=http://127.0.0.1:8000/v1 SWARM_CONCURRENCY=64 npm start
```

**Two models** (tiles coloured by model, agents assigned in turn): run a second server on another port with its own share of the GPU, for example the 7B at `VLLM_GPU_UTIL=0.55` on port 8000 and `LATENT_MODEL=Qwen/Qwen2.5-1.5B-Instruct VLLM_GPU_UTIL=0.3 VLLM_PORT=8001` on port 8001, and set `SWARM_URLS=http://127.0.0.1:8000/v1,http://127.0.0.1:8001/v1`.

`SWARM_URLS` accepts only `http://127.0.0.1` and `http://localhost`; anything else stops the ledger at start. The page and its requests cannot choose a URL or a model.

## Without a GPU

When no model server is configured or it does not answer, the page offers only the simulation. Its timings and its few wrong answers are seeded and made up, and the page says **Simulated** in the header and on every timing. Use it to rehearse the flow, never as a result.

## Not yet

- Latent hand-offs between agents. They join as a lane once the M2b-S transfer passes (`docs/evals.md`, M2b-S).
- A measured live run on the laptop GPU: the GPU was training the M2b-S mapper when this page was built.
