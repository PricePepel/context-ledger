"""W1: the watchdog of one latent squad (docs/watchdog-security.md, "The watchdog").

Plain code: no model call. It multiplies the frozen head and embedding table to rebuild a
soft thought, which is linear algebra on weights, and never runs the transformer or reads
squad output as instructions.

How it watches. `LatentTeam.latent_mas(..., watch=w)` registers two hooks on the model's
base and tells the watchdog where each turn starts and ends (`turn_start`, `turn_end`),
which gives the order of turns and the lengths the runtime claims. Everything else is
taken in the hooks, from what the transformer receives and returns: the token ids or fed
vector, the memory object, the attention mask and position ids, the hidden state, and the
memory checksums (at a turn's first call, and from the output of a thinker's closing
call). So a change between two turns is seen wherever the runtime makes it.

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
  spanLedger      every call appended what the plan says, at the planned position; the
                  memory part of every attention mask is the mask already seen and the
                  position ids count real tokens only (no hidden span, no shifted position)
  memoryChecksum  one memory object for the run, and a keyed checksum of the memory as the
                  model wrote it at the end of one turn equals the one it reads at the
                  start of the next
  numbers         no NaN or infinity in thoughts, hidden states or the cache
  budgets         m latent steps per thinker, no text from a thinker, the solver within
                  its token budget, wall time within its cap. A W1 squad has no tool
                  handle, so its tool count is 0 by construction; W2's tool gate counts
                  calls where tools exist

Not covered: a change made to the memory in place in the middle of a turn, between two
latent steps, and a rewrite of the answer text after decoding. Both need code inside the
runtime, which is trusted (docs/watchdog-security.md, "Trust assumptions"); a sampled
replay sees the first when it is not deterministic.

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
def _weights(model):
    named = dict(model.named_buffers())
    named.update(model.named_parameters())
    return named


def weights_fingerprint(model):
    """(SHA-256 of every parameter and buffer in name order, the tuple of parameter names,
    and the state of every parameter and buffer).

    Computed once per loaded model; LatentTeam.load_checkpoints drops it. The names show a
    LoRA or any other module added later. The state (name, storage address, in-place version
    counter, dtype and shape of each tensor) shows a tensor replaced or edited in place after
    hashing, so a stale hash never passes; it is compared when a run starts and again when
    its checks run, so an edit during a turn is seen too."""
    digest = hashlib.sha256()
    named = _weights(model)
    for name in sorted(named):
        tensor = named[name].detach()
        digest.update(f"{name}|{tensor.dtype}|{tuple(tensor.shape)}|".encode())
        digest.update(tensor.contiguous().reshape(-1).view(torch.uint8).cpu().numpy())
    return digest.hexdigest(), parameter_names(model), weights_state(model)


def parameter_names(model):
    return tuple(name for name, _ in model.named_parameters())


def weights_state(model):
    """Who each weight is and whether it was touched: no copy of any value."""
    named = _weights(model)
    return tuple((name, named[name].data_ptr(), named[name]._version, str(named[name].dtype),
                  tuple(named[name].shape)) for name in sorted(named))


def names_digest(names):
    return hashlib.sha256(chr(10).join(names).encode()).hexdigest()


def team_weights(team):
    cached = getattr(team, "_w1_weights", None)
    if cached is None:
        cached = weights_fingerprint(team.model)
        team._w1_weights = cached
    return cached


# ------------------------------------------------------------------ memory
def memory_layers(memory):
    """[(keys, values)] of a DynamicCache, each [batch, heads, length, head dim].

    The supported contract is the one this runtime pins (transformers 5.x): a cache with
    `.layers` whose items have `.keys` and `.values`. faults.py uses the same contract.
    Anything else raises, and a raise inside the watchdog fails every check (Watch._guarded)."""
    if memory is None:
        return []
    if not hasattr(memory, "layers"):
        raise TypeError("the watchdog supports caches with .layers (transformers 5.x DynamicCache)")
    return [(layer.keys, layer.values) for layer in memory.layers
            if getattr(layer, "keys", None) is not None and layer.keys.numel()]


def memory_length(memory):
    return 0 if memory is None else int(memory.get_seq_length())


class Checksum:
    """A keyed corruption detector for a working memory, per row, computed on the device.

    Every key and value is read as 16-bit words w (bit patterns, so the arithmetic is exact),
    and the checksum is sum(w * a_D * e_S * c_H * l_layer) mod P. The coefficients come from
    a PRNG seeded by an HMAC of the run's key. With truly uniform coefficients, a change
    chosen without knowing the key would go unseen with chance at most 5/P per sketch
    (Schwartz-Zippel), and two sketches are kept; the PRNG approximates that, so read it as
    a probabilistic detector of changes made independently of the key, not as a MAC. The
    layout (number of layers, shapes, dtypes) is compared exactly beside it. It is
    deterministic on one backend and one implementation. It shows the memory did not change
    between two points, not that it was right."""

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

    @staticmethod
    def layout(memory, mask):
        return (tuple((tuple(k.shape), str(k.dtype), tuple(v.shape), str(v.dtype)) for k, v in memory_layers(memory)),
                None if mask is None else tuple(mask.shape))

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
    def load(cls, path, device="cpu", weights_hash=None):
        with open(path, "rb") as handle:
            return cls.from_bytes(handle.read(), device=device, weights_hash=weights_hash)

    @classmethod
    def from_bytes(cls, blob, device="cpu", weights_hash=None):
        """A reference from its file's bytes. With weights_hash, one built on other weights is
        refused: its statistics describe another model."""
        import io
        data = torch.load(io.BytesIO(blob), map_location="cpu", weights_only=True)
        reference = cls(data["means"], data["whiten"], data["pooledMean"], data["pooledWhiten"], data["meta"])
        if weights_hash is not None and reference.meta.get("weightsHash") != weights_hash:
            raise ValueError("this reference was built on other weights")
        return reference.to(device)


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


def pinned_hashes(model_name, directory=THRESHOLD_DIR):
    """Every weights hash a committed threshold set names for this model. When there is one,
    a run on any other weights fails the configuration check: its thresholds are void."""
    found = set()
    if os.path.isdir(directory):
        for name in sorted(os.listdir(directory)):
            if name.endswith(".json"):
                with open(os.path.join(directory, name), encoding="utf-8") as handle:
                    data = json.load(handle)
                if data.get("model") == model_name and isinstance(data.get("weightsHash"), str):
                    found.add(data["weightsHash"])
    return frozenset(found)


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
    prompts (team.LATENT_PROMPTS) and the template's turn strings (team.turns), not from
    LatentTeam.render. The turn strings themselves are checked for a preamble repeated in a
    later turn and for an empty close (template_ok)."""

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
        # The plan reads the template's turn strings (team.turns); check them on their own: the
        # first turn is a preamble followed by a later turn, a later turn never repeats that
        # preamble, and the close is not empty.
        sample = LATENT_PROMPTS[roles[0]].format(question=questions[0]) if questions else ""
        first, later = first_turn(tokenizer, sample), team.turns.later(sample)
        head = first[:-len(later)] if later and first.endswith(later) else None
        self.template_ok = bool(team.turns.close) and head is not None and (not head or head not in later)
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
                 time_cap=None, key=None, keep_memory=False, collect=None, pinned=None, keep_solver_state=False):
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
        self.weights_hash, self.weight_names, self.weight_state = team_weights(team)
        self.pinned = frozenset(pinned or ())   # every weights hash a threshold set names for this model
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
        self.phase_calls = 0
        self.cache, self.same_cache = None, True
        self.running_mask = torch.zeros(rows, 0, dtype=torch.long, device=device)
        self.boundary_ok = torch.ones(rows, dtype=torch.bool, device=device)
        self.handoff = None           # (layers, mask) the solver received, when keep_memory
        self.keep_solver_state = keep_solver_state
        self.solver_state = None      # W3's probe: the solver's last hidden state after its prompt
        self.boundaries = {}          # turn -> (layers, mask) it received, when keep_memory
        self.layouts_start, self.layouts_end = {}, {}
        self.broken = 0               # exceptions inside the watchdog: each fails every check
        self.last_kind = None
        self.claims = None            # what latent_mas said it would run
        self.handles = []
        self.results = None

    # -------------------------------------------------------------- runtime boundary
    def attach(self, team, *, roles, mode, steps, max_new_tokens, views=None, solver_questions=None, sealed=False):
        if team is not self.team:
            raise ValueError("this watchdog was planned for another team")
        if views is not None or solver_questions is not None or sealed:
            raise ValueError("the watchdog plans the standard squad: every agent sees the question, nothing sealed")
        # What is in effect for this run, taken now: a setting changed back afterwards must not
        # make the run look clean.
        self.claims = {"roles": tuple(roles), "mode": mode, "steps": steps, "maxNewTokens": max_new_tokens,
                       "adapter": getattr(team, "adapter", None) is not None, "topK": team.soft_top_k,
                       "temperature": team.soft_temperature, "names": parameter_names(team.model),
                       "lora": any("lora_" in name for name in parameter_names(team.model)),
                       "state": weights_state(team.model)}
        base = team.model.base_model
        self.handles = [base.register_forward_pre_hook(self._guarded(self._before), with_kwargs=True),
                        base.register_forward_hook(self._guarded(self._after), with_kwargs=True)]

    def _guarded(self, hook):
        """A hook that never raises into the model: any error inside the watchdog is counted
        and fails every exact check, so the run is held, not crashed half-checked."""
        def guarded(*args):
            try:
                hook(*args)
            except Exception:   # noqa: BLE001 - fail closed on any watchdog error
                self.broken += 1
            return None
        return guarded

    def detach(self):
        for handle in self.handles:
            handle.remove()
        self.handles = []
        self.phase = None

    # The team calls turn_start and turn_end at its hand-offs; they give the order of turns
    # and the lengths the runtime claims. Every check of the memory itself is taken in the
    # hooks, from what the model receives and returns: the start checksum at the first call
    # of a turn, the end checksum from the output of a thinker's closing call. So a change
    # made anywhere between two turns (in think, forward, decode or the hand-off) is seen.
    def turn_start(self, index, memory, mask):
        if index != self.next_turn:
            self.order_ok = False
        self.next_turn = index + 1
        self.phase = index
        self.phase_calls = 0
        self.starts_seen[index] = (memory_length(memory), 0 if mask is None else mask.shape[1])

    def turn_end(self, index, memory, mask):
        if index != self.phase:
            self.order_ok = False
        self.ends_seen[index] = (memory_length(memory), 0 if mask is None else mask.shape[1])
        self.finite &= cache_finite(memory, self.rows, self.device)
        self.phase = None

    def _before(self, module, args, kwargs):
        ids, embeds = kwargs.get("input_ids"), kwargs.get("inputs_embeds")
        if ids is None and embeds is None and args:
            ids = args[0]
        past = kwargs.get("past_key_values")
        full = kwargs.get("attention_mask")
        new = ids if ids is not None else embeds
        n = int(new.shape[1])
        call = {"phase": self.phase, "kind": "ids" if ids is not None else "embeds", "n": n,
                "past": memory_length(past)}
        if self.phase is None:
            self.stray += 1
        # One working memory per run, updated in place: every call must get that object.
        if self.cache is None:
            self.cache = past
        elif past is not self.cache:
            self.same_cache = False
        # The memory part of the mask must be the mask the model already saw, and the
        # positions must count only real tokens: no hidden span, no shifted position.
        if full is None or full.shape[1] != call["past"] + n or self.running_mask.shape[1] != call["past"]:
            self.boundary_ok &= False
        else:
            self.boundary_ok &= (full[:, :-n] == self.running_mask).all(-1)
            # The new columns: a latent step or a decode step appends one real token for every
            # row (a prompt or close is compared with the plan's own mask in turnStructure).
            if embeds is not None or (self.phase == self.solver_phase and self.phase_calls > 0):
                self.boundary_ok &= (full[:, -n:] == 1).all(-1)
            positions = kwargs.get("position_ids")
            expected = (full.cumsum(-1) - 1).clamp(min=0)[:, -n:]
            self.boundary_ok &= (positions == expected).all(-1) if positions is not None and \
                positions.shape == expected.shape else torch.zeros_like(self.boundary_ok)
            where = kwargs.get("cache_position")
            if where is not None:
                self.boundary_ok &= bool(torch.equal(where.reshape(-1).cpu(),
                                                     torch.arange(call["past"], call["past"] + n)))
            self.running_mask = full
        first = self.phase is not None and self.phase_calls == 0
        prefix = full[:, :-n] if full is not None else None
        if first and self.phase > 0:
            self.sums_start[self.phase] = self.checksum(past, prefix)
            self.layouts_start[self.phase] = Checksum.layout(past, prefix)
            if self.keep_memory:   # references only: the cache grows by new tensors, so these stay as they were
                self.boundaries[self.phase] = ([(k, v) for k, v in memory_layers(past)], prefix)
        if first and self.phase == self.solver_phase and self.keep_memory:
            self.handoff = self.boundaries.get(self.phase)
        if ids is not None:
            if self.phase != self.solver_phase or first:
                call["ids"] = ids.detach().clone()
                call["mask"] = None if full is None else full[:, -n:].detach().clone()
        else:
            self._latent(embeds[:, -1])
        if self.phase is not None:
            self.phase_calls += 1
        self.last_kind = call["kind"]
        self.calls.append(call)

    def _after(self, module, args, kwargs, output):
        hidden = output.last_hidden_state if hasattr(output, "last_hidden_state") else output[0]
        self.prev_hidden = hidden[:, -1].detach()
        if self.keep_solver_state and self.phase == self.solver_phase and self.phase_calls == 1:
            self.solver_state = self.prev_hidden.clone()
        self.finite &= torch.isfinite(self.prev_hidden).all(-1)
        closing = self.phase is not None and self.phase < self.solver_phase and self.phase_calls > 1 and \
            self.last_kind == "ids"
        if closing:   # the latest text call of a thinker's turn: its close, unless more follows
            self.sums_end[self.phase] = self.checksum(output.past_key_values, kwargs.get("attention_mask"))
            self.layouts_end[self.phase] = Checksum.layout(output.past_key_values, kwargs.get("attention_mask"))

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
        if not self.plan.template_ok:
            structure &= none

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

        # memory checksum at every hand-off, row by row, and one memory object for the run
        checksum = every.clone() if self.same_cache else none.clone()
        for index in range(1, self.solver_phase + 1):
            end, start = self.sums_end.get(index - 1), self.sums_start.get(index)
            checksum &= none if end is None or start is None or end.shape != start.shape else (end == start).all(-1)
            if self.layouts_end.get(index - 1) is None or self.layouts_end.get(index - 1) != self.layouts_start.get(index):
                checksum &= none
        # the whole cache after the solver, its new keys and values included
        self.finite &= cache_finite(self.cache, rows, device) if self.cache is not None else none

        # configuration
        claims = self.claims or {}
        configuration = (claims.get("mode") == MODE and claims.get("steps") == self.steps
                         and claims.get("roles") == self.roles and claims.get("adapter") is False
                         and claims.get("topK") == TOP_K and claims.get("temperature") == TEMPERATURE
                         and claims.get("names") == self.weight_names and not claims.get("lora")
                         and claims.get("state") == self.weight_state
                         and weights_state(self.team.model) == self.weight_state)
        if self.pinned:
            configuration &= self.weights_hash in self.pinned
        if self.thresholds is not None:
            t = self.thresholds
            configuration &= (t.get("weightsHash") == self.weights_hash and t.get("mode") == MODE
                              and t.get("topK") == TOP_K and t.get("temperature") == TEMPERATURE
                              and t.get("steps") == self.steps
                              and t.get("parameterNames", names_digest(self.weight_names)) == names_digest(
                                  self.weight_names))

        # legibility: every planned latent step was rebuilt and matched
        planned_latent = len(self.roles) * self.steps
        legibility = (self.legibility_error <= LEGIBILITY_TOLERANCE) & \
            (every if len(self.record) == planned_latent and not self.orphans else none)

        # budgets
        latent = [sum(c["kind"] == "embeds" for c in by_phase.get(i, [])) for i in thinkers]
        texts = [sum(c["kind"] == "ids" for c in by_phase.get(i, [])) for i in thinkers]
        budget_ok = all(n == self.steps for n in latent) and all(n == 2 for n in texts) and \
            len(solver_calls) <= self.max_new_tokens and (self.time_cap is None or seconds <= self.time_cap)
        # The decode calls must account for the tokens reported (LatentTeam.decode): every
        # appended step but the last is fed back, and the last is fed too unless the token
        # budget ended the loop. So a decode that stops calling the model early, or reports
        # tokens it never produced, fails here.
        longest = max((int(c) for c in counts), default=0)
        fed = longest - 1 if longest == self.max_new_tokens else longest
        budget_ok &= len(solver_calls) == 1 + max(fed, 0)
        tokens = torch.tensor([int(c) for c in counts], device=device)
        budgets = (tokens <= self.max_new_tokens) & (every if budget_ok else none)

        if self.broken:   # an error inside the watchdog: nothing it checked can be trusted
            structure, configuration, legibility, ledger = none.clone(), False, none.clone(), False
            checksum, budgets = none.clone(), none.clone()
            self.finite &= none
        checks = {"turnStructure": structure, "configuration": every if configuration else none,
                  "legibility": legibility, "spanLedger": (every if ledger else none) & self.boundary_ok,
                  "memoryChecksum": checksum,
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
        """Forget everything of this run but its results: the thought record, the memory and
        its references, the per-call ids, the plan (the prompts' token ids), the questions,
        the checksum key and the raw scores."""
        self.calls, self.record, self.handoff, self.prev_hidden = [], [], None, None
        self.cache, self.running_mask, self.plan, self.questions, self.checksum = None, None, None, [], None
        self.boundaries = {}
        self.solver_state = None
        if self.results is not None:
            self.results.pop("raw", None)
