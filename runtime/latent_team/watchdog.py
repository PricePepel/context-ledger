"""W1: the watchdog of one latent squad (docs/watchdog-security.md, "The watchdog").

Plain code: no model call. It multiplies the frozen head and embedding table to rebuild a
soft thought, which is linear algebra on weights, and never runs the transformer or reads
squad output as instructions.

How it watches. `LatentTeam.latent_mas(..., watch=w)` registers two hooks on the model's
base and calls the watchdog at every hand-off (`turn_start`, `turn_end`). The hooks see
every input the transformer actually receives (token ids or a fed vector) and the last
hidden state it returns, so the watchdog's record is taken at the model boundary, not
from the team's own bookkeeping.

The thought record. A soft thought is the probability-weighted mix of the top 16 token
embeddings at that step, so it has an exact description: 16 token ids and 16 weights. The
watchdog derives that record itself from the hidden state that came out of the previous
step, rebuilds the mix, and compares it with the vector that was fed. The record lives on
this object for the run and is never stored, logged or returned by an API. It describes
what was fed in, not what the model "thought".

Exact checks, per question unless the fault is batch-wide by nature:
  turnStructure   the token ids appended for every turn equal the plan: only the first
                  agent carries the system block, and every thinking turn is closed
  configuration   soft thoughts, no adapter, no LoRA, the planned steps and the weights
                  hash the threshold set was measured on
  legibility      each fed vector equals the watchdog's own rebuild of the soft mix
  spanLedger      every call appended what the plan says, at the planned position
  memoryChecksum  a keyed checksum of the memory at the end of one turn equals the one
                  at the start of the next
  numbers         no NaN or infinity in thoughts, hidden states or the cache
  budgets         m latent steps per thinker, no text from a thinker, the solver within
                  its token budget, wall time within its cap, no tool calls

Statistical checks (accidents only; their rates are measured, not assumed):
  degenerate      repeated top tokens, whitespace and special top tokens, and weights
                  collapsed onto one token, from the thought record
  distance        relative Mahalanobis distance (Ren et al. 2021) of each latent step's
                  hidden state from a per-role Gaussian against a pooled one
"""
import hashlib
import hmac
import json
import math
import os

import torch
import torch.nn.functional as F

from . import reports
from .chat_turns import first_turn

P = 2 ** 31 - 1            # the checksum's prime; every product below fits in int64
MODE, TOP_K, TEMPERATURE = "soft", 16, 1.0
LEGIBILITY_TOLERANCE = 1e-3  # relative L2 error of a fed vector against the rebuilt mix
MAX_THINKERS = 4           # a squad is up to 5: up to 4 thinking agents and the solver
COLLAPSE = 0.9             # a step whose top weight is at least this has collapsed
THRESHOLD_DIR = os.path.join(os.path.dirname(__file__), "thresholds")


# ------------------------------------------------------------------ weights
def weights_fingerprint(model):
    """(SHA-256 of every parameter and buffer, in name order, and the tuple of names).

    Computed once per loaded model; LatentTeam.load_checkpoints drops it, and the names
    show a LoRA or any other module added later."""
    digest = hashlib.sha256()
    named = dict(model.named_buffers())
    named.update(model.named_parameters())
    for name in sorted(named):
        tensor = named[name].detach()
        digest.update(f"{name}|{tensor.dtype}|{tuple(tensor.shape)}|".encode())
        digest.update(tensor.contiguous().reshape(-1).view(torch.uint8).cpu().numpy())
    return digest.hexdigest(), parameter_names(model)


def parameter_names(model):
    return tuple(name for name, _ in model.named_parameters())


def team_weights(team):
    cached = getattr(team, "_w1_weights", None)
    if cached is None:
        cached = weights_fingerprint(team.model)
        team._w1_weights = cached
    return cached


