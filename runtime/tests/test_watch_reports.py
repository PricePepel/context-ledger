"""W1 eval 5 and the supervisor table: reports, signatures and decisions (no torch)."""
import copy
import unittest

from latent_team import reports
from latent_team.supervisor import WEAK_BUCKET, Supervisor


def clean_report(run_id, squad="squad-0", seq=1, **changes):
    report = {
        "schema": reports.SCHEMA, "runId": run_id, "squadId": squad, "seq": seq,
        "thresholdSet": "w1-test-1", "weightsHash": "0" * 64,
        "checks": {name: True for name in reports.EXACT_CHECKS},
        "counts": {"agents": 4, "latentSteps": 120, "textTokens": 250, "handOffs": 3, "toolCalls": 0},
        "statistical": {"degenerate": "measured", "distance": "measured"},
        "scores": {"degenerate": 2, "distance": 3},
        "flags": {"degenerate": False, "distance": False},
        "audits": {"replay": "not-run", "mismatchedMemory": "not-run", "solverAlone": "not-run"},
    }
    for path, value in changes.items():
        node = report
        *parents, last = path.split("__")
        for parent in parents:
            node = node[parent]
        node[last] = value
    return report


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


class ReportSchemaTest(unittest.TestCase):
    def test_a_clean_report_signs_and_verifies(self):
        key = reports.new_run_key()
        envelope = reports.sign(clean_report("run-a"), key)
        self.assertEqual(reports.verify(envelope, key)["runId"], "run-a")
        self.assertEqual(set(envelope), {"report", "mac"})

    def test_only_listed_kinds_of_value_are_accepted(self):
        bad = {
            "a float": {"scores__degenerate": 2.5},
            "a float count": {"counts__textTokens": 250.0},
            "an array": {"counts__agents": [4]},
            "an array of checks": {"checks": [True] * 7},
            "a free string": {"audits__replay": "it looked fine to me"},
            "free text as an id": {"squadId": "Squad Zero!"},
            "a digit over 9": {"scores__distance": 10},
            "a negative count": {"counts__toolCalls": -1},
            "a bool as a digit": {"scores__distance": True},
            "an int as a bool": {"checks__legibility": 1},
            "a nested unknown field": {"checks__note": True},
            "another schema": {"schema": "w0"},
            "a vector": {"scores": {"degenerate": [0.1, 0.2], "distance": 3}},
            "a None": {"thresholdSet": None},
        }
        for name, change in bad.items():
            report = clean_report("run-a", **change)
            with self.assertRaises(reports.ReportError, msg=name) as raised:
                reports.validate(report)
            self.assertEqual(raised.exception.reason, "report-malformed", name)
        missing = clean_report("run-a")
        del missing["audits"]
        with self.assertRaises(reports.ReportError):
            reports.validate(missing)
        extra = clean_report("run-a")
        extra["text"] = "the planner said"
        with self.assertRaises(reports.ReportError):
            reports.validate(extra)

    def test_a_watchdog_cannot_sign_what_the_supervisor_would_refuse(self):
        with self.assertRaises(reports.ReportError):
            reports.sign(clean_report("run-a", scores__distance=0.5), reports.new_run_key())

    def test_signatures(self):
        key, other = reports.new_run_key(), reports.new_run_key()
        envelope = reports.sign(clean_report("run-a"), key)
        with self.assertRaises(reports.ReportError) as raised:
            reports.verify(envelope, other)
        self.assertEqual(raised.exception.reason, "report-unsigned")
        tampered = copy.deepcopy(envelope)
        tampered["report"]["checks"]["memoryChecksum"] = False
        with self.assertRaises(reports.ReportError):
            reports.verify(tampered, key)
        for broken in [{"report": envelope["report"]}, {"report": envelope["report"], "mac": "xyz"},
                       {"report": envelope["report"], "mac": envelope["mac"], "note": 1}, "not an envelope", None]:
            with self.assertRaises(reports.ReportError):
                reports.verify(broken, key)


