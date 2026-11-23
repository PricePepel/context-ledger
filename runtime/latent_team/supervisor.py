"""W1: the supervisor. One per run, plain code: no model reads anything here.

It receives every squad's signed report, then decides. Fail closed; the first row that
applies wins (docs/watchdog-security.md, "The supervisor"):

  1  a watchdog exact check failed, or a label rule was broken   hold (the reason, no answer)
  2  a report is missing, unsigned, malformed, from another run,  hold
     replayed or late
  3  a tool call broke the allowlist, an argument rule or a       the call is not sent; the run
     budget                                                       goes on, marked tool-refused
  4  a statistical flag, weak signals adding up across squads,    fall back once to the solver
     or an audit disagrees                                        alone in text
  5  confidence under the calibrated threshold                    abstain
  6  a citation fails the quote check                             release, marked unverified
  7  no calibration set for this kind of task                     release, marked uncalibrated
  8  everything passed                                            release

A release whose statistical checks did not run (no threshold set for these weights and
steps) is also marked unscreened.

It never repairs and never names a guilty agent: it holds or replaces the whole squad's
output. It keeps long-run counts per weights hash in memory, for drift alarms; nothing
here is written to disk.
"""
import time
from collections import Counter, defaultdict
from dataclasses import dataclass

from . import reports

ACTIONS = ("hold", "fallback", "abstain", "release")
MARKS = ("tool-refused", "fallback", "unverified", "unscreened", "uncalibrated", "redacted")
REPORT_PROBLEMS = ("report-missing", "report-unsigned", "report-malformed", "report-other-run",
                   "report-unknown-squad", "report-replayed", "report-late")
REASONS = reports.EXACT_CHECKS + ("label-rule",) + REPORT_PROBLEMS + (
    "statistical-flag", "weak-signals", "audit-disagrees", "low-confidence", "quote-failed", "uncalibrated", "passed",
    "fallback-failed", "watchdog-error", "runtime-error", "output-unsafe")

# A score bucket at or above WEAK_BUCKET is a weak signal (bucket 6 is the clean 95th
# percentile, 8 the 99th: watchdog.bucket). WEAK_SUM weak signals in one run, across all
# its squads, count as a flag, so an effect spread thin over several squads still adds up.
WEAK_BUCKET = 6
WEAK_SUM = 2


@dataclass(frozen=True)
class Decision:
    action: str
    reason: str
    marks: tuple = ()
    quarantined: tuple = ()

    def as_dict(self):
        return {"action": self.action, "reason": self.reason, "marks": list(self.marks),
                "quarantined": list(self.quarantined)}


