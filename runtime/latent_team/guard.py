"""W1: one guarded run of the latent squad: watchdog, audits and the supervisor's decision.

    guard = Guard(team)
    outcomes = guard.run(questions, steps=40, max_new_tokens=512)

Each question is one run with one squad (planner, critic, refiner and solver). The
watchdog checks every hand-off and writes one signed report per question; the supervisor
verifies it and decides by its fail-closed table (supervisor.py). A hold returns no
answer. A fallback runs the solver alone in text once and releases that, marked.

Audits run on a sample of runs (1 in AUDIT_EVERY, drawn with `secrets`, so a caller cannot
predict which; the receipt says afterwards) and on every flagged run:
  replay            the squad again from the same inputs in a fresh memory, with the same
                    batch layout: same answer, same top token at every latent step, and the
                    memory at each hand-off within REPLAY_TOLERANCE
  mismatched memory the solver given another question's memory (rows of the batch rolled
                    by one; needs two or more questions): does the answer change?
  solver alone      `single`: do team and solver give the same final number?

Nothing here is written to disk. The watchdog's thought record and memory references are
dropped once the decision is made.
"""
import secrets
import time
from dataclasses import dataclass, field
from typing import Optional

from .evaluate import predicted_number
from .supervisor import Decision, Supervisor

AUDIT_EVERY = 20
REPLAY_TOLERANCE = 0.0   # until eval 3 measures it; a threshold set may carry its own


@dataclass
class Outcome:
    answer: Optional[str]          # None when held
    decision: dict                 # Decision.as_dict()
    checks: dict                   # exact check name -> bool
    audits: dict                   # audit name -> listed word
    statistical: dict              # score name -> "measured" | "not-run"
    scores: dict                   # score name -> bucket 0 to 9
    system: str                    # "latent_mas", or "single" for a fallback answer
    tokens: int
    latent_steps: int
    latent_vectors: int
    seconds: float
    extra: dict = field(default_factory=dict)


def agreement(a, b):
    """'agree' when both texts end in the same number, 'disagree' when they end in different
    ones, 'not-comparable' when either has none."""
    x, y = predicted_number(a), predicted_number(b)
    if x is None or y is None:
        return "not-comparable"
    return "agree" if abs(x - y) < 1e-6 else "disagree"


def memory_difference(a, b, starts):
    """(diff, mask_differs) of two solver hand-offs (watch.handoff), row by row.

    diff [rows, thinkers]: the largest absolute key or value difference over each thinker's
    span, read only at positions where both rows hold a real token, so a padding difference
    never stands in for a value difference. mask_differs [rows]: the rows' masks differ.
    Shapes that differ make every row inf and True."""
    import torch
    layers_a, mask_a = a
    layers_b, mask_b = b
    rows = mask_a.shape[0]
    spans = list(zip(starts[:-1], starts[1:]))
    out = torch.zeros(rows, len(spans), device=mask_a.device)
    shapes = len(layers_a) == len(layers_b) and mask_a.shape == mask_b.shape and all(
        ka.shape == kb.shape and va.shape == vb.shape for (ka, va), (kb, vb) in zip(layers_a, layers_b))
    if not shapes:
        return out.fill_(float("inf")), torch.ones(rows, dtype=torch.bool, device=mask_a.device)
    mask_differs = (mask_a != mask_b).any(-1)
    both = (mask_a.bool() & mask_b.bool())[:, None, :, None]          # [rows, 1, positions, 1]
    for (ka, va), (kb, vb) in zip(layers_a, layers_b):
        for index, (lo, hi) in enumerate(spans):
            for x, y in ((ka, kb), (va, vb)):
                gap = (x[:, :, lo:hi].float() - y[:, :, lo:hi].float()).abs() * both[:, :, lo:hi]
                out[:, index] = torch.maximum(out[:, index], gap.flatten(1).amax(-1))
    return out, mask_differs


def rolled_memory(handoff):
    """The solver hand-off with its rows rolled by one: row i gets question i-1's memory."""
    from transformers import DynamicCache
    layers, mask = handoff
    memory = DynamicCache()
    for index, (keys, values) in enumerate(layers):
        memory.update(keys.roll(1, 0), values.roll(1, 0), index)
    return memory, mask.roll(1, 0)


