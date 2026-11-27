# Watchdogs for latent agent teams: research report

*Generated 2026-11-21. About 95 sources opened; confidence medium (see "Method and verification"). This report feeds [the watchdog design](watchdog-security.md).*

## Summary

- Agents that talk through hidden states and KV caches are about one year old as a research field, and papers on attacking and auditing them only started in 2026. Nobody has published a runtime monitor tested on a training-free KV hand-off like ours against wrong answers. What we measure will be new evidence, not a replication.
- The strongest results are about **integrity**. Size and norm checks on a hand-off are easy to evade; cryptographic authentication of the hand-off was not evaded.
- **Hallucination cannot be eliminated**, and this is proven for a formal setting. The strongest claim with evidence is a bounded error rate with abstention, on task types that have a labelled calibration set.
- **Activation monitors (probes) are cheap and real, and they can be fooled.** They work in the distribution they were trained on and fall to chance on unseen task types. A white-box attacker beats every single probe tested.
- **A KV cache is the plaintext.** Prompts have been recovered from caches and hidden states. Detection of personal data by scanners is far too weak to rely on.
- **Guarantees come from outside the model**: permissions fixed before data is read, labels by origin, deterministic gates. Everything inside the model is detection with an error rate.
- No study supports any particular ratio of watchdogs to agents.

## 1. Latent communication between agents

The methods, all recent:

- [LatentMAS](https://arxiv.org/abs/2511.20639) (Zou et al.), the paper M2c reimplements: latent thoughts plus KV working memory. It reports accuracy peaking at 40 to 80 latent steps and then flat or falling. Its "debug mode" is a separate text generation, not a decoding of the latent thoughts.
- [Coconut](https://arxiv.org/abs/2412.06769) (Hao et al.): the trained hidden-state feedback loop this line of work started from.
- [Communicating activations](https://arxiv.org/abs/2501.14082) (Ramesh and Li), [Cache-to-Cache](https://arxiv.org/abs/2510.03215) (Fu et al.), [KVComm](https://arxiv.org/abs/2510.03346) (Shi et al.), [Interlat](https://arxiv.org/abs/2511.09149) (Du et al.): variants that pass activations or caches between models.
- [Soft Thinking](https://arxiv.org/abs/2505.15778) (Zhang et al.): feeding a probability-weighted mix of token embeddings, the idea behind our soft thoughts.
- [Hybrid Reasoning Agents](https://arxiv.org/abs/2610.18861) (Zou et al., 2026): alternates text and latent spans, the closest published design to "text checkpoints".

What giving up text costs:

- [Chain of Thought Monitorability](https://arxiv.org/abs/2507.11473) (Korbak et al., 2025) is a position paper signed across the large labs. It says readable reasoning is the most practical way to monitor a model today, and that latent-reasoning designs would lose it. Our design is the case it warns about, so the watchdog replaces a safeguard we removed; it is not an extra.
- [SHADE-Arena](https://arxiv.org/abs/2506.15740) (Kutasov et al., 2025): a hidden scratchpad strongly helps an agent complete a hidden side task without being caught.

Does the hand-off even matter?

- [A causal audit of relayed KV caches](https://arxiv.org/abs/2608.04893) (Cheng et al., 2026) swaps the relayed cache for a mismatched, zeroed or random one. When the receiver needs information only the sender has, the relay is decisive. On GSM8K, ARC and MedQA, where the receiver can read the question itself, the result with and without the right cache is equivalent within 2.8 points. This matches our own M2c result: the latent team is not better than the solver alone.

## 2. Tampering with the hand-off

- [Out of Sight, Not Out of Mind](https://arxiv.org/abs/2605.28214) (Wang et al., EMNLP 2026) attacks LatentMAS directly. Interventions on the KV hand-off between agents degrade clean runs much more than interventions on local hidden states. In its tables the value tensors carry most of the effect, not the keys. A detector on norm profiles catches 85% to 94% of its attacks at about 4% false alarms.
- [When Latent Agents Lie](https://arxiv.org/abs/2606.28958) (Brito and Baquero, 2026) tests defences. A magnitude check rejected all 65 of 65 random and scaled corruptions and **none of 65** norm-matched ones. A learned sanitizer failed to beat random dropping once the attacker knew about it. A signed manifest (HMAC) accepted 774 of 774 honest hand-offs and rejected 295 of 295 tampered ones. The signature does not help when the sender itself is malicious.
- [Soft prompt threats](https://arxiv.org/abs/2402.09063) (Schwinn et al., 2024): attacks in embedding space reach 100% success per prompt on the open models tested. A channel that carries vectors bypasses safety training that was done on tokens.
- [Safety of latent communication](https://arxiv.org/abs/2609.39788) (Huzaifa et al., 2026) and [safety-aware latent reasoning](https://neurips.cc/virtual/2026/poster/148785) (Wang et al., NeurIPS 2026): trained latent links and trained latent reasoners comply with harmful requests more often than the same model in text. Both study trained systems; a training-free hand-off like ours is untested.

What this means: norm and size checks catch accidents, not attackers. Integrity needs authentication and recomputation.

## 3. Reading latent thoughts

- [Are latent reasoning models easily interpretable?](https://arxiv.org/abs/2604.04902) (Dilgren and Wiegreffe, COLM 2026): projecting latent thoughts onto the vocabulary recovers the correct reasoning trace for 65% to 93% of correct predictions, and for only a minority of incorrect ones. Having no decodable trace is itself a risk signal. The models are small and trained (GPT-2 Small, Llama-3.2-1B).
- [Ulterior Motives](https://arxiv.org/abs/2604.23460) (Ramjee, 2026): a linear probe finds a planted backdoor state well on the first latent step and close to chance by the sixth. Probe per position; do not average.
- [CoT monitorability out of sight](https://arxiv.org/abs/2608.04928) (Ferreira et al., 2026): probes on latent states beat text decoders, and both depend heavily on the task.
- Decoders that describe an activation in words ([Patchscopes](https://arxiv.org/abs/2401.06102), [SelfIE](https://arxiv.org/abs/2403.10949), [LatentQA](https://arxiv.org/abs/2412.08686), [Activation Oracles](https://arxiv.org/abs/2512.15674), Anthropic's [natural language autoencoders](https://transformer-circuits.pub/2026/nla/index.html)) are useful for investigation and not as evidence. [Li et al. (ICML 2026)](https://arxiv.org/abs/2509.13316) show their output often reflects what the describing model already knows, not what the activation holds. The activation-oracle authors and [a follow-up](https://arxiv.org/abs/2606.02609) report wrong guesses and no calibrated uncertainty.
- The [tuned lens](https://arxiv.org/abs/2303.08112) (Belrose et al.) is a cheap per-layer readout; it has to be trained on the states it reads.

What this means for us: our soft thoughts are built as a weighted mix of 16 known tokens. The list of tokens and weights is an exact record of what was fed in, with no describing model that could make things up. That is stronger than anything in this section, and it disappears if a trained adapter changes the thought.

## 4. Hallucination

**Detection from inside the model**

- Probes on hidden states: [SAPLMA](https://arxiv.org/abs/2304.13734) (71% to 83% accuracy), [INSIDE](https://arxiv.org/abs/2402.03744) (AUROC 76.5 to 83.8, needs 10 samples), [semantic entropy probes](https://arxiv.org/abs/2406.15927) (one pass, weaker than sampling), [HaloScope](https://arxiv.org/abs/2409.17504), [Orgad et al.](https://arxiv.org/abs/2410.02707) (AUC 0.83 to 0.95 depending on task; the signal sits on the answer token), [Marks and Tegmark](https://arxiv.org/abs/2310.06824) (a linear truth direction, weaker on small models).
- Attention patterns: [Lookback Lens](https://arxiv.org/abs/2407.07071) (AUROC about 0.9 in domain with labelled spans, 0.66 with sliding windows) and [ReDeEP](https://arxiv.org/abs/2410.11414).
- Sampling: [semantic entropy](https://www.nature.com/articles/s41586-024-07421-0) (Farquhar et al., Nature 2024; AUROC 0.790 averaged over 30 settings, about 10 times the generation cost) and [SelfCheckGPT](https://arxiv.org/abs/2303.08896).

**Why these cannot be relied on alone**

- [Dubanowska et al. (EMNLP 2025 Findings)](https://arxiv.org/abs/2509.19372): trained on one dataset and tested on another, every detector tried scored close to chance (0.51 to 0.55 AUC).
- [PARALLAX](https://arxiv.org/abs/2605.17028) (2026 preprint): popular benchmarks leak the answer; under controls, label-free methods fall to 0.43 to 0.62 and only supervised probes survive, with large differences between datasets.
- [Levinstein and Herrmann](https://arxiv.org/abs/2307.00175): a probe at 0.83 falls to 0.41 on negated statements.
- [Hallucination is inevitable](https://arxiv.org/abs/2401.11817) (Xu et al.) and [Karbasi et al.](https://arxiv.org/abs/2504.17004): no computable model avoids all errors, and a detector cannot be learned from correct examples alone. It needs labelled errors.
- No paper found tests any of these detectors on latent-step or KV hand-off states.

**What can be guaranteed**

- [Conformal factuality](https://arxiv.org/abs/2402.10978) (Mohri and Hashimoto) and [conformal abstention](https://arxiv.org/abs/2405.01563) (Yadkori et al.): with a labelled calibration set, the error rate of what is released can be held under a chosen level by removing claims or abstaining. The guarantee is on average, and it holds only while live traffic looks like the calibration set.

**Checking the output**

- [MiniCheck](https://arxiv.org/abs/2404.10774): a 770M-parameter checker matches GPT-4 at judging whether a claim is supported by a document, at about 75% balanced accuracy. One judgement in four is wrong.

**Between agents**

- [The Hallucination Snowball](https://arxiv.org/abs/2608.14588) (Singh and Pawar, ICML 2026 workshop): in a four-agent text pipeline, a check at every hand-off cut the survival of injected errors from 58.4% to 16.2%. A check only at the end helped by 2.3 points.
- [Towards a science of scaling agent systems](https://arxiv.org/abs/2512.08296) (Kim et al.): errors amplify least with a central verifier, though the effect is not significant after controls, and per-agent reasoning gets thin beyond 3 to 4 agents.

## 5. Activation monitors

- They are cheap and competitive: [Google DeepMind's production probes](https://arxiv.org/abs/2601.11516) reach error rates near an LLM classifier at over 10,000 times lower cost, and [Anthropic's representation re-use](https://alignment.anthropic.com/2025/cheap-monitors/) finds the same pattern. Both recommend a cascade: the probe first, an expensive checker only on what it flags. [Hua et al.](https://arxiv.org/abs/2507.15886) show two combined monitors beat either alone.
- They fail quietly under shift: in the same DeepMind paper a mean-pooled probe misses 99% of long-context attacks. In [Goldowsky-Dill et al.](https://arxiv.org/abs/2502.03407), moving the probe two layers takes recall from over 95% to near zero.
- They can be evaded: [Bailey et al.](https://arxiv.org/abs/2412.09565) drive probe recall from 100% to 0% with embedding-space inputs while the attack still works; [RL-Obfuscation](https://arxiv.org/abs/2506.14261) and [Neural Chameleons](https://arxiv.org/abs/2512.11949) show models trained to evade one probe evade others.
- Distance-based anomaly detection ([Lee et al.](https://arxiv.org/abs/1807.03888), [Ren et al.](https://arxiv.org/abs/2209.15558)) is a strong unsupervised baseline for far-off states and blind to states that look normal. [Johnston et al.](https://arxiv.org/abs/2504.08812) find no anomaly detector that works across all models and tasks.
- Sparse autoencoders are worse than plain probes for detection ([Smith et al., DeepMind](https://www.alignmentforum.org/posts/4uXCAJNuPKtKBsi28/negative-results-for-saes-on-downstream-tasks); [Kantamneni et al.](https://arxiv.org/abs/2502.16681)).
- For latent agent teams specifically, [Beyond the Transcript](https://arxiv.org/abs/2608.19161) (Kaur et al., 2026) reports a latent-state monitor at AUROC 0.993 when all agents are the same model and 0.854 for mixed pairs, on one benchmark.

## 6. Oversight structure

- How multi-agent systems fail: [MAST](https://arxiv.org/abs/2503.13657) (Cemri et al.) labels 1,600 traces. The most common failures are repeating steps (15.7%), actions that do not match the reasoning (13.2%), not knowing when to stop (12.4%) and ignoring the task specification (11.8%). A verifier helps and is not enough.
- Shape: in [Huang et al.](https://arxiv.org/abs/2408.00989) a hierarchy lost the least when one agent was faulty. Finding which agent caused a failure is hard: the best method names the right agent 53.5% of the time and the right step 14.2% ([Zhang et al.](https://arxiv.org/abs/2505.00212)).
- Control protocols: [Greenblatt et al.](https://arxiv.org/abs/2312.06942) measure trusted monitoring, deferring to a weaker trusted model, and monitoring by a copy of the same model, which can collude. [Ctrl-Z](https://arxiv.org/abs/2504.10374) shows re-running a suspicious step cuts attack success from 58% to 7%.
- LLM monitors are a weak point: [Terekhov et al. (ICLR 2026)](https://arxiv.org/abs/2510.09462) make a GPT-4.1 monitor rate all 375 backdoored samples as safe by injecting text the monitor reads, and re-running made things worse. [Nasr et al.](https://arxiv.org/abs/2510.09023) bypass 12 published defences with adaptive attacks. Even without attacks, the best monitor in SHADE-Arena reaches AUC 0.87.
- Errors correlate: models agree about 60% of the time when both are wrong ([Kim et al., ICML 2025](https://arxiv.org/abs/2506.07962)). A second opinion from the same model is not independent.
- Across agents: [Makins et al. (2026)](https://arxiv.org/abs/2607.07368) show that an attack spread over several agents is less likely to be caught by monitors that each watch one agent. The supervisor has to add evidence up across squads.
- Infection: [Agent Smith](https://arxiv.org/abs/2402.08567) and [Prompt Infection](https://arxiv.org/abs/2410.07283) show one poisoned input spreading through a team. Marking where content came from did more than asking the model to resist.
- Rules outside the model: [AgentSpec](https://arxiv.org/abs/2503.18666) enforces written rules in milliseconds; rules only cover what someone wrote down.
- **Ratio:** no empirical result was found for the best number of monitors per agent or for hierarchical monitors under attack. Only theory and position papers exist.

## 7. Sensitive data

- Caches and hidden states can be turned back into the prompt: [Shadow in the Cache](https://arxiv.org/abs/2508.09442) (Luo et al., NDSS 2026) recovers input from the KV cache, near perfectly when the attacker has prior knowledge and at 0.65 to 0.87 similarity without it. [Nikolaou et al.](https://arxiv.org/abs/2510.15511) prove exact recovery of input from hidden activations is possible. [Dong et al. (USENIX Security 2025)](https://arxiv.org/abs/2507.16372) invert a 4,112-token prompt from a middle layer. [Morris et al.](https://arxiv.org/abs/2311.13647) recover prompts from next-token probabilities alone.
- Sharing a prefix cache between tenants leaks prompts through timing ([Wu et al., NDSS 2025](https://www.ndss-symposium.org/ndss-paper/i-know-what-you-asked-prompt-leakage-via-kv-cache-sharing-in-multi-tenant-llm-serving/)).
- For our exact design, [LCGuard](https://arxiv.org/abs/2605.22786) (Asif et al., 2026) reconstructs private inputs from plain LatentMAS caches with success 0.871, reduced to 0.216 by a trained defence that takes tens of hours on H100 GPUs per configuration and has no formal guarantee.
- Internal channels leak more than outputs: in [AgentLeak](https://arxiv.org/abs/2602.11510) (2026) messages between agents leak in 68.8% of cases against 27.2% for final outputs, and checking only the output misses 41.7% of violations.
- Instructions are not a control: [PrivacyLens](https://arxiv.org/abs/2409.00138) finds strong models leak in 26% to 39% of cases even when told to protect privacy. [AirGapAgent](https://arxiv.org/abs/2405.05175) shows one hostile message drops protection from 94% to 45%, and that giving the model only the data the task needs restores it to 97%.
- Scanners are weak: [PIIBench](https://arxiv.org/abs/2604.15776) (2026) reports every tested system below 0.14 F1 on spans; secret scanners reach 52% to 88% recall ([Basak et al.](https://arxiv.org/abs/2307.00714)).
- Placeholders work when the task does not need the value, and cost quality when it does ([PAPILLON](https://arxiv.org/abs/2410.17127)).

## 8. Unnecessary and unsafe actions

- Designs with guarantees keep untrusted data away from the part that decides what to do: [CaMeL](https://arxiv.org/abs/2503.18813) (77% of tasks solved with provable security against 84% undefended) and [FIDES](https://arxiv.org/abs/2505.23643) (all in-scope injections stopped, with utility losses up to 24.5%). Both assume a planner that never reads untrusted text. A shared KV cache removes that assumption: every later agent attends to everything.
- What still works with a shared cache: fixing the plan and the allowed tools before any untrusted data is read ([design patterns](https://arxiv.org/abs/2506.08837), Beurer-Kellner et al.), a deterministic gate on each tool call ([Progent](https://arxiv.org/abs/2504.11703): attack success 39.9% to 1.0%), and Meta's ["rule of two"](https://ai.meta.com/blog/practical-ai-agent-security/): a session holds at most two of untrusted input, private data and outside actions.
- Model-based judges of "is this action on task" ([Task Shield](https://arxiv.org/abs/2412.16682), [MELON](https://arxiv.org/abs/2502.05174), [LlamaFirewall](https://arxiv.org/abs/2505.03574)) cut attacks sharply on benchmarks, raise false alarms, and are detectors that adaptive attacks get past.
- OWASP's 2025 list names [excessive agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/): too many functions, too many permissions, too much autonomy. Its fix is the same: mediate every action in code outside the model.

## 9. Standards that ask for this

- NIST AI 600-1 (generative AI profile): plans for monitoring after deployment, and incidents tracked.
- [NIST AI 100-2 E2025](https://csrc.nist.gov/pubs/ai/100/2/e2025/final): taxonomy of attacks on agents, with a note that mitigations have theoretical limits.
- EU AI Act: Article 12 (automatic logs over the system's life) and Article 14 (a person can monitor, intervene and halt).
- MITRE ATLAS: mitigations "AI telemetry logging" and "restrict tool invocation on untrusted data".

## Gaps: what nobody has published

1. A runtime monitor tested on training-free KV hand-offs against wrong answers, not only against tampering.
2. Hallucination or error spread through a latent channel.
3. Probes for hallucination trained on latent-step states.
4. A faithful decoding of a KV cache into text.
5. A formal confidentiality or integrity guarantee for agents that share a cache.
6. An independent replication of LatentMAS's headline gains. The two nearest studies are both cautionary, and so are our own cycles 9, 13 and 14.
7. Any evidence for a ratio of monitors to agents.

## Method and verification

- Five research passes ran in parallel on 2026-11-21, one per theme (latent communication, hallucination, activation monitoring, oversight, data and privileges). Each was told to open every source at its primary page and to cite nothing from memory.
- A sixth pass re-checked 23 specific claims in 12 of the 2026 papers against their full text: 20 were confirmed, several with a narrower scope than first reported, and 3 were corrected. The corrections are applied above (the LCGuard training cost, the scope of the cache-inversion result, and which attack numbers the EMNLP paper's tables support).
- The 12 re-checked papers: 2606.28958, 2605.28214, 2605.22786, 2608.04893, 2604.04902, 2608.14588, 2509.19372, 2508.09442, 2510.09462, 2601.11516, 2608.19161, 2607.07368.
- Everything else was opened by one research pass only. Numbers from those are as that pass reported them; check a number at its source before it goes into a pitch or a paper.
- Not opened at the primary source: Anthropic's "Scaling Monosemanticity" (page too large), Microsoft Presidio's evaluation page, the full OWASP agentic top 10 document.
- All of these passes are model work. They reduce the chance of an invented citation; they do not remove it.
