# Watchdogs compared with two reels: reading neurons, and the harness around the model

*2026-11-27. Written for Ruslan, who sent two Instagram reels and asked whether either approach would serve context-ledger better than the latent team's watchdogs. Docs only: no code, card or threshold changes. Our side is [the watchdog design](watchdog-security.md), [the research report](watchdog-research.md), [M2c](m2c-latent-team.md) and the W1 to W3 results on their PR branches.*

## Summary

- **Reel 1 explains an interpretability essay.** It is by Max Munro (@maxbmunro), runs 135 seconds, and was posted in mid-October 2026. It narrates Nick Cammarata's essay ["Neural Networks Are Already Clean"](https://already-clean.goodfire.com/) (Goodfire, 2026-10-15).
  - The essay's working hypothesis is that a model's own neurons and circuits are mostly legible, with most neurons having one main job. If so, a model can be studied directly, by reading them.
  - It is research on understanding models. It offers no monitor, no gate, no measured error rates and no test against an attacker.
  - The reel overstates it ("canceling the apocalypse", "now we can read 90%").
- **Reel 2 explains Hugging Face's guide to the agent harness.** It is by Qendresa Hoti (@qendresahhoti), runs 96 seconds, and was posted on 2026-10-12. It narrates [The ultimate guide to multi-harness RL](https://huggingface.co/spaces/FineEnvs/multi-harness-rl) (Hugging Face, 2026-09-24).
  - The harness is the program around a model: its loop, tools, context and stopping rule. In the guide, the same 2.6-billion-parameter model solved 62% of test tasks in one harness and 33% in another.
  - The guide then trains the model with reinforcement learning inside several real harnesses, to improve it in all of them. Its aim is capability, not safety.
  - The reel quotes its numbers correctly, generalizes them loosely, and doubles as a funnel for the presenter's own repository.
- **The two reels describe different approaches, and neither is a safety mechanism.** Reel 1 looks inside the model. Reel 2 changes what surrounds the model, then trains the model to fit. Our watchdogs sit where reel 2 looks, in code around the model, but do the opposite of its method: they verify a frozen model and never train it.
- **Neither addresses the threats our watchdogs exist for.** Our setting is local, single-user, loopback-only and has no tools. Hand-off integrity, runaway work, secrets entering memory and fail-closed decisions are problems of how data moves. Exact checks and construction settle them, inside the design's trust assumptions: a trusted runtime and code, and hash-pinned frozen weights. A compromised host is out of scope.
- **Neither fixes the refusal drop, but reel 2 names its likely kind.** With the same weights, a fixed keyword rule classified 24 of the team's replies to 100 harmful requests as refusals, against 67 for the model alone. Nobody read the replies, so the actual refusal rates are unknown. If the drop holds up, it is a harness effect on safety behaviour, of the kind reel 2 shows for task success.
  - Reel 1's line of work could give an exploratory diagnostic: a refusal direction ([Arditi et al., 2024](https://arxiv.org/abs/2406.11717)).
  - The likeliest fix is a harness-level rule in W3b, a refusal check in text, which needs its own eval.
- **Recommendation: keep the watchdogs, adopt neither approach as a control, and take one idea from each.**
  - From reel 1, when W3b is picked up: one small offline refusal diagnostic.
  - From reel 2: treat the latent team as its own harness for safety, measuring refusals and thresholds per team configuration, not per model.
  - Skip harness training. It would break the design's frozen-model rule and needs far more hardware than we have.

## At a glance