class Guard:
    def __init__(self, team, supervisor=None, thresholds="auto", reference=None, audit_every=AUDIT_EVERY,
                 time_cap=None, sample=None, measure=False):
        self.team = team
        self.supervisor = supervisor or Supervisor()
        self._thresholds = thresholds          # "auto": the committed set for this model and weights
        self.pinned = None                     # every weights hash a committed set names for this model
        self.reference = reference
        self.measure = measure                 # eval only: keep the audits' raw measurements
        self.audit_every = audit_every
        self.sample = sample or (lambda: secrets.randbelow(self.audit_every) == 0)
        self.time_cap = time_cap

    def thresholds(self, steps):
        if self._thresholds == "auto":
            from .watchdog import load_thresholds, pinned_hashes, team_weights
            self._thresholds = load_thresholds(self.team.model_name, team_weights(self.team)[0])
            self.pinned = pinned_hashes(self.team.model_name)
        t = self._thresholds
        return t if t is not None and t.get("steps") == steps else None

    def watch(self, questions, steps, max_new_tokens, thresholds=None, reference=None, **kwargs):
        from .watchdog import Watch
        return Watch(self.team, questions, steps=steps, max_new_tokens=max_new_tokens, thresholds=thresholds,
                     reference=reference, time_cap=self.time_cap, key=secrets.token_bytes(32), pinned=self.pinned,
                     **kwargs)

    def audit(self, questions, steps, max_new_tokens, watch, answers, tolerance):
        """Replay, mismatched memory and solver alone for a batch. Returns (per-row audit words,
        solver-alone answers, measurements for the eval)."""
        import torch
        team, rows = self.team, len(questions)
        measured = {}
        started = time.perf_counter()
        again = self.watch(questions, steps, max_new_tokens, keep_memory=True)
        replay_answers, replay_receipt = team.latent_mas(questions, steps=steps, max_new_tokens=max_new_tokens,
                                                         watch=again)
        replay_results = again.finish(replay_answers, replay_receipt.generated_tokens, replay_receipt.seconds)
        measured["replaySeconds"] = time.perf_counter() - started
        top_a, top_b = watch.top_tokens(), again.top_tokens()
        if top_a.shape == top_b.shape and top_a.numel():
            same_top = (top_a == top_b).float().mean(-1)
        else:
            same_top = torch.zeros(rows, device=team.device)
        # Every hand-off, as each recipient received it: a change made before one hand-off
        # and undone before the next is still seen.
        turns = range(1, len(watch.roles) + 1)
        diff = torch.full((rows, len(watch.roles)), float("inf"), device=team.device)
        mask_differs = torch.ones(rows, dtype=torch.bool, device=team.device)
        if all(t in watch.boundaries and t in again.boundaries for t in turns):
            mask_differs = torch.zeros(rows, dtype=torch.bool, device=team.device)
            for column, turn in enumerate(turns):
                gap, differs = memory_difference(watch.boundaries[turn], again.boundaries[turn],
                                                 [0, watch.plan.starts[turn]])
                diff[:, column] = gap[:, 0]
                mask_differs |= differs
        same_answer = [x == y for x, y in zip(answers, replay_answers)]
        replay_clean = [all(replay_results["checks"][name][r] for name in replay_results["checks"]) for r in range(rows)]
        measured.update(sameAnswer=same_answer, sameTopShare=same_top.tolist(), memoryDiff=diff.tolist(),
                        maskDiffers=mask_differs.tolist(), replayClean=replay_clean)
        replay = ["match" if same_answer[r] and same_top[r] == 1 and not mask_differs[r] and replay_clean[r]
                  and bool(torch.isfinite(diff[r]).all()) and bool((diff[r] <= tolerance).all()) else "mismatch"
                  for r in range(rows)]
        again.drop()

        mismatched = ["not-run"] * rows
        if rows >= 2 and watch.handoff is not None:
            from .team import LATENT_PROMPTS
            started = time.perf_counter()
            with torch.no_grad():   # an audit is inference: no autograd graph through the memory
                memory, mask = rolled_memory(watch.handoff)
                other, _ = team.decode(memory, mask, [LATENT_PROMPTS["solver"].format(question=q) for q in questions],
                                       max_new_tokens, first=False)
            team._sync()
            measured["mismatchedSeconds"] = time.perf_counter() - started
            measured["mismatchedAnswers"] = other
            mismatched = ["unchanged" if (predicted_number(o) == predicted_number(a) and predicted_number(a) is not None)
                          or o == a else "changed" for o, a in zip(other, answers)]

        started = time.perf_counter()
        alone, alone_receipt = team.single(questions, max_new_tokens=max_new_tokens)
        measured["aloneSeconds"] = time.perf_counter() - started
        measured["aloneTokens"] = list(alone_receipt.generated_tokens)
        words = [{"replay": replay[r], "mismatchedMemory": mismatched[r], "solverAlone": agreement(answers[r], alone[r])}
                 for r in range(rows)]
        return words, alone, measured

    def run(self, questions, steps=40, max_new_tokens=512, audit=None, reference=None):
        """One guarded batch. audit: True or False forces the audits; None samples them."""
        thresholds = self.thresholds(steps)
        reference = reference if reference is not None else self.reference
        if thresholds is None or not thresholds.get("distance"):
            reference = None
        rows = len(questions)
        runs = [self.supervisor.open_run() for _ in range(rows)]
        watch = self.watch(questions, steps, max_new_tokens, thresholds=thresholds, reference=reference,
                           keep_memory=True)
        try:
            return self._run(questions, steps, max_new_tokens, audit, thresholds, runs, watch)
        finally:
            watch.drop()

    def _run(self, questions, steps, max_new_tokens, audit, thresholds, runs, watch):
        rows = len(questions)
        answers, receipt = self.team.latent_mas(questions, steps=steps, max_new_tokens=max_new_tokens, watch=watch)
        try:
            results = watch.finish(answers, receipt.generated_tokens, receipt.seconds)
        except Exception:   # noqa: BLE001 - the watchdog could not check this run: hold it
            return [Outcome(answer=None, decision=Decision("hold", "watchdog-error").as_dict(), checks={}, audits={},
                            statistical={}, scores={}, system="latent_mas", tokens=int(receipt.generated_tokens[r]),
                            latent_steps=steps, latent_vectors=receipt.latent_vectors, seconds=receipt.seconds)
                    for r in range(rows)]
        held = [not all(results["checks"][name][r] for name in results["checks"]) for r in range(rows)]
        flagged = False
        if thresholds is not None:
            for name in ("degenerate", "distance"):
                spec = thresholds.get(name)
                values = results["raw"][name]
                flagged |= spec is not None and any(v is not None and v >= spec["flag"] for v in values)
        do_audit = (self.sample() if audit is None else audit) or flagged
        words, alone, measured = [{}] * rows, None, {}
        if do_audit and not all(held):
            tolerance = (thresholds or {}).get("replayTolerance", REPLAY_TOLERANCE)
            words, alone, measured = self.audit(questions, steps, max_new_tokens, watch, answers, tolerance)

        decisions = []
        for row in range(rows):
            try:
                envelope = watch.report(row, run_id=runs[row].run_id, key=runs[row].key, audits=words[row])
            except Exception:   # noqa: BLE001 - an unsigned run has no report: the supervisor holds it
                envelope = None
            if envelope is not None:
                runs[row].submit(envelope)
            decisions.append(runs[row].decide(calibrated=False))
        fallback_rows = [r for r, d in enumerate(decisions) if d.action == "fallback"]
        fallback = {}
        if fallback_rows:
            # Once, with tools off, inside the same fence: its budget and time are checked
            # before it may be released.
            started = time.perf_counter()
            if alone is None:
                texts, fallback_receipt = self.team.single([questions[r] for r in fallback_rows],
                                                           max_new_tokens=max_new_tokens)
                tokens, seconds = fallback_receipt.generated_tokens, time.perf_counter() - started
            else:
                texts, tokens = [alone[r] for r in fallback_rows], [measured["aloneTokens"][r] for r in fallback_rows]
                seconds = measured["aloneSeconds"]
            fallback = {r: (t, n) for r, t, n in zip(fallback_rows, texts, tokens)}
            for r, text, count in zip(fallback_rows, texts, tokens):
                within = isinstance(text, str) and 0 <= int(count) <= max_new_tokens and \
                    (self.time_cap is None or seconds <= self.time_cap)
                decisions[r] = runs[r].after_fallback(within_limits=within)

        outcomes = []
        for row in range(rows):
            report = runs[row].reports.get("squad-0")
            decision = decisions[row]
            if row in fallback and decision.action == "release":
                (answer, tokens), system = fallback[row], "single"
            else:
                # Only a release carries an answer: a hold, and an abstention (W3), give none.
                answer = answers[row] if decision.action == "release" else None
                system, tokens = "latent_mas", receipt.generated_tokens[row]
            outcomes.append(Outcome(
                answer=answer, decision=decision.as_dict(),
                checks=dict(report["checks"]) if report else {n: bool(results["checks"][n][row])
                                                              for n in results["checks"]},
                audits=dict(report["audits"]) if report else {}, statistical=dict(report["statistical"]) if report else {},
                scores=dict(report["scores"]) if report else {}, system=system, tokens=int(tokens),
                latent_steps=steps, latent_vectors=receipt.latent_vectors, seconds=receipt.seconds,
                extra={"measured": measured} if measured and self.measure else {}))
        return outcomes