class MemorySignatureTest(unittest.TestCase):
    def setUp(self):
        self.key = reports.new_run_key()
        self.clock = Clock()
        self.receiver = reports.MemoryReceiver(self.key, "pool-1", clock=self.clock)

    def seal(self, blob=b"memory bytes", **changes):
        fields = dict(key=self.key, run="run-a", seq=1, sender="squad-0", receiver="pool-1", expires=200)
        fields.update(changes)
        return reports.seal_memory(blob, **fields)

    def test_open_once_then_refuse_a_repeat(self):
        envelope = self.seal()
        self.assertEqual(self.receiver.open(envelope, b"memory bytes"), b"memory bytes")
        with self.assertRaises(reports.ReportError) as raised:
            self.receiver.open(envelope, b"memory bytes")
        self.assertEqual(raised.exception.reason, "memory-replayed")

    def test_refusals(self):
        cases = {
            "memory-altered": (self.seal(), b"memory bytez"),
            "memory-wrong-receiver": (self.seal(receiver="pool-2"), b"memory bytes"),
            "memory-unsigned": (reports.seal_memory(b"memory bytes", key=reports.new_run_key(), run="run-a", seq=2,
                                                    sender="squad-0", receiver="pool-1", expires=200), b"memory bytes"),
        }
        for reason, (envelope, blob) in cases.items():
            with self.assertRaises(reports.ReportError) as raised:
                self.receiver.open(envelope, blob)
            self.assertEqual(raised.exception.reason, reason)
        late = self.seal(seq=3)
        self.clock.now = 300.0
        with self.assertRaises(reports.ReportError) as raised:
            self.receiver.open(late, b"memory bytes")
        self.assertEqual(raised.exception.reason, "memory-expired")