| | Watchdogs (W1 to W3) | Reel 1: reading neurons | Reel 2: the harness, and training inside it |
| --- | --- | --- | --- |
| **What it is** | Code around a frozen model: exact checks at every hand-off, a gateway, a fail-closed supervisor | Interpretability research: label a model's own neurons and trace circuits, run by automated agents | Capability work: the program around a model changes its score; train the model with RL inside several harnesses |
| **Aim** | Safety assurance for a running latent team | Understanding models | Better task success across agent tools |
| **Threats it addresses here** | Hand-off integrity, runaway work, secrets (by construction for declared or detected ones, in W2's draft), held answers when an exact check or a report fails | None directly. Later, maybe statistical checks on what the memory means | None directly |
| **Strongest assurance** | By construction and exact checks (replay bitwise on 400 of 400 clean questions; 19 of 19 tested fault types caught) | Statistical. The essay's own numbers are preliminary and contested | Measurement (benchmarks). Training is statistical by nature |
| **Cost on our one 16 GB GPU** | Built. +2.2% per question for the checks, audits +18% on average | An inventory of about 793,000 candidate neuron poles in Qwen2.5-3B, most of the work unpriced | Two H100s for 32 to 46 hours per training run, cloud sandboxes, new dependencies |
| **Applies to latent subagents** | Built for them | One possible route in principle; not in practice now | The lesson yes (the team is a harness); the training no (subagents have no tool loop) |
| **Refusal drop** | Measured by keyword rule (eval 14); no control yet (W3b) | Could give an exploratory diagnostic | Names its likely kind; training to fix it would break the frozen-model rule |
| **Verdict** | Keep | Skip as a control; borrow one diagnostic | Skip the training; take the lesson |

## 1. Reel 1: what it shows, and its source

### How the reel was read

- The page was opened without logging in, through Firecrawl and the app's built-in browser. Caption: "Humanity just got plot armor. #ai #tech #business". At reading time it had 1,804 likes, 48 comments and about 65,700 plays. The page shows 15 October in local time and the scraped metadata 16 October.
- The video is 135 seconds long. Its captions are burned into the picture. I read them, and the screenshots it shows, from frames sampled every 3 to 12 seconds with the sound off. **I may have missed lines, and I heard no audio.**
- The reel links no source. The essay is identified by its title and subtitle shown on screen, and by Cammarata's X post shown in a screenshot.

### What it says, in order (paraphrased)

1. It opens with "Today, we are canceling the apocalypse", over a post by another account calling Cammarata's post the best news of the year.
2. It shows Cammarata's X post. He says interpretability may be the most important scientific problem right now. He co-authored early mechanistic interpretability work at OpenAI, then started OpenAI's first large-scale automated interpretability project, which found about 2% of neurons legible.
3. It explains interpretability as reading the mind of an AI ("we know how to build AI but have no idea how it thinks").
4. It shows the essay's title and subtitle.
5. It says that in 2023 his team could read only 2% of an AI's "brain cells". It walks through the famous cat-and-car neuron. Over the essay's passage about neurons having one job, it says that now we can read 90%.
6. It closes with "update your p(doom)" and "we're in the good AI timeline".

### The primary source

- **The essay:** Nick Cammarata, Goodfire, 2026-10-15, <https://already-clean.goodfire.com/>. It is labelled a working hypothesis and a 65-minute read, written with contributions from Curt Tigges and Tarun Gogineni.
- **Related documents not read here:**
  - a technical companion paper the essay links, "Neurons as an Interpretable Basis";
  - a companion paper on trillion-parameter models, which the essay announces as future work;
  - the X post itself (its text is taken from the reel's screenshot).
- **The author's record:** a co-author of Zoom In, Curve Detectors and Multimodal Neurons (Distill), and of OpenAI's 2023 automated interpretability paper.

What the essay claims (paraphrased; numbers as the essay states them):

1. **The famous mixed-up neurons were misread, and a network's neurons and circuits are mostly legible directly.** "Polysemantic" neurons appear to have several unrelated jobs. The essay says they were mostly not caused by superposition, a network packing unrelated concepts into one neuron because they rarely collide. They were caused by ordinary, fixable problems instead: architectures that made late layers overflow, weak tools, wrong expectations and small models. Most of the remaining mixing is what it calls "recursive generalization": a neuron's job sprouts related offshoots, the way a branch sprouts sub-branches.
2. **So a network's own neurons are a usable unit of study.** There is no need to train a decomposition first, such as a sparse autoencoder, and study that instead.
3. **The evidence it reports:**
   - InceptionV1 retrained with later architecture improvements, at the same size and on the same data: 99 to 100% of last-layer neurons easily interpretable;
   - three ConvNeXt vision models spanning about 300× in size (92,000 to 28.6 million parameters), described as broadly legible at every size;
   - reinterpretations of the classic cat-and-car neuron and of the original superposition circuit in Zoom In;
   - preliminary audits of Qwen3-32B: about 90% of neuron poles have one main job, about 7% two related jobs, and about 2 to 4% are not yet understood. The essay's own footnote says these shares move with the thresholds chosen. In smaller samples it looked at closely, it reports about 97% non-arbitrary when considering strong activations;
   - models with trillions of parameters (Kimi K3): preliminary impressions and one attribution graph. The essay says full audits at that scale have not begun;
   - a test of 200 neurons drawn at random from the authors' gallery. An agent read only each neuron's explanation, then wrote five examples that should drive the neuron and five near misses that should not. For the 183 neurons whose explanations covered the positive side, the new examples fired strongly 76% of the time and the near misses 11%. The explanation won for 164 neurons, tied for 15 and lost for 4.
4. **A speculative vision.** Interpretability may become tractable soon, run as a laboratory of automated agent scientists that watch a network through training and use. Deception, it argues, would sit in plain sight in the circuits, for whoever learns to read them. The essay itself calls this step "highly speculative". The authors say they are about 85% sure of their main claim, which is about what kind of process produces neurons. They say a cleanliness score is the part they are least sure of.

**What the essay is not:**

- a tool or a library to install. I found no link to a code repository in the page (no GitHub, GitLab or Hugging Face link);
- a runtime monitor, or a method with measured false-alarm and miss rates for detecting bad behaviour;
- tested against an attacker;
- shown on a model as small as ours (Qwen2.5-3B). It says that a network short on room learns broader, coarser neurons.

### Checking the reel's numbers

| The reel says | The source says | Status |
| --- | --- | --- |
| 2% of neurons readable in 2023 | Cammarata's X post: about 2%. The essay: about 1.7% by the most generous measure, in the 2023 OpenAI project (Bills et al.) | The reel matches the post's rounding. **Not checked against the 2023 paper** |
| "Now we can read 90%" | About 90% of neuron *poles* in Qwen3-32B have *one main job*, often with small related offshoots. These are preliminary audits, and the share depends on thresholds. One main job is not the same as fully readable | **Overstated by the reel.** The 90% is the authors' own estimate and has not been replicated |
| Works up to trillions of parameters | Preliminary impressions on Kimi K3; full audits at that scale not begun; details in a future companion paper | **Not verifiable yet** |
| The apocalypse is cancelled; update your p(doom) | The essay calls that step of its argument highly speculative | **Not in the source** |

**Independent reaction.**

- [Liv Gorton's response](https://livgorton.com/already-clean-thoughts/) (2026-10-20) reruns standard checks on the essay's vision examples and reports that they fail:
  - synthetic V shapes drive the cat-and-car neuron to only about 25% of its maximum, and rounding the V does not lower its response;
  - the two proposed "pose" neurons keep 97% and 99% of their response when their top images are mirrored, while known pose neurons keep only 25% to 54% (medians);
  - re-running the essay's experiment that squeezes a layer from 480 channels to 10 shows curves in superposition, which is what superposition theory predicts.
- She also argues that the essay attacks a non-standard definition of superposition. She notes that the language-model evidence comes from models and data readers cannot inspect.
- A paper on PhilArchive, "Already Clean, Not Yet Meaningful", also responds; I read only its title and abstract line.

**Bottom line on the source:** the numbers are the authors' own, preliminary and contested. None of this settles the science. It does mean nothing here is a measured property we could build a guarantee on.

## 2. Reel 2: what it shows, and its source

### How the reel was read

- The page was opened the same way.
  - Caption: comment "HARNESS" to receive "the three upgrades I'd make before switching models", which "live in my open source harness repo".
  - It then says the same model, with the same weights, solved 62% of tasks in one coding tool and 33% in another, and that Hugging Face measured that the tool around a model decides half of what you get.
  - At reading time it had 4,301 likes, 1,595 comments and about 140,300 plays. The comment count is inflated by the comment-to-receive offer.
- The video is 96 seconds long. Its burned-in captions show one spoken word at a time, so they carry little on their own. The screenshots it shows carry the content.
  - **I heard no audio**, and frames were sampled every 8 to 10 seconds.
  - The screenshots: a news card about an open-source proxy that turns harnesses into reinforcement-learning environments; Hugging Face's own post (the 62% and 33% figures, tested on Liquid AI's LFM2.5-2.6B, with a link to the full guide on huggingface.co/spaces); and, at the end, a page in the presenter's GitHub repository titled "3 harness upgrades before you switch models".
  - That page's first upgrade is writing an instructions file, such as `CLAUDE.md` for Claude Code. The repository's name is cut off in the frame, and I did not open it.

### The primary source

- **The guide:** "The ultimate guide to multi-harness RL", a Hugging Face Space by FineEnvs, <https://huggingface.co/spaces/FineEnvs/multi-harness-rl>. Published 2026-09-24 and updated 2026-10-01, with results compiled through 2026-09-29.
  - Authors: Adithya S Kolavi, Joel Niklaus, Sergio Paniego Blanco, Leonie Monigatti, Amine Dirhoussi, Ben Burtenshaw, Lewis Tunstall and Leandro von Werra.
  - It is open: the tasks, the trainer and the training scripts are published with it.

What the guide says (paraphrased; numbers as it states them):

1. **The harness changes the score before any training.** A harness is the software between a model and its task. It runs the loop, chooses the tools, builds the context the model reads, interprets what the model sends back and decides when to stop.
   - LFM2.5-2.6B, before training, on 250 held-out test tasks: 62.1% under Mini-SWE-Agent, 40.0% under Codex, 33.6% under OpenCode and 33.2% under Claude Code (42.2% overall).
   - The guide also cites a measurement of the same model, GLM-5.2, at 23% in one harness and 52% in another on SWE-bench Pro.
   - Its conclusion: a score measured in one harness describes the model in that harness, not the model in general.
2. **A model trained in one harness learns that harness's habits.** The fix it proposes is agentic reinforcement learning inside the harnesses people actually use, run unmodified.
   - Its framework joins OpenEnv, Harbor (tasks and sandboxes) and TRL (the trainer).
   - A capture proxy between the harness and the model records the exact tokens the model produced and their probabilities, because training on re-tokenized text would update the model on output it never generated.
3. **Results on LFM2.5-2.6B:**
   - trained across four harnesses: from 42% to 54% overall, improving under every harness, with 31% fewer tool calls on the tasks both versions solved;
   - trained in OpenCode alone: from 34% to 58% in OpenCode, much less elsewhere, and 52% overall. The guide says the gap between the two runs' overall scores is within the noise;
   - fine-tuning on a 27-billion-parameter teacher's successful attempts scored below both reinforcement-learning runs.
4. **Cost:** two H100 GPUs per run, about 32 hours of training for the OpenCode-only run and 46 hours for the four-harness run, plus a cloud sandbox per attempt. The guide says it did not track the full cost.

**What the guide is not:** a safety method. Safety comes up only in operational details, such as the capture proxy binding to localhost by default.

### Checking the reel's numbers

| The reel says | The source says | Status |
| --- | --- | --- |
| Same model, same weights: 62% in one tool, 33% in another | 62.1% under Mini-SWE-Agent and 33.2% under Claude Code, for LFM2.5-2.6B before training, on 250 test tasks, each run once | **Correct**, for one small model on one task set |
| The tool around your AI decides half of what you get | A score in one harness describes the model in that harness. Large harness effects also appear for other models (GLM-5.2: 23% against 52%) | **A loose generalization** of real results; "half" is the reel's own framing |
| Hugging Face measured it | Hugging Face's guide and post | **Correct** |

**Bottom line on the source:** a careful, open and reproducible guide with its own caveats stated. The reel reports it fairly, compared with reel 1, but wraps it in an offer for the presenter's repository. The repository itself is general advice for developer tools, not part of the measured result.

## 3. Our side, briefly

The design ([watchdog-security.md](watchdog-security.md)) sorts every control into one of four strengths: by construction, exact check, statistical check, or not covered. It relies on construction and exact checks:

- **One watchdog per squad of up to 5 subagents, and one supervisor per run.** All of it is plain code, not AI.
- **Exact checks at every hand-off:**
  - the turn structure;
  - the configuration;
  - legibility: each fed vector must equal the token mix the watchdog rebuilds itself;
  - a ledger of what was appended to memory;
  - a keyed checksum of the memory between turns;
  - budgets.
- **Replay on a sample of runs.**
- **Signed reports that hold only booleans, identifiers, fixed words and coarse numbers.** The supervisor holds the answer when an exact check or a report fails. A statistical flag triggers one fallback to the solver alone.

**All of this holds inside stated trust assumptions:**

- **Trusted:** the runtime, the gateway, watchdog and supervisor code, the frozen weights pinned by hash, and a secret key made for each run.
- **Not trusted:** every input other than the user's own request, anything that crossed a process boundary, and anything read back from storage.
- **Out of scope:** a compromised host or runtime, timing side channels and backdoored weights.
- **The gateway constrains actions, not answers.** It limits what the team may see and do, but it does not stop a manipulated answer. Today's chat route also loses each span's origin.

Where we stand (as of 2026-11-27):

- **W1, integrity and audits** (PR #73, built, awaiting Ruslan's review):
  - on 400 clean GSM8K questions in the tested configuration (two blocks of 200), replay reproduced the answer and every step's top token, and the memories at each hand-off were bitwise equal. That supports replay as an exact check for that configuration, not determinism in general;
  - all 19 tested fault types were caught on all 64 questions each, each by the exact check named for it;
  - the checks add 2.2% to median wall time. Audits, at 1 run in 20 plus every flagged run, add about 18% on average, and fallbacks about 1.4%;
  - the statistical scores flagged 2.0% and 0.5% of clean runs, or 2.5% under the supervisor's combined rule. Their AUROCs for a wrong answer were 0.38 and 0.62: integrity indicators, not validated for correctness.
- **W2, data gateway** (draft #71, parked):
  - the automated review stopped after 25 rounds. Over rounds 6 to 25, each found zero to two more ways a copy of a secret can change form on its way past the scanner; rounds 24 and 25 found one high-severity case each;
  - all were fixed with regression tests, but the family of such tricks stays open;
  - the record asks for a human security review before relying on the gateway.
- **W3, calibrated abstention** (draft #77, results in #94, parked):
  - the error ceiling failed to certify. 42 of 57 finite proposal scores were tied at exactly 0, leaving only 7 distinct cutoffs, and none met the bound. The strictest released 149 of 200 certification answers, 18 of them wrong (one-sided bound 21.3% against a 10% target);
  - in eval 14, a fixed keyword rule classified 24 of the team's replies to 100 harmful requests as refusals, against 67 for the model alone, and 0 of 100 benign against 11. No replies were read, so the actual refusal and harmful-compliance rates are unknown.
- **M2c itself.** The latent team showed no reliable accuracy advantage over the solver alone across three samples, with point estimates on both sides. It runs Qwen2.5-3B on one 16 GB laptop GPU.

## 4. Side by side

### Threats in our setting

The latent team is local, single-user and loopback-only, and it has no tools. Today the live risks are:

- bugs and experiment leftovers silently changing what the team computes. In M2c's first live check, a turn-structure bug (an unclosed turn, with the system block repeated) left the team 0 of 6 correct;
- wrong answers;
- harmful compliance, once text from outside the operator arrives;
- secrets, once real files go in.

An attacker tampering with memory inside the process implies a compromised host, which the design puts out of scope.

| Threat | Watchdogs (W1 to W3) | Reel 1: reading neurons | Reel 2: harness and harness training |
| --- | --- | --- | --- |
| A hand-off corrupted, swapped or reshaped (a bug, an adapter left loaded, aligned thoughts) | **Exact.** 19 of 19 tested fault types, 64 of 64 questions each. Replay bitwise on 400 clean questions | **No evidence it would.** A reading of meaning is not built to notice a swap of similar content. For comparison only: W1's statistical distance score caught a swap between rows on 9% of questions | **No.** Its capture proxy keeps exact tokens for training, an idea close to our thought record, but checks nothing at run time |
| Runaway work, a subagent writing text | **Exact** (budgets) | No | Harnesses cap steps and tool calls, as our runtime already does. Nothing to add |
| Secrets entering memory or the answer | **By construction** for declared or detected secrets (placeholders, in W2's draft). Undeclared, undetected data can still reach the answer. The scanner is weak, as W2's 25 rounds showed | No guarantee. A "secret-like content" reader would be another detector with error rates. The cache must be treated as the transcript either way, since prompts have been reconstructed from caches | No |
| Instructions injected through pasted text | Origin labels and permissions fixed before data (W2, parked). No tools today, so little to misuse | In principle a reader could flag circuits that follow instructions found in a document. No evidence, and statistical | No |
| Wrong answers | Calibrated abstention. **Failed:** the score could not rank answers | Could supply a better confidence signal for W3c. In the [research report](watchdog-research.md) (section 4), hidden-state probes reach AUROC 0.765 to 0.838 (INSIDE) and AUC 0.83 to 0.95 depending on task (Orgad et al.). Hallucination detectors tested on kinds of task they were not trained on fell to chance (Dubanowska et al.). Nothing has been shown on our model | Training raised task success for a 2.6B model in its harnesses. For us it would mean training our model, which the design rules out |
| Harmful compliance (the refusal drop) | Measured by keyword rule (eval 14). No control yet (W3b, backlog) | Could give an exploratory diagnostic. The essay offers no fix and does not discuss refusals | Names its likely kind: same weights, different harness, different behaviour. Its fix, training, is ruled out |
| A model that schemes or deceives | Not covered. The checks verify how data moved, not what it means | The essay's long-term hope, and unproven. No source here tests it on a model like ours | No |
| Tampering in transit between processes | **Exact** against tampering in transit (a signed manifest, with repeats refused). It is designed for the first card that moves memory across processes, needs a way to distribute keys, and assumes an honest sender | No | No |

### Strength of assurance

| | Watchdogs | Reel 1: reading neurons | Reel 2: harness and harness training |
| --- | --- | --- | --- |
| **By construction** | Subagents have no tool handle. Soft thoughts only. Placeholders for declared or detected secrets (W2's draft). Permissions fixed before data is read. Memory and thought records live for the run only, never on disk | None | A harness decides which tools exist, which is construction, but the guide uses it for capability. Our gateway already does this for safety |
| **Exact check** | Turn structure, configuration, legibility (within a stated tolerance), span ledger, memory checksum, budgets (enforced by the runtime, verified by the watchdog), report schema. Replay, measured as exact in the tested configuration (400 of 400, bitwise) | None. Even the neuron explanations are judged statistically: they won for 164 of 183 neurons | Exact token capture, for training data only |
| **Statistical check** | Degenerate-record and distance scores (2.0% and 0.5% false alarms, 2.5% combined; integrity only). Agreement with the solver alone. Abstention (not certified) | Everything: the explanations, the "one main job" share (which depends on thresholds), and any reading at run time | Benchmark scores. Each test cell was run once, so the guide itself treats small differences as noise |
| **Against an attacker** | The exact checks hold inside the trust assumptions. The statistical ones do not, and the design says so | Untested. Our research found that white-box attacks beat every latent-space monitor tested ([Bailey et al.](https://arxiv.org/abs/2412.09565)), and models trained to evade one probe evade others ([Neural Chameleons](https://arxiv.org/abs/2512.11949)) | Not discussed. Training a model inside a harness that contains its monitors is the setting in which models learn to evade them |

### Cost to build and run, and repo rules

| | Watchdogs | Reel 1 on our model | Reel 2 on our model |
| --- | --- | --- | --- |
| **Build** | Built (W1), with three recorded review rounds. W2 and W3 have drafts | Qwen2.5-3B has 36 layers × 11,008 MLP neurons: 396,288 neurons, or 792,576 candidate poles counting both signs ([published config](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/raw/main/config.json)). Mapping them the essay's way has two steps. First, collect each neuron's strongest activations over a corpus. Then have an agent write and test an explanation for each pole: up to roughly 800,000 agent tasks for a full inventory. Those would go to an external model or to a local labeller competing for the one GPU. An external model costs money and sends the examples off the machine, so it could use a synthetic corpus only. Corpus collection, storage, validation and GPU contention are unpriced. The essay states no compute budget, and its author describes months of expert work | The guide's runs used two H100s for 32 to 46 hours each, on a smaller model than ours, with a cloud sandbox per attempt. We have one 16 GB laptop GPU. Our subagents also call no tools, so there is no tool loop to train in |
| **Run** | +2.2% for the checks; audits +18% on average, fallbacks +1.4% | The run-time cost of reading labelled neurons is unmeasured. Every label and threshold would need measuring again after each weights change, like our thresholds, and its error rates would need measuring too | A trained model is a new weights hash. Every W1 threshold and reference statistic would need measuring again |
| **Repo rules** | Plain Python in `runtime/` with torch, already there. No new runtime dependency | A narrow experiment needs only plain torch forward hooks, which W1 already uses, so no new dependency. A full pipeline (attribution graphs, labelling agents, an external API) would likely add runtime dependencies, each needing an ADR, and send data off the machine | TRL, OpenEnv, Harbor and a cloud sandbox: new dependencies, an ADR, and code leaving the machine. It also conflicts with the design's rule that the model is frozen and never trained against the monitors |

### What each catches that the others miss

- **The watchdogs caught these, among W1's 19 tested fault types, and neither reel's approach is built to:**
  - a memory swapped, scaled or reshaped between turns, including another question's memory swapped in where the answer may not change;
  - a loaded adapter;
  - a missing turn close;
  - extra latent steps;
  - a subagent emitting text.

  These are facts about data movement with one right answer. A reading of meaning would either miss them or flag them only as accidents. A training method does not look at them at all.
- **Reel 1's approach might, hypothetically, catch:**
  - what the memory represents, for example the planner steering towards something harmful or the critic's critique being wrong. The design lists the critique's correctness as not covered;
  - signs of why refusals drop.

  None of this has been shown. It would be statistical, unmeasured on our model and untested against attack.
- **Reel 2's approach catches nothing at run time.** Its value to us is a measurement habit: always report behaviour per harness configuration.

## 5. The refusal drop

- **Neither source addresses it.** The essay never mentions refusals. The guide measures task success, not refusals.
- **Reel 2 names the likely kind of effect.** The latent team is a different harness around the same Qwen2.5-3B: role prompts, latent steps, a shared memory and a solver. With the same weights, keyword-classified refusals moved from 67 to 24 of 100 harmful requests. If that holds up when the replies are judged properly, it is the same kind of effect as task success moving from 62% to 33% between harnesses in the guide.
  - So the model's refusal behaviour in text is no guide to its behaviour inside our team until it is measured there.
  - Refusals, like our thresholds, belong to a team configuration, not to a model.
- **What eval 14 can and cannot say.**
  - A fixed keyword rule classified fewer of the team's replies as refusals on both sets: harmful 24 against 67, benign 0 against 11.
  - Nobody read the replies, so the actual refusal and harmful-compliance rates are unknown.
  - Several explanations can hold at once: the latent memory moving the solver away from refusing, the team wording its refusals in ways the keyword list misses, and the rule counting refusal phrases used in passing.
- **Where reel 1's line of work helps: an exploratory diagnostic.** [Arditi et al. (2024)](https://arxiv.org/abs/2406.11717) found that refusal in the open chat models they tested is carried by a single direction in the residual stream. That direction is the difference of mean activations on harmful and harmless prompts. A careful use of it here has four parts:
  - first judge the replies independently, and check that the direction separates judged refusals from answers on held-out replies of the model alone;
  - fix the layer and token position in advance;
  - compare paired projections in solo and team mode on held-out requests;
  - report the 46 requests only the model alone refused (they come from the whole set) with the held-out ones separately.

  **How to read the result.** A lower projection in team mode shows that the hand-off changes that activation. Proving it causes the drop would take a controlled intervention. An unchanged projection could mean the direction transfers poorly, the position is wrong, or the change is one the direction misses.

  This needs no new dependency and no labelling agents. It is research, not a control.
- **A candidate fix: W3b, a harness rule in text.** One option for W3b: before the team answers a request from outside its operator, run the model alone on the request in text. If the model alone refuses, return that refusal.
  - **A retrospective count, not a measured gate.** Replaying the fixed keyword rule over the recorded replies gives a union of 70 harmful and 11 benign requests classified as refusals.
  - **Its errors carry over.** A deployed gate enforces the model alone's refusal as judged by its classifier, and inherits that classifier's misses and false alarms.
  - **Its cost is about one extra `single` run per request.** The only timings we have are on GSM8K (1.17 to 1.38 s for `single`, 1.78 to 2.01 s for the team, across M2c's three samples), not on this workload.
  - **It needs its own eval:** actual refusals, harmful answers, benign refusals and end-to-end latency, on the team configuration that will ship.
- **What not to do.**
  - Changing a fed vector during the latent loop, for example to steer the refusal direction back in, would break the recorded-mix rule the legibility check enforces: opaque mode, research only. An intervention elsewhere in the residual stream could leave that check passing while changing behaviour. Any such steering is a new configuration, and its thresholds must be measured again.
  - Training the model or a thought adapter to refuse inside the team would void every threshold. The published evidence is that *trained* latent links comply with harmful requests more often than the same model in text ([research report](watchdog-research.md), section 2).

## 6. Same approach, or different?

**Different.** The two reels agree on one point only: a model's weights do not settle how it behaves.

- **Reel 1 looks inside the model.** It reads neurons, so a model can be understood, and eventually checked, from the inside.
- **Reel 2 changes what surrounds the model.** The program around the model shifts its results, so the reel's answer is to train the model inside the programs people use.
- **Our watchdogs sit where reel 2 looks:** code around the model. But they verify a frozen model rather than train it, and they aim at safety, not score.
- **Neither reel describes a safety mechanism.** Neither offers an exact check or anything that fails closed.

## 7. Do they apply to latent agents? Is it marketing?

- **Reel 1, in principle, is one possible route back to what latent mode removes.** Latent mode loses readable reasoning ([Korbak et al., 2025](https://arxiv.org/abs/2507.11473)). Our thought record describes exactly what was fed in (16 token ids and weights per step), not what the model or its memory represents. Reading the model's internals could, in principle, add that.
- **Reel 1, in practice, does not apply now:**
  - I found no published neuron map for Qwen2.5-3B, and the essay does not show its method on a model this small. Its language results are on models of 32 billion parameters and more;
  - it expects small models to have coarser neurons;
  - its central numbers are self-reported, preliminary and contested;
  - a reading used at run time would be one more statistical check, of the kind the design already demotes from approving anything.

  The design's rule that no model interprets a thought ([Li et al., ICML 2026](https://arxiv.org/abs/2509.13316)) also stands. The essay's explanations are offline and can be tested, which is better than a model describing one activation live. They are still a model's description with an error rate.
- **Reel 2's lesson applies to latent agents; its method does not.**
  - The latent team is a harness around one model, so its behaviour, refusals included, must be measured as a team.
  - Its training method needs a tool loop, which our subagents do not have.
  - It needs far more hardware than one laptop GPU.
  - It conflicts with the frozen-model rule.
- **Reel 1 is mostly marketing.** Its claims (the apocalypse cancelled, 90% of brain cells readable, update your p(doom)) are not in the source, or are stronger than the source. **Its essay is not marketing.** It is a serious, falsifiable research bet by a credible author, already under informed criticism. It is about understanding models, not about guarding a running system.
- **Reel 2 is accurate but promotional.** Its headline number is right, and "decides half of what you get" stretches it. It ends in an offer for the presenter's repository. **Its guide is solid.** It is open work from Hugging Face with its caveats stated, about making agents more capable, not safer.

## 8. Recommendation: keep the watchdogs, take one idea from each reel

1. **Keep the watchdogs.** W1 is the only layer here with exact checks measured on our own model (in the tested configuration, inside the design's trust assumptions), at 2.2% overhead for the checks. Nothing in either source replaces any of its checks, the gateway's construction rules or the supervisor's fail-closed table. The next step for W1 is unchanged: Ruslan's review of PR #73.
2. **Skip neuron reading as a control.** At best it is a statistical check. It is unmeasured on our model and untested against attackers. Mapping a model the essay's way is expensive. And the essay does not claim to be a monitor.
3. **Skip harness training.**
   - It improves task success, which is not what the watchdogs are for.
   - It needs a tool loop we do not have, and far more hardware than we have.
   - A trained model would void every W1 threshold.
   - It breaks the design's rule that the model is never trained against its monitors.
4. **From reel 1, when W3b is picked up:** alongside judging the replies properly, run a small, pre-registered, exploratory refusal-direction diagnostic (section 5) before choosing W3b's fix. If a hidden-state probe is tried for W3c, keep the essay's best habit: write predictions, including near misses, before measuring, so each explanation is specific enough to lose.
5. **From reel 2, now and for W3b:** treat the team as its own harness for safety.
   - Measure refusals for the team configuration that will ship, not for the model.
   - Keep pinning thresholds to the full configuration, as W1's threshold file already does (weights hash, soft thoughts, m = 40).
   - Prefer harness-level fixes, such as a text-mode refusal check, over changing the model, each with its own eval.
6. **What would change this recommendation:**
   - an independent replication of the essay's language-model numbers on a small open model;
   - a published neuron or circuit monitor with measured false-alarm and miss rates under attack;
   - the team getting tools with outside effect. Then both a meaning-level check and the tool loop's harness would matter more, and the gateway (W2) would come out of draft first.

## 9. What to do next

- **Nothing to build now.** W2 and W3 stay parked on the triggers already agreed: a file read, a tool call, an agent relaying outside text, or another app calling the chat route.
- **For W3b's owner, when the card starts.** This is a new proposal for the existing W3b card, which is recorded on PR #94's board.
  - **Judge the replies first.** Use a judge better than the keyword list, so that actual refusals and harmful answers are known for both systems.
  - **The data.** JBB-Behaviors (the copy already downloaded with permission and kept outside the repository), with the same math-style instruction as eval 14.
  - **The diagnostic.**
    - Fit the refusal direction on one half of the harmful and benign requests, using the model alone. Check it against the judged refusals.
    - Fix the layer and token position in advance.
    - On the other half, report paired projections for the model alone and for the team. Report the 46 keyword-discordant requests separately.
    - Keep counts and summary numbers only, and treat the result as exploratory.
  - **Its cost.** The diagnostic's GPU cost is unmeasured. Eval 14 and W3's analysis together finished within about 11 minutes, which gives a rough scale only. It needs the GPU queue and lock.
  - **The candidate fix.** The text-mode refusal check above, with its own eval and a judge better than the keyword list, measured on the team configuration that will ship.
- **Optional:** revisit when the essay's companion papers, or independent replications, appear.

## What I could not verify

- **Both reels' audio.** I read their on-screen text from sampled frames with the sound off, so I may have missed lines.
  - Reel 1's X post was not opened; its text is from the reel's screenshot.
  - Reel 2's Hugging Face post was seen only in the reel and in a search result.
  - The presenter's repository was not opened; its name is cut off in the frame.
- **The 2% and 1.7% figures** were not checked against Bills et al. (2023).
- **The Qwen3-32B shares (about 90%, 7%, 2 to 4%) and the Kimi K3 claim** are the authors' own preliminary audits. They are not replicated, and the Kimi K3 details are not published yet.
- **Documents not read:** the essay's companion paper "Neurons as an Interpretable Basis", and the PhilArchive response (title and abstract line only). Gorton's response was read in full, but her reproductions were not rerun.
- **Arditi et al.'s method was not tested on Qwen2.5-3B, alone or in team mode.** Section 5's diagnostic is a proposal, not a result, and its GPU cost is unmeasured.
- **The 65-minute essay** was read in its summary, method, evidence, title and solution sections, plus the passages on probes, audits and meta-models; the full figure-by-figure appendix was not.
- **The guide** was read in its introduction, harness definition, benchmark, rewards, setup, baseline and conclusions sections; its training-curve details were not. The GLM-5.2 figure (23% against 52%) is as the guide cites it, not checked at its source.

## Sources

- Reel 1: <https://www.instagram.com/reel/DeisChfx_wV/> (Max Munro, @maxbmunro, October 2026).
- Reel 2: <https://www.instagram.com/reel/DeZ4sI6hZTZ/> (Qendresa Hoti, @qendresahhoti, 2026-10-12).
- Nick Cammarata, "Neural Networks Are Already Clean", Goodfire, 2026-10-15: <https://already-clean.goodfire.com/>.
- Kolavi, Niklaus, Paniego Blanco, Monigatti, Dirhoussi, Burtenshaw, Tunstall and von Werra, "The ultimate guide to multi-harness RL", Hugging Face, 2026-09-24 (updated 2026-10-01): <https://huggingface.co/spaces/FineEnvs/multi-harness-rl>.
- Liv Gorton, "Some initial thoughts on Nick Cammarata's 'Neural Networks Are Already Clean'", 2026-10-20: <https://livgorton.com/already-clean-thoughts/>.
- "Already Clean, Not Yet Meaningful", PhilArchive: <https://philarchive.org/archive/LISACN> (abstract line only).
- Arditi et al., "Refusal in Language Models Is Mediated by a Single Direction", 2024: <https://arxiv.org/abs/2406.11717>.
- Qwen2.5-3B-Instruct configuration: <https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/raw/main/config.json>.
- Our design and evidence: [watchdog-security.md](watchdog-security.md), [watchdog-research.md](watchdog-research.md), [m2c-latent-team.md](m2c-latent-team.md); W1 results in `docs/evals.md` on `claude/w1-watchdog-integrity-82aa3b` (PR #73); W2's review rounds on `claude/w2-data-gateway` (PR #71); W3's results on `claude/w3-results-on-record` (PR #94).