# ------------------------------------------------------------------ memory
def memory_layers(memory):
    """[(keys, values)] of a DynamicCache, each [batch, heads, length, head dim]."""
    if memory is None:
        return []
    if hasattr(memory, "layers"):
        return [(layer.keys, layer.values) for layer in memory.layers
                if getattr(layer, "keys", None) is not None and layer.keys.numel()]
    return list(zip(memory.key_cache, memory.value_cache))


def memory_length(memory):
    return 0 if memory is None else int(memory.get_seq_length())


class Checksum:
    """A keyed checksum of a working memory, per row, computed on the device.

    Every key and value is read as 16-bit words w (bit patterns, so the arithmetic is exact
    and deterministic), and the checksum is sum(w * a_D * e_S * c_H * l_layer) mod P with
    coefficients drawn from the run's key. For any fixed change to the words, the chance it
    goes unseen is at most 5/P (Schwartz-Zippel) per sketch; two independent sketches are
    kept. It shows the memory did not change between two points, not that it was right."""

    def __init__(self, key):
        self.key = key
        self.coefficients = {}

    def coefficient(self, sketch, axis, size, device):
        index = (sketch, axis, size, str(device))
        if index not in self.coefficients:
            seed = hmac.new(self.key, f"w1-checksum|{sketch}|{axis}|{size}".encode(), hashlib.sha256).digest()
            generator = torch.Generator(device=device)
            generator.manual_seed(int.from_bytes(seed[:8], "big") >> 1)
            self.coefficients[index] = torch.randint(1, P, (size,), generator=generator, device=device,
                                                     dtype=torch.int64)
        return self.coefficients[index]

    def _fold(self, words, sketch, axes):
        y = words
        for axis in axes:
            y = ((y * self.coefficient(sketch, axis, y.shape[-1], y.device)) % P).sum(-1) % P
        return y

    def __call__(self, memory, mask):
        layers = memory_layers(memory)
        rows = mask.shape[0] if mask is not None else (layers[0][0].shape[0] if layers else 0)
        device = mask.device if mask is not None else layers[0][0].device
        out = torch.zeros(rows, 2, dtype=torch.int64, device=device)
        for sketch in (0, 1):
            total = torch.zeros(rows, dtype=torch.int64, device=device)
            lam = self.coefficient(sketch, "layer", 2 * len(layers) + 1, device)
            for index, (keys, values) in enumerate(layers):
                for kind, tensor in enumerate((keys, values)):
                    words = tensor.contiguous().view(torch.int16).to(torch.int64) & 0xFFFF
                    y = self._fold(words, sketch, ("D", "S", "H"))
                    total = (total + (y * lam[2 * index + kind]) % P) % P
            if mask is not None:
                y = self._fold(mask.to(torch.int64), sketch, ("S",))
                total = (total + (y * lam[-1]) % P) % P
            out[:, sketch] = total
        return out


def cache_finite(memory, rows, device):
    ok = torch.ones(rows, dtype=torch.bool, device=device)
    for keys, values in memory_layers(memory):
        ok &= torch.isfinite(keys).flatten(1).all(-1) & torch.isfinite(values).flatten(1).all(-1)
    return ok


# ------------------------------------------------------------------ statistical references
class Reference:
    """Per-role Gaussians with one shared covariance, and one pooled Gaussian (Ren et al.).

    rmd(h, role) = MD_role(h) - MD_pooled(h). Built from clean runs of the same role and
    weights; any change of weights voids it."""

    def __init__(self, means, whiten, pooled_mean, pooled_whiten, meta):
        self.means, self.whiten = means, whiten
        self.pooled_mean, self.pooled_whiten = pooled_mean, pooled_whiten
        self.meta = meta

    def to(self, device):
        return Reference({r: m.to(device) for r, m in self.means.items()}, self.whiten.to(device),
                         self.pooled_mean.to(device), self.pooled_whiten.to(device), self.meta)

    def rmd(self, hidden, role):
        h = hidden.float()
        own = (((h - self.means[role]) @ self.whiten) ** 2).sum(-1)
        pooled = (((h - self.pooled_mean) @ self.pooled_whiten) ** 2).sum(-1)
        return own - pooled

    def save(self, path):
        torch.save({"means": {r: m.cpu() for r, m in self.means.items()}, "whiten": self.whiten.cpu(),
                    "pooledMean": self.pooled_mean.cpu(), "pooledWhiten": self.pooled_whiten.cpu(),
                    "meta": self.meta}, path)

    @classmethod
    def load(cls, path, device="cpu"):
        data = torch.load(path, map_location="cpu", weights_only=True)
        return cls(data["means"], data["whiten"], data["pooledMean"], data["pooledWhiten"], data["meta"]).to(device)


