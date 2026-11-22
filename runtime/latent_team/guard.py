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
import math
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
    gateway: dict = field(default_factory=dict)  # W2: the run's label and the gateway's counts
    confidence: Optional[float] = None  # W3: the team answer's score when scored, else None


def same_graded_number(before, after):
    """Do two texts grade to the same number, spelled the same?"""
    from .evaluate import predicted_span
    a, b = predicted_span(before), predicted_span(after)
    return a is not None and b is not None and a[0] == b[0] and before[a[1]:a[2]] == after[b[1]:b[2]]


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
                 time_cap=None, sample=None, measure=False, calibration_dir=None, keep_solver_state=False):
        self.team = team
        self.supervisor = supervisor or Supervisor()
        self._thresholds = thresholds          # "auto": the committed set for this model and weights
        self.pinned = None                     # every weights hash a committed set names for this model
        self.reference = reference
        self.measure = measure                 # eval only: keep the audits' raw measurements
        self.calibration_dir = calibration_dir     # W3: None means the committed calibration folder
        self.keep_solver_state = keep_solver_state  # W3's probe (eval only, with measure): kept in memory
        self.audit_every = audit_every
        self.sample = sample or (lambda: secrets.randbelow(self.audit_every) == 0)
        self.time_cap = time_cap
        self.clock = time.monotonic   # the run's time, the gateway's clock too

    def thresholds(self, steps):
        if self._thresholds == "auto":
            from .watchdog import load_thresholds, pinned_hashes, team_weights
            self._thresholds = load_thresholds(self.team.model_name, team_weights(self.team)[0])
            self.pinned = pinned_hashes(self.team.model_name)
        t = self._thresholds
        return t if t is not None and t.get("steps") == steps else None

    def watch(self, questions, steps, max_new_tokens, thresholds=None, reference=None, time_cap=None, **kwargs):
        from .watchdog import Watch
        return Watch(self.team, questions, steps=steps, max_new_tokens=max_new_tokens, thresholds=thresholds,
                     reference=reference, time_cap=self.time_cap if time_cap is None else time_cap,
                     key=secrets.token_bytes(32), pinned=self.pinned, **kwargs)

    def audit(self, questions, steps, max_new_tokens, watch, answers, tolerance, swap=True, over=None):
        """Replay, mismatched memory and solver alone for a batch. Returns (per-row audit words,
        solver-alone answers, measurements for the eval). over: a check of the run's budget, made
        before each later inference stage; a stage past it does not run (review W2-23)."""
        over = over or (lambda: False)
        import torch
        team, rows = self.team, len(questions)
        measured = {}
        started = time.perf_counter()
        again = self.watch(questions, steps, max_new_tokens, keep_memory=True)
        replay_answers, replay_receipt = team.latent_mas(questions, steps=steps, max_new_tokens=max_new_tokens,
                                                         watch=again)
        replay_results = again.finish(replay_answers, replay_receipt.generated_tokens, replay_receipt.seconds)
        top_a, top_b = watch.top_tokens(), again.top_tokens()
        if top_a.shape == top_b.shape and top_a.numel():
            same_top = (top_a == top_b).float().mean(-1)
        elif top_a.shape == top_b.shape and steps == 0:   # no latent step planned: nothing to differ
            same_top = torch.ones(rows, device=team.device)
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
        team._sync()
        measured["replaySeconds"] = time.perf_counter() - started   # the comparisons included
        measured["replayRows"] = rows
        again.drop()

        mismatched = ["not-run"] * rows
        if swap and rows >= 2 and watch.handoff is not None and not over():
            from .team import LATENT_PROMPTS
            started = time.perf_counter()
            with torch.no_grad():   # an audit is inference: no autograd graph through the memory
                memory, mask = rolled_memory(watch.handoff)
                other, _ = team.decode(memory, mask, [LATENT_PROMPTS["solver"].format(question=q) for q in questions],
                                       max_new_tokens, first=False)
            team._sync()
            measured["mismatchedSeconds"] = time.perf_counter() - started
            measured["mismatchedRows"] = rows
            measured["mismatchedAnswers"] = other
            mismatched = ["unchanged" if (predicted_number(o) == predicted_number(a) and predicted_number(a) is not None)
                          or o == a else "changed" for o, a in zip(other, answers)]

        if over():   # no fresh solver-alone inference past the budget
            words = [{"replay": replay[r], "mismatchedMemory": mismatched[r], "solverAlone": "not-run"}
                     for r in range(rows)]
            return words, None, measured
        started = time.perf_counter()
        alone, alone_receipt = team.single(questions, max_new_tokens=max_new_tokens)
        measured["aloneSeconds"] = time.perf_counter() - started
        measured["aloneTokens"] = list(alone_receipt.generated_tokens)
        words = [{"replay": replay[r], "mismatchedMemory": mismatched[r], "solverAlone": agreement(answers[r], alone[r])}
                 for r in range(rows)]
        return words, alone, measured

    def calibration(self, task, steps, max_new_tokens, thresholds, reference, rows=1, gated=False):
        """W3: the committed calibration of this kind of task for these weights, measured with
        this policy (steps, token budget, W1's threshold set, the distance reference on or
        off, questions per call, the gateway in front), or None (uncalibrated). Raises
        abstain.CalibrationInvalid for a calibration file there that cannot be trusted."""
        if not task:
            return None
        from .abstain import CALIBRATION_DIR, load_calibration
        from .watchdog import team_weights
        return load_calibration(self.team.model_name, team_weights(self.team)[0], task, steps=steps,
                                max_new_tokens=max_new_tokens, threshold_set=(thresholds or {}).get("id"),
                                reference=reference is not None, batch=rows, gated=gated,
                                directory=self.calibration_dir or CALIBRATION_DIR)

    def rendered(self, question):
        """Every prompt a guarded run can give the model for one question, as the chat template
        renders it: each role's turn, the solver's, and the solver alone's (audits, fallback)."""
        from .chat_turns import first_turn
        from .team import LATENT_PROMPTS, ROLES, SINGLE_PROMPT
        tokenizer, turns = self.team.tokenizer, self.team.turns
        texts = [first_turn(tokenizer, LATENT_PROMPTS[ROLES[0]].format(question=question))]
        texts += [turns.later(LATENT_PROMPTS[role].format(question=question)) for role in ROLES[1:] + ("solver",)]
        texts.append(first_turn(tokenizer, SINGLE_PROMPT.format(question=question)))
        return texts

    def run(self, questions, steps=40, max_new_tokens=512, audit=None, reference=None, gateways=None, task=None,
            calibration_override=None):
        """One guarded batch. audit: True or False forces the audits; None samples them.

        gateways (W2): one gateway.Gateway per question, its permissions fixed. Each admits the
        question's spans before the squad reads anything, and the squad reads the admitted text
        (placeholders in place of secrets); every answer released passes that gateway's output
        gate, and a broken label rule holds the run. Without gateways the questions are read
        as given (the eval)."""
        if gateways is not None:
            from .gateway import OutputGate, Span
            if len(gateways) != len(questions):
                raise ValueError("one gateway per question")
            # The rows of a batch share one memory object, so one batch is one project.
            if len({g.project for g in gateways}) > 1:
                raise ValueError("one batch never mixes projects: their memories would share tensors")
            # The gateway's budgets were fixed before any data was read; the run keeps to them.
            for g in gateways:
                p = g.permissions
                if steps > p.max_steps or max_new_tokens > p.max_new_tokens:
                    raise ValueError("the run asks for more than the gateway's fixed budgets")
            admitted = [g.admission if g.admission is not None else g.admit([Span("request", "request", q)])
                        for g, q in zip(gateways, questions)]
            questions = [a.text for a in admitted]
            unsafe = []
            for row, (g, question) in enumerate(zip(gateways, questions)):
                try:
                    for text in self.rendered(question):
                        g.check_rendered(text)
                except Exception:   # noqa: BLE001 - a prompt that would carry a known value is never run
                    unsafe.append(row)
            if unsafe:
                return [self._held(steps, "unsafe-render") for _ in questions]
        thresholds = self.thresholds(steps)
        reference = reference if reference is not None else self.reference
        if thresholds is None or not thresholds.get("distance"):
            reference = None
        rows = len(questions)
        # W3: the calibration is chosen before any model call. One that names this task and
        # model but cannot be trusted holds the run. calibration_override is for the eval,
        # which records each run's score without abstaining ({"threshold": -inf}).
        from .abstain import CalibrationInvalid
        try:
            calibration = calibration_override if calibration_override is not None else \
                self.calibration(task, steps, max_new_tokens, thresholds, reference, rows, gateways is not None)
        except CalibrationInvalid:
            return [self._held(steps, "calibration-invalid") for _ in questions]
        # One deadline for the whole run: the guard's own cap and the gateway's, whichever is
        # shorter, for the watchdog's budget check, the audits, the fallback and the release.
        cap = self.time_cap
        if gateways is not None:
            seconds = min(g.permissions.max_seconds for g in gateways)
            cap = seconds if cap is None else min(cap, seconds)
        runs = [self.supervisor.open_run() for _ in range(rows)]
        watch = self.watch(questions, steps, max_new_tokens, thresholds=thresholds, reference=reference,
                           keep_memory=True, time_cap=cap, keep_solver_state=self.keep_solver_state and self.measure)
        started = self.clock()
        if gateways is not None:   # the gateway's budget counts from admission (review W2-20)
            admitted = [g.admitted_at for g in gateways if g.admitted_at is not None]
            if admitted:
                started = min([started] + admitted)
        gates = None if gateways is None else [OutputGate(g) for g in gateways]
        if self._over(started, cap):   # the budget is spent before inference (review W2-21)
            watch.drop()
            return [self._held(steps, "deadline") for _ in range(rows)]
        try:
            outcomes = self._run(questions, steps, max_new_tokens, audit, thresholds, runs, watch, started, gates,
                                 calibration=calibration, cap=cap)
        except Exception:   # noqa: BLE001 - any failure of a guarded stage is a hold, never an answer
            outcomes = [self._held(steps, "runtime-error") for _ in range(rows)]
        finally:
            watch.drop()
        # The release boundary is here, after cleanup: an answer past the deadline holds.
        if self._over(started, cap):
            outcomes = [o if o.answer is None else self._held(steps, "deadline", o.tokens, o.latent_vectors, o.seconds)
                        for o in outcomes]
        if gates is not None:
            for outcome, gateway in zip(outcomes, gateways):
                outcome.gateway = dict(gateway.admission.receipt(), redactions=outcome.gateway.get("redactions", 0))
        return outcomes

    def _held(self, steps, reason, tokens=0, vectors=0, seconds=0.0):
        return Outcome(answer=None, decision=Decision("hold", reason).as_dict(), checks={}, audits={},
                       statistical={}, scores={}, system="latent_mas", tokens=int(tokens), latent_steps=steps,
                       latent_vectors=vectors, seconds=seconds)

    def _extra(self, measured, watch, receipt, row):
        """Eval only (measure=True): the audits' measurements, W3's exploratory scores and the
        solver's hidden state for the probe, all kept in memory."""
        extra = {"measured": measured} if measured else {}
        details = getattr(receipt, "details", None)
        if details:
            values = details[row]["logprobs"]
            extra["meanLogprob"] = sum(values) / len(values) if values else None
            extra["minLogprob"] = min(values) if values else None
        if watch.solver_state is not None:
            extra["solverState"] = watch.solver_state[row].float().cpu()
        return extra

    def _over(self, started, cap):
        return cap is not None and self.clock() - started > cap

    def _run(self, questions, steps, max_new_tokens, audit, thresholds, runs, watch, started, gates=None, cap=None,
             calibration=None):
        from .watchdog import weights_state
        rows = len(questions)
        scored = calibration is not None
        answers, receipt = self.team.latent_mas(questions, steps=steps, max_new_tokens=max_new_tokens, watch=watch,
                                                **({"scores": True} if scored else {}))
        confidences = [None] * rows
        if scored:   # W3: the log-probability of each answer's final number (confidence.py)
            from .confidence import answer_logprob
            # The pieces must join into the decode the answer was cut from, else no score.
            confidences = [answer_logprob(d["pieces"], d["logprobs"], d.get("raw", "")) for d in receipt.details]
        try:
            results = watch.finish(answers, receipt.generated_tokens, receipt.seconds)
        except Exception:   # noqa: BLE001 - the watchdog could not check this run: hold it
            return [self._held(steps, "watchdog-error", receipt.generated_tokens[r], receipt.latent_vectors,
                               receipt.seconds) for r in range(rows)]
        held = [not all(results["checks"][name][r] for name in results["checks"]) for r in range(rows)]
        flagged = False
        if thresholds is not None:
            for name in ("degenerate", "distance"):
                spec = thresholds.get(name)
                values = results["raw"][name]
                flagged |= spec is not None and any(v is not None and v >= spec["flag"] for v in values)
        do_audit = ((self.sample() if audit is None else audit) or flagged) and not self._over(started, cap)
        words, alone, measured = [{}] * rows, None, {}
        if do_audit and not all(held):
            tolerance = (thresholds or {}).get("replayTolerance", REPLAY_TOLERANCE)
            # Another row's memory is lent only between rows of the same label, and with gateways
            # no raw audit text is kept: only the comparison's words.
            labels = {g.admission.label for g in gates and [gate.gateway for gate in gates] or []}
            words, alone, measured = self.audit(questions, steps, max_new_tokens, watch, answers, tolerance,
                                                swap=len(labels) <= 1, over=lambda: self._over(started, cap))
            if gates is not None:
                measured.pop("mismatchedAnswers", None)

        decisions = []
        for row in range(rows):
            try:
                envelope = watch.report(row, run_id=runs[row].run_id, key=runs[row].key, audits=words[row])
            except Exception:   # noqa: BLE001 - an unsigned run has no report: the supervisor holds it
                envelope = None
            if envelope is not None:
                runs[row].submit(envelope)
            broken = gates is not None and gates[row].label_broken()
            if scored:   # row 5: an answer with no number has no score and is never released
                confidence = confidences[row] if confidences[row] is not None else -math.inf
                decisions.append(runs[row].decide(calibrated=True, label_broken=broken, confidence=confidence,
                                                  threshold=calibration["threshold"]))
            else:
                decisions.append(runs[row].decide(calibrated=False, label_broken=broken))
        fallback_rows = [r for r, d in enumerate(decisions) if d.action == "fallback"]
        fallback = {}
        if fallback_rows and alone is None and self._over(started, cap):
            # No fresh inference past the deadline (review W2-22): the fallback fails, unrun.
            for r in fallback_rows:
                decisions[r] = runs[r].after_fallback(within_limits=False)
            fallback_rows = []
        if fallback_rows:
            # Once, with tools off, inside the same fence: its budget and time are checked
            # before it may be released.
            fallback_started = time.perf_counter()
            if alone is None:
                texts, fallback_receipt = self.team.single([questions[r] for r in fallback_rows],
                                                           max_new_tokens=max_new_tokens)
                tokens, seconds = fallback_receipt.generated_tokens, time.perf_counter() - fallback_started
            else:
                texts, tokens = [alone[r] for r in fallback_rows], [measured["aloneTokens"][r] for r in fallback_rows]
                seconds = measured["aloneSeconds"]
            fallback = {r: (t, n) for r, t, n in zip(fallback_rows, texts, tokens)}
            # The fallback must come from the model the watchdog cleared: version counters only
            # grow, so equal state now means no weight changed since the run began.
            same_model = weights_state(self.team.model) == watch.weight_state
            for r, text, count in zip(fallback_rows, texts, tokens):
                within = isinstance(text, str) and 0 <= int(count) <= max_new_tokens and same_model and \
                    (cap is None or seconds <= cap) and not self._over(started, cap)
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
            redactions = 0
            if answer is not None and gates is not None:
                # The output gate: the scanner over the final text, then placeholders put back
                # only for a cleared output. A fallback answer passes it too.
                released = gates[row].release(answer)
                answer, redactions = released.text, released.redactions
                if not released.safe:   # the output gate could not clear the text: nothing leaves
                    answer, decision = None, Decision("hold", "output-unsafe", decision.marks, decision.quarantined)
                elif released.marks:
                    decision = Decision(decision.action, decision.reason, decision.marks + released.marks,
                                        decision.quarantined)
                # W3: a scored team answer is released on the score of the number it is graded
                # on; when the gate changed that number (a redaction, a value put back), the
                # score is of a number no reader sees, so the run abstains (review W3-3).
                if answer is not None and scored and system == "latent_mas" and \
                        not same_graded_number(answers[row], answer):
                    answer, decision = None, Decision("abstain", "number-changed", decision.marks, decision.quarantined)
            # The run's budget holds until the answer leaves, output gate included (review W2-20).
            if answer is not None and self._over(started, cap):
                answer, decision = None, Decision("hold", "deadline", decision.marks, decision.quarantined)
            outcomes.append(Outcome(
                answer=answer, decision=decision.as_dict(), gateway={"redactions": redactions},
                checks=dict(report["checks"]) if report else {n: bool(results["checks"][n][row])
                                                              for n in results["checks"]},
                audits=dict(report["audits"]) if report else {}, statistical=dict(report["statistical"]) if report else {},
                scores=dict(report["scores"]) if report else {}, system=system, tokens=int(tokens),
                latent_steps=steps, latent_vectors=receipt.latent_vectors, seconds=receipt.seconds,
                confidence=confidences[row] if system == "latent_mas" else None,
                extra=self._extra(measured, watch, receipt, row) if self.measure else {}))
        return outcomes