class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.supervisor = Supervisor(clock=self.clock, report_seconds=60)

    def decide(self, *changes, squads=None, submit=True, **options):
        run = self.supervisor.open_run(squads)
        for squad in run.squads:
            if submit:
                run.submit(reports.sign(clean_report(run.run_id, squad, **(changes[0] if changes else {})), run.key))
        return run, run.decide(**options)

    def test_every_check_failure_holds_and_names_the_check(self):
        for name in reports.EXACT_CHECKS:
            _, decision = self.decide({f"checks__{name}": False})
            self.assertEqual((decision.action, decision.reason), ("hold", name))

    def test_report_problems_hold(self):
        run = self.supervisor.open_run()
        self.assertEqual(run.decide().as_dict()["reason"], "report-missing")
        cases = {
            "report-unsigned": lambda run: {"report": clean_report(run.run_id)},
            "report-malformed": lambda run: reports.sign(clean_report(run.run_id), run.key) | {"extra": 1},
            "report-other-run": lambda run: reports.sign(clean_report("run-elsewhere"), run.key),
            "report-unknown-squad": lambda run: reports.sign(clean_report(run.run_id, "squad-9"), run.key),
        }
        for reason, envelope in cases.items():
            run = self.supervisor.open_run()
            run.submit(reports.sign(clean_report(run.run_id), run.key))
            self.assertFalse(run.submit(envelope(run)))
            self.assertEqual(run.decide().reason, reason)
        forged = self.supervisor.open_run()
        report = clean_report(forged.run_id)
        report["scores"]["distance"] = 0.5   # malformed and signed with the wrong key: refused as unsigned
        self.assertFalse(forged.submit(reports.sign(clean_report(forged.run_id), reports.new_run_key())))
        self.assertEqual(forged.decide().reason, "report-unsigned")

    def test_the_supervisor_decides_on_what_was_signed(self):
        run = self.supervisor.open_run()
        envelope = reports.sign(clean_report(run.run_id, checks__budgets=False), run.key)
        self.assertTrue(run.submit(envelope))
        envelope["report"]["checks"]["budgets"] = True     # changed after the MAC was checked
        self.assertEqual(run.decide().reason, "budgets")

    def test_a_fallback_that_broke_a_limit_is_held(self):
        run, decision = self.decide({"flags__distance": True})
        final = run.after_fallback(within_limits=False)
        self.assertEqual((final.action, final.reason), ("hold", "fallback-failed"))

    def test_a_replayed_or_late_report_holds(self):
        run = self.supervisor.open_run()
        envelope = reports.sign(clean_report(run.run_id), run.key)
        self.assertTrue(run.submit(envelope))
        self.assertFalse(run.submit(envelope))
        self.assertEqual(run.decide().reason, "report-replayed")
        late = self.supervisor.open_run()
        self.clock.now += 61
        self.assertFalse(late.submit(reports.sign(clean_report(late.run_id), late.key)))
        self.assertEqual(late.decide().reason, "report-late")

    def test_a_failed_check_wins_over_a_bad_report(self):
        run = self.supervisor.open_run({"squad-0": ("request",), "squad-1": ("request",)})
        run.submit(reports.sign(clean_report(run.run_id, "squad-0", checks__budgets=False), run.key))
        run.submit({"report": "junk"})
        self.assertEqual(run.decide().reason, "budgets")

    def test_label_rule_holds_after_checks(self):
        _, decision = self.decide(label_broken=True)
        self.assertEqual((decision.action, decision.reason), ("hold", "label-rule"))

    def test_flags_and_audits_fall_back(self):
        for change, reason in [({"flags__distance": True}, "statistical-flag"),
                               ({"audits__replay": "mismatch"}, "audit-disagrees"),
                               ({"audits__solverAlone": "disagree"}, "audit-disagrees"),
                               ({"scores__degenerate": WEAK_BUCKET, "scores__distance": WEAK_BUCKET}, "weak-signals")]:
            _, decision = self.decide(change)
            self.assertEqual((decision.action, decision.reason), ("fallback", reason), change)
        _, decision = self.decide({"audits__mismatchedMemory": "unchanged", "audits__solverAlone": "agree"})
        self.assertEqual(decision.action, "release", "agreement and an unused hand-off are not disagreements")
        _, decision = self.decide({"scores__degenerate": 9, "statistical__degenerate": "not-run"})
        self.assertEqual(decision.action, "release", "a score that was not measured is no signal")

    def test_weak_signals_add_up_across_squads_and_a_shared_span_is_quarantined(self):
        squads = {"squad-0": ("request", "file-a"), "squad-1": ("request", "file-a"), "squad-2": ("file-b",)}
        run = self.supervisor.open_run(squads)
        for squad in squads:
            weak = {"scores__distance": WEAK_BUCKET} if squad != "squad-2" else {}
            run.submit(reports.sign(clean_report(run.run_id, squad, **weak), run.key))
        decision = run.decide()
        self.assertEqual((decision.action, decision.reason), ("fallback", "weak-signals"))
        self.assertEqual(decision.quarantined, ("file-a", "request"))
        _, alone = self.decide({"scores__distance": WEAK_BUCKET})
        self.assertEqual(alone.action, "release", "one weak signal in one squad is not enough")

    def test_one_squad_never_quarantines_a_span_alone(self):
        run = self.supervisor.open_run({"squad-0": ("request", "request")})
        run.submit(reports.sign(clean_report(run.run_id, flags__distance=True), run.key))
        self.assertEqual(run.decide().quarantined, ())

    def test_rows_three_to_eight_in_order(self):
        _, decision = self.decide(tool_refusals=1, calibrated=True)
        self.assertEqual((decision.action, decision.marks), ("release", ("tool-refused",)))
        _, decision = self.decide({"flags__degenerate": True}, tool_refusals=1)
        self.assertEqual((decision.action, decision.marks), ("fallback", ("tool-refused",)))
        _, decision = self.decide({"flags__degenerate": True}, confidence=0.1, threshold=0.5)
        self.assertEqual(decision.action, "fallback", "a flag wins over low confidence")
        _, decision = self.decide(confidence=0.1, threshold=0.5, quote_failed=True)
        self.assertEqual((decision.action, decision.reason), ("abstain", "low-confidence"))
        _, decision = self.decide(quote_failed=True, calibrated=True)
        self.assertEqual((decision.action, decision.reason, decision.marks), ("release", "quote-failed", ("unverified",)))
        _, decision = self.decide(quote_failed=True)
        self.assertEqual(decision.marks, ("unverified", "uncalibrated"))
        _, decision = self.decide()
        self.assertEqual((decision.action, decision.reason, decision.marks), ("release", "uncalibrated", ("uncalibrated",)))
        _, decision = self.decide(calibrated=True, confidence=0.9, threshold=0.5)
        self.assertEqual((decision.action, decision.reason, decision.marks), ("release", "passed", ()))

    def test_a_release_without_statistical_checks_is_marked_unscreened(self):
        _, decision = self.decide({"statistical__distance": "not-run", "scores__distance": 0})
        self.assertEqual((decision.action, decision.marks), ("release", ("unscreened", "uncalibrated")))

    def test_a_fallback_is_released_once_and_marked(self):
        run, decision = self.decide({"flags__distance": True})
        self.assertEqual(decision.action, "fallback")
        final = run.after_fallback(within_limits=True)
        self.assertEqual((final.action, final.marks), ("release", ("fallback", "uncalibrated")))
        with self.assertRaises(RuntimeError):
            run.after_fallback(within_limits=True)
        with self.assertRaises(RuntimeError):
            run.decide()

    def test_long_run_counts_per_weights_hash(self):
        self.decide({"audits__solverAlone": "disagree"})
        self.decide({"audits__solverAlone": "agree"})
        self.decide({"checks__numbers": False})
        stats = self.supervisor.stats()["0" * 64]
        self.assertEqual(stats["counts"]["runs"], 3)
        self.assertEqual(stats["counts"]["failed:numbers"], 1)
        self.assertEqual(stats["squadChangedRate"], 0.5)
        self.assertAlmostEqual(stats["holdRate"], 1 / 3)


if __name__ == "__main__":
    unittest.main()