class ReferenceBuilder:
    """Accumulates hidden states per role (count, sum, outer products in float64)."""

    def __init__(self):
        self.stats = {}

    def add(self, role, hidden):
        h = hidden.detach().double()
        n, s, outer = self.stats.get(role, (0, 0.0, 0.0))
        self.stats[role] = (n + h.shape[0], s + h.sum(0), outer + h.T @ h)

    def build(self, shrink=0.05, meta=None):
        def whitening(cov):
            dim = cov.shape[0]
            cov = (1 - shrink) * cov + shrink * (torch.trace(cov) / dim) * torch.eye(dim, dtype=cov.dtype,
                                                                                     device=cov.device)
            lower = torch.linalg.cholesky(cov)
            return torch.linalg.inv(lower).T.float()   # d @ W has squared norm d^T cov^-1 d

        total = sum(n for n, _, _ in self.stats.values())
        means = {role: (s / n) for role, (n, s, _) in self.stats.items()}
        within = sum(outer - n * torch.outer(means[role], means[role])
                     for role, (n, _, outer) in self.stats.items()) / total
        pooled_mean = sum(s for _, s, _ in self.stats.values()) / total
        pooled = sum(outer for _, _, outer in self.stats.values()) / total - torch.outer(pooled_mean, pooled_mean)
        return Reference({role: m.float() for role, m in means.items()}, whitening(within), pooled_mean.float(),
                         whitening(pooled), dict(meta or {}, samples=int(total), shrink=shrink))


def load_thresholds(model_name, weights_hash, directory=THRESHOLD_DIR):
    """The threshold set measured on these weights, or None. Thresholds are aggregate
    numbers (quantiles of clean scores) and are committed; reference statistics are not."""
    if not os.path.isdir(directory):
        return None
    for name in sorted(os.listdir(directory)):
        if name.endswith(".json"):
            with open(os.path.join(directory, name), encoding="utf-8") as handle:
                data = json.load(handle)
            if data.get("model") == model_name and data.get("weightsHash") == weights_hash:
                return data
    return None


def bucket(score, edges):
    """0 to 9: how many of the threshold set's edges the score reaches. The edges are the
    clean 50, 60, 70, 80, 90, 95, 98, 99 and 99.5th percentiles, so bucket 8 or more is a
    flag (the 99th) and 6 or more a weak signal (the 95th)."""
    return min(9, sum(1 for edge in edges if score >= edge))


def junk_table(team):
    """For every token id: is it whitespace only, a special token, or outside the tokenizer?"""
    table = getattr(team, "_w1_junk", None)
    if table is not None:
        return table
    tokenizer = team.tokenizer
    size = team.model.get_input_embeddings().weight.shape[0]
    try:
        known = len(tokenizer)
    except TypeError:
        known = size
    special = set(getattr(tokenizer, "all_special_ids", None) or [])
    ids = list(range(min(size, known)))
    batch = getattr(tokenizer, "batch_decode", None)
    texts = batch([[i] for i in ids]) if callable(batch) else [tokenizer.decode([i]) for i in ids]
    flags = [i in special or not text.strip() for i, text in zip(ids, texts)] + [True] * (size - len(ids))
    table = torch.tensor(flags, dtype=torch.bool, device=team.model.get_input_embeddings().weight.device)
    team._w1_junk = table
    return table