class Run:
    """One run: its id, key, squads (squad id -> the input span ids it read) and deadline."""

    def __init__(self, supervisor, run_id, key, squads, deadline):
        self.supervisor, self.run_id, self.key = supervisor, run_id, key
        self.squads = {squad: tuple(spans) for squad, spans in squads.items()}
        self.deadline = deadline
        self.reports = {}   # squad id -> the last valid report
        self.last_seq = {}  # squad id -> its highest sequence number seen
        self.problems = []  # (reason, detail) of refused envelopes, in arrival order
        self.decision = None

    def submit(self, envelope):
        """Take one signed report. A refused one is recorded and holds the run at decide()."""
        try:
            if self.supervisor.clock() > self.deadline:
                raise reports.ReportError("report-late")
            report = reports.verify(envelope, self.key)
            if report["runId"] != self.run_id:
                raise reports.ReportError("report-other-run", report["runId"])
            squad = report["squadId"]
            if squad not in self.squads:
                raise reports.ReportError("report-unknown-squad", squad)
            if squad in self.last_seq and report["seq"] <= self.last_seq[squad]:
                raise reports.ReportError("report-replayed", f"{squad} seq {report['seq']}")
        except reports.ReportError as exc:
            reason = exc.reason if exc.reason in REPORT_PROBLEMS else "report-malformed"
            self.problems.append((reason, str(exc)))
            return False
        self.last_seq[squad] = report["seq"]
        self.reports[squad] = report
        return True

    def decide(self, *, label_broken=False, tool_refusals=0, confidence=None, threshold=None, quote_failed=False,
               calibrated=False):
        """The decision for this run, by the table in the module docstring."""
        if self.decision is not None:
            raise RuntimeError("a run is decided once")
        decision = self._decide(label_broken, tool_refusals, confidence, threshold, quote_failed, calibrated)
        self.decision = decision
        self.supervisor._count(self, decision)
        return decision

    def _decide(self, label_broken, tool_refusals, confidence, threshold, quote_failed, calibrated):
        valid = [self.reports[s] for s in self.squads if s in self.reports]
        for name in reports.EXACT_CHECKS:                                    # row 1
            if any(not report["checks"][name] for report in valid):
                return Decision("hold", name)
        if label_broken:
            return Decision("hold", "label-rule")
        if self.problems:                                                    # row 2
            return Decision("hold", self.problems[0][0])
        if len(valid) != len(self.squads):
            return Decision("hold", "report-missing")
        marks = ("tool-refused",) if tool_refusals else ()                   # row 3
        flagged = [s for s in self.squads if any(self.reports[s]["flags"].values())]
        weak = {s: sum(self.reports[s]["scores"][n] >= WEAK_BUCKET for n in reports.SCORES
                       if self.reports[s]["statistical"][n] == "measured") for s in self.squads}
        audits = [r["audits"] for r in valid]
        disagree = any(a["replay"] == "mismatch" or a["solverAlone"] == "disagree" for a in audits)
        if flagged or sum(weak.values()) >= WEAK_SUM or disagree:            # row 4
            suspects = set(flagged) | {s for s, n in weak.items() if n}
            spans = Counter(span for s in suspects for span in set(self.squads[s]))   # distinct squads per span
            quarantined = tuple(sorted(span for span, n in spans.items() if n >= 2))
            reason = "statistical-flag" if flagged else "weak-signals" if sum(weak.values()) >= WEAK_SUM \
                else "audit-disagrees"
            return Decision("fallback", reason, marks, quarantined)
        if confidence is not None and threshold is not None and confidence < threshold:   # row 5
            return Decision("abstain", "low-confidence", marks)
        if quote_failed:                                                     # row 6
            marks += ("unverified",)
        if any(r["statistical"][n] == "not-run" for r in valid for n in reports.SCORES):
            marks += ("unscreened",)   # no threshold set for this setting: no statistical check ran
        if not calibrated:                                                   # row 7
            marks += ("uncalibrated",)
        reason = "quote-failed" if quote_failed else "uncalibrated" if not calibrated else "passed"
        return Decision("release", reason, marks)                            # rows 6 to 8

    def after_fallback(self, *, within_limits, calibrated=False):
        """The decision for the fallback answer. It runs at most once, inside the same fence:
        within_limits says the caller checked its token budget, wall time and output gate.
        Released, marked as a fallback and uncalibrated unless the solver alone has its own
        calibration; held when it broke a limit."""
        if self.decision is None or self.decision.action != "fallback":
            raise RuntimeError("only a run that fell back has a fallback answer")
        if not within_limits:
            self.decision = Decision("hold", "fallback-failed", self.decision.marks, self.decision.quarantined)
            self.supervisor.counts[self.weights]["fallbackFailed"] += 1
            return self.decision
        marks = self.decision.marks + ("fallback",) + (() if calibrated else ("uncalibrated",))
        decision = Decision("release", self.decision.reason, marks, self.decision.quarantined)
        self.decision = decision
        self.supervisor.counts[self.weights]["fallbackReleased"] += 1
        return decision

    @property
    def weights(self):
        hashes = sorted({r["weightsHash"] for r in self.reports.values()})
        return hashes[0] if len(hashes) == 1 else "unknown"


class Supervisor:
    """Opens runs, and keeps long-run counts per weights hash (in memory only)."""

    def __init__(self, clock=time.monotonic, report_seconds=600.0):
        self.clock = clock
        self.report_seconds = report_seconds
        self.counts = defaultdict(Counter)

    def open_run(self, squads=None, key=None, run_id=None, deadline_seconds=None):
        squads = squads or {"squad-0": ("request",)}
        for squad in squads:
            if reports.IDENTIFIER.match(squad) is None:
                raise ValueError(f"not an identifier: {squad!r}")
        seconds = self.report_seconds if deadline_seconds is None else deadline_seconds
        return Run(self, run_id or reports.new_run_id(), key or reports.new_run_key(), squads,
                   self.clock() + seconds)

    def _count(self, run, decision):
        counts = self.counts[run.weights]
        counts["runs"] += 1
        counts[decision.action] += 1
        counts["reason:" + decision.reason] += 1
        for report in run.reports.values():
            for name, passed in report["checks"].items():
                counts["failed:" + name] += not passed
            for name, flag in report["flags"].items():
                counts["flag:" + name] += flag
            alone = report["audits"]["solverAlone"]
            if alone in ("agree", "disagree"):
                counts["solverAloneAudited"] += 1
                counts["squadChangedAnswer"] += alone == "disagree"
            if report["audits"]["replay"] != "not-run":
                counts["replayed"] += 1
                counts["replayMismatch"] += report["audits"]["replay"] == "mismatch"

    def stats(self):
        """Long-run counts and rates per weights hash. A rising rate is a drift alarm; a
        squad that never changes the solver's answer is not needed for that kind of task."""
        out = {}
        for weights, counts in self.counts.items():
            runs = counts["runs"] or 1
            audited = counts["solverAloneAudited"]
            out[weights] = {"counts": dict(counts),
                            "holdRate": counts["hold"] / runs, "fallbackRate": counts["fallback"] / runs,
                            "abstainRate": counts["abstain"] / runs,
                            "squadChangedRate": counts["squadChangedAnswer"] / audited if audited else None}
        return out