# ------------------------------------------------------------------ the plan
class Plan:
    """What the squad must append, derived by the watchdog from the questions, the role
    prompts and the model's chat template, independently of LatentTeam.render."""

    def __init__(self, team, questions, roles, steps):
        from .team import LATENT_PROMPTS
        tokenizer, device = team.tokenizer, team.device

        def batch(texts):
            encoded = tokenizer(texts, return_tensors="pt", padding=True, add_special_tokens=False)
            return encoded["input_ids"].to(device), encoded["attention_mask"].to(device)

        self.roles, self.steps, self.rows = tuple(roles), steps, len(questions)
        self.prompts = []
        for index, role in enumerate(roles):
            texts = [LATENT_PROMPTS[role].format(question=q) for q in questions]
            self.prompts.append(batch([first_turn(tokenizer, t) if index == 0 else team.turns.later(t) for t in texts]))
        self.close = batch([team.turns.close] * len(questions))
        self.solver = batch([team.turns.later(LATENT_PROMPTS["solver"].format(question=q)) for q in questions])
        self.starts = [0]
        for ids, _ in self.prompts:
            self.starts.append(self.starts[-1] + ids.shape[1] + steps + self.close[0].shape[1])


def _same_rows(observed, planned, rows, device):
    """Per row: do the observed (ids, mask) equal the planned ones?"""
    if observed is None or observed[0] is None:
        return torch.zeros(rows, dtype=torch.bool, device=device)
    ids, mask = observed
    want_ids, want_mask = planned
    if ids.shape != want_ids.shape or mask is None or mask.shape != want_mask.shape:
        return torch.zeros(rows, dtype=torch.bool, device=device)
    return (ids == want_ids).all(-1) & (mask == want_mask).all(-1)


# ------------------------------------------------------------------ the watchdog
class Watch:
    """The watchdog of one squad for one run (a batch of questions, one squad each)."""

    def __init__(self, team, questions, *, steps, max_new_tokens, agents=3, thresholds=None, reference=None,
                 time_cap=None, key=None, keep_memory=False, collect=None):
        from .team import chain_roles
        if not 1 <= agents <= MAX_THINKERS:
            raise ValueError(f"a squad has 1 to {MAX_THINKERS} thinking agents and the solver")
        self.team, self.questions = team, list(questions)
        self.rows, self.device = len(self.questions), team.device
        self.roles = chain_roles(agents)
        self.steps, self.max_new_tokens, self.time_cap = steps, max_new_tokens, time_cap
        self.thresholds, self.reference, self.collect = thresholds, reference, collect
        self.keep_memory = keep_memory
        self.plan = Plan(team, self.questions, self.roles, steps)
        self.checksum = Checksum(key or reports.new_run_key())
        self.weights_hash, self.weight_names = team_weights(team)
        self.solver_phase = len(self.roles)
        rows, device = self.rows, self.device
        self.calls, self.record = [], []
        self.phase, self.next_turn, self.order_ok = None, 0, True
        self.stray = self.orphans = 0
        self.prev_hidden = None
        self.legibility_error = torch.zeros(rows, device=device)
        self.finite = torch.ones(rows, dtype=torch.bool, device=device)
        self.distance_sum = torch.zeros(rows, device=device)
        self.distance_steps = 0
        self.starts_seen, self.ends_seen = {}, {}
        self.sums_start, self.sums_end = {}, {}
        self.handoff = None           # (layers, mask) the solver received, when keep_memory
        self.claims = None            # what latent_mas said it would run
        self.handles = []
        self.results = None

    # -------------------------------------------------------------- runtime boundary
    def attach(self, team, *, roles, mode, steps, max_new_tokens, views=None, solver_questions=None, sealed=False):
        if team is not self.team:
            raise ValueError("this watchdog was planned for another team")
        if views is not None or solver_questions is not None or sealed:
            raise ValueError("the watchdog plans the standard squad: every agent sees the question, nothing sealed")
        self.claims = {"roles": tuple(roles), "mode": mode, "steps": steps, "maxNewTokens": max_new_tokens}
        base = team.model.base_model
        self.handles = [base.register_forward_pre_hook(self._before, with_kwargs=True),
                        base.register_forward_hook(self._after, with_kwargs=True)]

    def detach(self):
        for handle in self.handles:
            handle.remove()
        self.handles = []
        self.phase = None

    def turn_start(self, index, memory, mask):
        if index != self.next_turn:
            self.order_ok = False
        self.next_turn = index + 1
        self.phase = index
        self.starts_seen[index] = (memory_length(memory), 0 if mask is None else mask.shape[1])
        if index > 0:
            self.sums_start[index] = self.checksum(memory, mask)
        if index == self.solver_phase and self.keep_memory:
            self.handoff = ([(k, v) for k, v in memory_layers(memory)], mask)

    def turn_end(self, index, memory, mask):
        if index != self.phase:
            self.order_ok = False
        self.ends_seen[index] = (memory_length(memory), 0 if mask is None else mask.shape[1])
        self.sums_end[index] = self.checksum(memory, mask)
        self.finite &= cache_finite(memory, self.rows, self.device)
        self.phase = None

    def _before(self, module, args, kwargs):
        ids, embeds = kwargs.get("input_ids"), kwargs.get("inputs_embeds")
        if ids is None and embeds is None and args:
            ids = args[0]
        past = kwargs.get("past_key_values")
        new = ids if ids is not None else embeds
        call = {"phase": self.phase, "kind": "ids" if ids is not None else "embeds", "n": int(new.shape[1]),
                "past": memory_length(past)}
        if self.phase is None:
            self.stray += 1
        if ids is not None:
            first_solver_call = self.phase == self.solver_phase and not any(
                c["phase"] == self.solver_phase for c in self.calls[-1:])
            if self.phase != self.solver_phase or first_solver_call:
                mask = kwargs.get("attention_mask")
                call["ids"] = ids.detach().clone()
                call["mask"] = None if mask is None else mask[:, -new.shape[1]:].detach().clone()
        else:
            self._latent(embeds[:, -1])
        self.calls.append(call)

    def _after(self, module, args, kwargs, output):
        hidden = output.last_hidden_state if hasattr(output, "last_hidden_state") else output[0]
        self.prev_hidden = hidden[:, -1].detach()
        self.finite &= torch.isfinite(self.prev_hidden).all(-1)

    def rebuild(self, hidden):
        """The soft mix of `hidden`, derived here: (mix, top ids, weights)."""
        model = self.team.model
        head = model.get_output_embeddings()
        logits = F.linear(hidden.to(model.dtype), head.weight, getattr(head, "bias", None)).float()
        top = logits.topk(TOP_K, dim=-1)
        weights = torch.softmax(top.values / TEMPERATURE, dim=-1)
        table = model.get_input_embeddings().weight
        return torch.einsum("bk,bkd->bd", weights, table[top.indices].float()), top.indices, weights

    def _latent(self, fed):
        hidden = self.prev_hidden
        if hidden is None or hidden.shape[0] != fed.shape[0] or self.phase is None or self.phase >= self.solver_phase:
            self.orphans += 1
            return
        mix, ids, weights = self.rebuild(hidden)
        expected = mix.to(fed.dtype).float()
        error = (fed.float() - expected).norm(dim=-1) / expected.norm(dim=-1).clamp(min=1e-6)
        self.legibility_error = torch.maximum(self.legibility_error, torch.nan_to_num(error, nan=math.inf))
        self.finite &= torch.isfinite(fed).all(-1)
        role = self.roles[self.phase]
        self.record.append((self.phase, ids, weights))
        if self.reference is not None:
            self.distance_sum += self.reference.rmd(hidden, role)
            self.distance_steps += 1
        if self.collect is not None:
            self.collect.add(role, hidden)

    # -------------------------------------------------------------- after the run
    def thought_record(self, row):
        """[(role, [(token id, weight) x 16]) per latent step] of one question. For tests and a
        local debug reader only: never part of an API response, never stored or logged."""
        return [(self.roles[phase], list(zip(ids[row].tolist(), weights[row].tolist())))
                for phase, ids, weights in self.record]

    def top_tokens(self):
        """[rows, latent steps] of each step's top token id (for replay)."""
        if not self.record:
            return torch.zeros(self.rows, 0, dtype=torch.long, device=self.device)
        return torch.stack([ids[:, 0] for _, ids, _ in self.record], dim=1)

    def finish(self, answers, counts, seconds):
        """Run every exact and statistical check; per-row results in self.results."""
        rows, device = self.rows, self.device
        every = torch.ones(rows, dtype=torch.bool, device=device)
        none = torch.zeros(rows, dtype=torch.bool, device=device)
        by_phase = {}
        for call in self.calls:
            by_phase.setdefault(call["phase"], []).append(call)
        thinkers = range(len(self.roles))

        # turn structure: what each turn appended, row by row
        structure = every.clone() if self.order_ok and not self.stray else none.clone()
        for index in thinkers:
            texts = [c for c in by_phase.get(index, []) if c["kind"] == "ids"]
            first = (texts[0]["ids"], texts[0]["mask"]) if texts else None
            last = (texts[-1]["ids"], texts[-1]["mask"]) if len(texts) >= 2 else None
            structure &= _same_rows(first, self.plan.prompts[index], rows, device)
            structure &= _same_rows(last, self.plan.close, rows, device)
        solver_calls = by_phase.get(self.solver_phase, [])
        prompt = (solver_calls[0].get("ids"), solver_calls[0].get("mask")) if solver_calls else None
        structure &= _same_rows(prompt, self.plan.solver, rows, device)

        # span ledger: every call at its planned position, every boundary where planned
        ledger = self.order_ok and not self.stray and not self.orphans
        for index in thinkers:
            start = self.plan.starts[index]
            want = [("ids", self.plan.prompts[index][0].shape[1])] + [("embeds", 1)] * self.steps + \
                   [("ids", self.plan.close[0].shape[1])]
            got = by_phase.get(index, [])
            ledger &= [(c["kind"], c["n"]) for c in got] == want
            position = start
            for c in got:
                ledger &= c["past"] == position
                position += c["n"]
            ledger &= self.starts_seen.get(index) == (start, start)
            ledger &= self.ends_seen.get(index) == (self.plan.starts[index + 1],) * 2
        ledger &= self.starts_seen.get(self.solver_phase) == (self.plan.starts[-1],) * 2
        position = self.plan.starts[-1]
        for number, c in enumerate(solver_calls):
            want_n = self.plan.solver[0].shape[1] if number == 0 else 1
            ledger &= c["kind"] == "ids" and c["n"] == want_n and c["past"] == position
            position += c["n"]

        # memory checksum at every hand-off, row by row
        checksum = every.clone()
        for index in range(1, self.solver_phase + 1):
            end, start = self.sums_end.get(index - 1), self.sums_start.get(index)
            checksum &= none if end is None or start is None or end.shape != start.shape else (end == start).all(-1)

        # configuration
        team = self.team
        claims = self.claims or {}
        configuration = (claims.get("mode") == MODE and claims.get("steps") == self.steps
                         and claims.get("roles") == self.roles and getattr(team, "adapter", None) is None
                         and team.soft_top_k == TOP_K and team.soft_temperature == TEMPERATURE
                         and parameter_names(team.model) == self.weight_names)
        if self.thresholds is not None:
            t = self.thresholds
            configuration &= (t.get("weightsHash") == self.weights_hash and t.get("mode") == MODE
                              and t.get("topK") == TOP_K and t.get("temperature") == TEMPERATURE
                              and t.get("steps") == self.steps)

        # legibility: every planned latent step was rebuilt and matched
        planned_latent = len(self.roles) * self.steps
        legibility = (self.legibility_error <= LEGIBILITY_TOLERANCE) & \
            (every if len(self.record) == planned_latent and not self.orphans else none)

        # budgets
        latent = [sum(c["kind"] == "embeds" for c in by_phase.get(i, [])) for i in thinkers]
        texts = [sum(c["kind"] == "ids" for c in by_phase.get(i, [])) for i in thinkers]
        budget_ok = all(n == self.steps for n in latent) and all(n == 2 for n in texts) and \
            len(solver_calls) <= self.max_new_tokens and (self.time_cap is None or seconds <= self.time_cap)
        tokens = torch.tensor([int(c) for c in counts], device=device)
        budgets = (tokens <= self.max_new_tokens) & (every if budget_ok else none)

        checks = {"turnStructure": structure, "configuration": every if configuration else none,
                  "legibility": legibility, "spanLedger": every if ledger else none, "memoryChecksum": checksum,
                  "numbers": self.finite.clone(), "budgets": budgets}
        raw = self.raw_scores()
        self.results = {"checks": {k: v.tolist() for k, v in checks.items()}, "raw": raw,
                        "latentSteps": sum(latent), "tokens": [int(c) for c in counts]}
        return self.results

    def raw_scores(self):
        """Per row: the degenerate-record score and the mean distance (None when not run)."""
        if not self.record:
            return {"degenerate": [None] * self.rows, "distance": [None] * self.rows}
        junk = junk_table(self.team)
        parts = []
        for phase in range(len(self.roles)):
            steps = [(ids, w) for p, ids, w in self.record if p == phase]
            if not steps:
                continue
            top = torch.stack([ids[:, 0] for ids, _ in steps], dim=1)           # [rows, steps]
            top_w = torch.stack([w[:, 0] for _, w in steps], dim=1)
            repeat = (top[:, 1:] == top[:, :-1]).float().mean(-1) if top.shape[1] > 1 else torch.zeros_like(top_w[:, 0])
            parts.append(((repeat + junk[top].float().mean(-1) + (top_w >= COLLAPSE).float().mean(-1)) / 3))
        degenerate = torch.stack(parts, dim=1).mean(-1)
        distance = (self.distance_sum / self.distance_steps).tolist() if self.distance_steps else [None] * self.rows
        return {"degenerate": degenerate.tolist(), "distance": distance}

    def report(self, row, *, run_id, key, seq=1, squad_id="squad-0", audits=None):
        """The signed, number-only report of one question's squad."""
        results = self.results
        statistical, scores, flags = {}, {}, {}
        for name in reports.SCORES:
            value = results["raw"][name][row]
            spec = (self.thresholds or {}).get(name)
            if spec is None or value is None:
                statistical[name], scores[name], flags[name] = "not-run", 0, False
            else:
                statistical[name], scores[name], flags[name] = "measured", bucket(value, spec["edges"]), \
                    value >= spec["flag"]
        report = {
            "schema": reports.SCHEMA, "runId": run_id, "squadId": squad_id, "seq": seq,
            "thresholdSet": (self.thresholds or {}).get("id", "none"), "weightsHash": self.weights_hash,
            "checks": {name: bool(results["checks"][name][row]) for name in reports.EXACT_CHECKS},
            "counts": {"agents": len(self.roles) + 1, "latentSteps": results["latentSteps"],
                       "textTokens": results["tokens"][row], "handOffs": len(self.roles), "toolCalls": 0},
            "statistical": statistical, "scores": scores, "flags": flags,
            "audits": dict({name: "not-run" for name in reports.AUDITS}, **(audits or {})),
        }
        return reports.sign(report, key)

    def drop(self):
        """Forget the thought record, memory references and per-call ids of this run."""
        self.calls, self.record, self.handoff, self.prev_hidden = [], [], None, None
