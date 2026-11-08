import json
import math
import threading
import unittest

from latent_pool.pool import PREAMBLE
from latent_pool.prefix import prefix_id, render_prefix
from tests.helpers import MODEL, FakeVllm, Service, default_reply, free_port, request, role_of

A_JS = "".join(f"const a{n} = {n};\n" for n in range(1, 11))  # 10 lines
B_JS = "one\r\ntwo\r\nthree"  # 3 lines, CRLF, no final newline
FILES = {"src/a.js": A_JS, "src/b.js": B_JS}
PATHS = ["src/a.js", "src/b.js"]
EXPECTED_PREFIX = render_prefix([
    ("src/a.js", [f"const a{n} = {n};" for n in range(1, 11)]),
    ("src/b.js", ["one", "two", "three"]),
])

SLICE = {
    "answer": "a3 is 3; b has three lines.",
    "findings": [
        {"label": "valid span", "evidence": [{"path": "src/a.js", "startLine": 2, "endLine": 3}]},
        {"label": "end past the file", "evidence": [{"path": "src/a.js", "startLine": 8, "endLine": 50}]},
        {"label": "wholly past the file", "evidence": [{"path": "src/b.js", "startLine": 7, "endLine": 9}]},
        {"label": "path not requested", "evidence": [{"path": "src/c.js", "startLine": 1, "endLine": 1}]},
        {"label": "line zero", "evidence": [{"path": "src/b.js", "startLine": 0, "endLine": 1}]},
        {"label": "reversed\nacross  lines", "evidence": [
            {"path": "src/a.js", "startLine": 3, "endLine": 2},
            {"path": "src/a.js", "startLine": "4", "endLine": 4},
        ]},
    ],
}


class ServiceCase(unittest.TestCase):
    replies = None
    report_cache = True

    def setUp(self):
        self.fake = FakeVllm(replies=self.replies and {k: list(v) if isinstance(v, list) else v
                                                       for k, v in self.replies.items()},
                             report_cache=self.report_cache)
        self.service = Service(self.fake.url, files=FILES)

    def tearDown(self):
        self.service.close()
        self.fake.close()

    def read(self, **overrides):
        body = {"paths": PATHS, "question": "What is a3?", "budgetTokens": 600, "workers": 3}
        body.update(overrides)
        return self.service.request("POST", "/latent/read", body)


class ReadFlowTest(ServiceCase):
    replies = {"synthesizer": [json.dumps(SLICE)]}

    def test_full_read_keeps_only_exact_spans(self):
        # Review fix: spans past the file, at line zero or reversed are dropped, not
        # clamped, so an invented line number is never silently repaired.
        status, payload = self.read()
        self.assertEqual(status, 200, payload)
        graph = payload["graph"]
        self.assertEqual(graph["version"], 1)
        self.assertEqual(graph["kind"], "latent-slice")
        self.assertEqual(graph["question"], "What is a3?")
        self.assertEqual(graph["answer"], SLICE["answer"])
        self.assertEqual(graph["findings"], [
            {"id": "f1", "label": "valid span", "evidence": [{"path": "src/a.js", "startLine": 2, "endLine": 3}]},
        ])
        receipt = payload["receipt"]
        self.assertEqual(receipt["model"], MODEL)
        self.assertEqual(receipt["prefixId"], prefix_id(EXPECTED_PREFIX))
        self.assertEqual(receipt["droppedFindings"], 5)
        self.assertEqual(receipt["subQuestions"], ["Sub-question 1?", "Sub-question 2?", "Sub-question 3?"])
        roles = [call["role"] for call in receipt["calls"]]
        self.assertEqual(roles, ["reader", "planner", "worker", "worker", "worker", "synthesizer"])
        for call in receipt["calls"]:
            self.assertEqual(set(call), {"role", "promptTokens", "cachedTokens", "completionTokens", "ms"})
        self.assertEqual(receipt["calls"][0]["cachedTokens"], 0)
        self.assertTrue(all(call["cachedTokens"] > 0 for call in receipt["calls"][1:]))

        stats = payload["stats"]
        prompt = sum(call["promptTokens"] for call in receipt["calls"])
        cached = sum(call["cachedTokens"] for call in receipt["calls"])
        self.assertAlmostEqual(stats["cachedShare"], cached / prompt, places=3)
        self.assertEqual(stats["prefixTokens"], receipt["prefixTokens"])
        self.assertEqual(stats["prefixTokens"], receipt["calls"][0]["promptTokens"])
        compact = json.dumps(graph, ensure_ascii=False, separators=(",", ":"))
        self.assertEqual(stats["sliceTokensEstimate"], math.ceil(len(compact) / 4))
        self.assertIsInstance(stats["totalMs"], int)

    def test_every_call_sends_the_same_system_message(self):
        status, _ = self.read(workers=4)
        self.assertEqual(status, 200)
        systems = self.fake.systems()
        self.assertEqual(len(systems), 7)
        self.assertEqual(len(set(systems)), 1)
        self.assertEqual(systems[0].encode("utf-8"), (PREAMBLE + "\n\n" + EXPECTED_PREFIX).encode("utf-8"))
        users = [request["messages"][1]["content"] for request in self.fake.requests]
        self.assertGreater(len(set(users)), 3)  # only the user message differs

    def test_requests_use_temperature_zero_and_structured_output(self):
        self.read(budgetTokens=321)
        by_role = {}
        for body in self.fake.requests:
            by_role.setdefault(body["messages"][1]["content"].split("\n")[0][6:], body)
            self.assertEqual(body["temperature"], 0)
            self.assertEqual(body["model"], MODEL)
            self.assertEqual([m["role"] for m in body["messages"]], ["system", "user"])
        self.assertEqual(by_role["reader"]["max_tokens"], 1)
        self.assertNotIn("response_format", by_role["reader"])
        self.assertEqual(by_role["synthesizer"]["max_tokens"], 321)
        for role in ("planner", "worker", "synthesizer"):
            fmt = by_role[role]["response_format"]
            self.assertEqual(fmt["type"], "json_schema")
            self.assertEqual(fmt["json_schema"]["name"], role)
            self.assertIn("schema", fmt["json_schema"])
        evidence = by_role["synthesizer"]["response_format"]["json_schema"]["schema"]["properties"]["findings"]
        self.assertEqual(evidence["items"]["properties"]["evidence"]["items"]["properties"]["path"]["enum"], PATHS)

    def test_a_second_read_starts_warm(self):
        self.read()
        status, payload = self.read()
        self.assertEqual(status, 200)
        self.assertGreater(payload["receipt"]["calls"][0]["cachedTokens"], 0)


class WarmTest(ServiceCase):
    def test_warm_prefills_once(self):
        status, payload = self.service.request("POST", "/latent/warm", {"paths": PATHS})
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["prefixId"], prefix_id(EXPECTED_PREFIX))
        self.assertGreater(payload["prefixTokens"], 0)
        self.assertEqual(payload["receipt"]["model"], MODEL)
        self.assertEqual([call["role"] for call in payload["receipt"]["calls"]], ["reader"])
        self.assertEqual(len(self.fake.requests), 1)
        self.assertEqual(self.fake.requests[0]["max_tokens"], 1)

    def test_warm_then_read_share_one_system_message(self):
        self.service.request("POST", "/latent/warm", {"paths": PATHS})
        self.read()
        self.assertEqual(len(set(self.fake.systems())), 1)

    def test_warm_refuses_bad_paths(self):
        status, payload = self.service.request("POST", "/latent/warm", {"paths": ["../x"]})
        self.assertEqual(status, 400)
        self.assertEqual(self.fake.requests, [])


class NoCacheDetailsTest(ServiceCase):
    report_cache = False

    def test_cached_tokens_default_to_zero(self):
        status, payload = self.read(workers=1)
        self.assertEqual(status, 200)
        self.assertTrue(all(call["cachedTokens"] == 0 for call in payload["receipt"]["calls"]))
        self.assertEqual(payload["stats"]["cachedShare"], 0)


class MalformedSynthTest(ServiceCase):
    replies = {"synthesizer": ["not json at all"]}

    def test_invalid_reply_is_retried_once_then_502(self):
        status, payload = self.read(workers=1)
        self.assertEqual(status, 502)
        self.assertIn("synthesizer", payload["error"])
        self.assertEqual(self.fake.roles().count("synthesizer"), 2)


DUPLICATES = {
    "answer": "a3 is 3.",
    "findings": [
        {"label": "a3 is 3", "evidence": [{"path": "src/a.js", "startLine": 3, "endLine": 3}]},
        {"label": "a3 is 3", "evidence": [{"path": "src/a.js", "startLine": 3, "endLine": 3}]},
    ],
}


QUOTED = {
    "answer": "a3 is 3.",
    "findings": [{"label": "a3 is 3", "evidence": [
        {"path": "src/a.js", "startLine": 3, "endLine": 3, "quote": "const a3 = 3;\nextra"},
    ]}],
}


class QuotePassThroughTest(ServiceCase):
    """Cycle 6b: quotes reach the ledger, on one line, for it to verify."""

    replies = {"synthesizer": [json.dumps(QUOTED)]}

    def test_quote_is_kept_on_one_line(self):
        status, payload = self.read(workers=1)
        self.assertEqual(status, 200, payload)
        span = payload["graph"]["findings"][0]["evidence"][0]
        self.assertEqual(span["quote"], "const a3 = 3; extra")
        synth = [body for body in self.fake.requests if role_of(body) == "synthesizer"][0]
        item = synth["response_format"]["json_schema"]["schema"]["properties"]["findings"]["items"]
        self.assertIn("quote", item["properties"]["evidence"]["items"]["required"])


class DuplicateFindingsTest(ServiceCase):
    replies = {"synthesizer": [json.dumps(DUPLICATES)]}

    def test_identical_findings_are_kept_once(self):
        status, payload = self.read(workers=1)
        self.assertEqual(status, 200, payload)
        self.assertEqual(len(payload["graph"]["findings"]), 1)
        self.assertEqual(payload["receipt"]["droppedFindings"], 1)

    def test_case_aliases_of_one_file_are_duplicates(self):
        # On case-insensitive filesystems (Windows, /mnt/c under WSL) these name one
        # file. On a case-sensitive one the alias does not exist. Never a 200.
        status, payload = self.read(paths=["src/a.js", "SRC/A.JS"], workers=1)
        self.assertEqual(status, 400, payload)


class RecoveringSynthTest(ServiceCase):
    replies = {"synthesizer": ['{"answer": 3, "findings": []}', json.dumps(SLICE)]}

    def test_retry_recovers(self):
        status, payload = self.read(workers=1)
        self.assertEqual(status, 200, payload)
        self.assertEqual(self.fake.roles().count("synthesizer"), 2)
        self.assertEqual(len(payload["graph"]["findings"]), 1)


class NoValidEvidenceTest(ServiceCase):
    replies = {"synthesizer": [json.dumps({"answer": "x", "findings": [
        {"label": "bad", "evidence": [{"path": "src/a.js", "startLine": 99, "endLine": 120}]}]})]}

    def test_slice_without_valid_evidence_is_502(self):
        status, payload = self.read(workers=1)
        self.assertEqual(status, 502)


class CutOffSynthTest(ServiceCase):
    replies = {"synthesizer": [('{"answer": "trunc', "length")]}

    def test_cut_off_reply_says_so(self):
        status, payload = self.read(workers=1, budgetTokens=64)
        self.assertEqual(status, 502)
        self.assertIn("cut off", payload["error"])


def _long_then_compact(body):
    """Cut off at max_tokens unless the request asks for a shorter reply."""
    if "too long" in body["messages"][1]["content"]:
        return default_reply("synthesizer", body)
    return ('{"answer": "trunc', "length")


class CompactRetryTest(ServiceCase):
    """Live debug fix: a cut-off synthesizer reply is retried with a compact request."""

    replies = {"synthesizer": _long_then_compact}

    def test_cut_off_reply_is_retried_compactly(self):
        status, payload = self.read(workers=1, budgetTokens=400)
        self.assertEqual(status, 200, payload)
        synth = [body for body in self.fake.requests if role_of(body) == "synthesizer"]
        self.assertEqual(len(synth), 2)
        self.assertNotIn("too long", synth[0]["messages"][1]["content"])
        self.assertIn("at most 1 findings", synth[1]["messages"][1]["content"])
        schema = synth[0]["response_format"]["json_schema"]["schema"]
        self.assertEqual(schema["properties"]["findings"]["maxItems"], 3)  # 400 // 110


class BadPlannerTest(ServiceCase):
    replies = {"planner": [json.dumps({"subQuestions": ["only one"]})]}

    def test_wrong_sub_question_count_is_502(self):
        status, payload = self.read(workers=2)
        self.assertEqual(status, 502)
        self.assertIn("planner", payload["error"])
        self.assertNotIn("worker", self.fake.roles())


class BadWorkerTest(ServiceCase):
    replies = {"worker": ["[]"]}

    def test_worker_array_reply_is_502(self):
        status, payload = self.read(workers=2)
        self.assertEqual(status, 502)
        self.assertIn("worker", payload["error"])
        self.assertNotIn("synthesizer", self.fake.roles())


class ModelDownTest(unittest.TestCase):
    def test_unreachable_vllm_is_503(self):
        service = Service(f"http://127.0.0.1:{free_port()}/v1", files=FILES)
        try:
            for path, body in [("/latent/read", {"paths": PATHS, "question": "q"}), ("/latent/warm", {"paths": PATHS})]:
                status, payload = service.request("POST", path, body)
                self.assertEqual(status, 503)
                self.assertEqual(payload, {"error": "Model server is not ready."})
        finally:
            service.close()

    def test_loading_vllm_is_503(self):
        fake = FakeVllm(status=503)
        service = Service(fake.url, files=FILES)
        try:
            status, payload = service.request("POST", "/latent/warm", {"paths": PATHS})
            self.assertEqual((status, payload), (503, {"error": "Model server is not ready."}))
        finally:
            service.close()
            fake.close()


class ModelErrorTest(unittest.TestCase):
    def check(self, fake, expected):
        service = Service(fake.url, files=FILES)
        try:
            status, payload = service.request("POST", "/latent/warm", {"paths": PATHS})
            self.assertEqual(status, expected, payload)
        finally:
            service.close()
            fake.close()

    def test_context_overflow_is_413(self):
        self.check(FakeVllm(status=400, error_message=(
            "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens.")), 413)
        self.check(FakeVllm(status=400, error_message=(
            "The decoder prompt (length 40000) is longer than the maximum model length of 32768.")), 413)

    def test_other_model_errors_are_502(self):
        self.check(FakeVllm(status=400, error_message="bad schema"), 502)
        self.check(FakeVllm(status=500), 502)


class InputValidationTest(ServiceCase):
    def assert_status(self, expected, *args, **kwargs):
        status, payload = self.service.request(*args, **kwargs)
        self.assertEqual(status, expected, payload)
        self.assertIsInstance(payload.get("error"), str)
        return payload

    def test_bad_bodies(self):
        for raw in [b"[]", b"\"x\"", b"null", b"{", b"\xff\xfe", b"{\"paths\": NaN}", b""]:
            self.assert_status(400, "POST", "/latent/read", raw=raw)
        cases = [
            {"question": "q"},
            {"paths": "src/a.js", "question": "q"},
            {"paths": PATHS},
            {"paths": PATHS, "question": "   "},
            {"paths": PATHS, "question": 5},
            {"paths": PATHS, "question": "x" * 2001},
            {"paths": PATHS, "question": "q", "workers": 0},
            {"paths": PATHS, "question": "q", "workers": 9},
            {"paths": PATHS, "question": "q", "workers": True},
            {"paths": PATHS, "question": "q", "workers": 2.0},
            {"paths": PATHS, "question": "q", "workers": "3"},
            {"paths": PATHS, "question": "q", "budgetTokens": 63},
            {"paths": PATHS, "question": "q", "budgetTokens": 2049},
            {"paths": PATHS, "question": "q", "budgetTokens": None},
            {"paths": PATHS + ["src/a.js"], "question": "q"},
            {"paths": ["/etc/passwd"], "question": "q"},
            {"paths": ["C:/x"], "question": "q"},
            {"paths": ["src\\a.js"], "question": "q"},
        ]
        for body in cases:
            self.assert_status(400, "POST", "/latent/read", body=body)
        self.assertEqual(self.fake.requests, [])

    def test_size_limits(self):
        self.assert_status(413, "POST", "/latent/read",
                           body={"paths": [f"f{n}" for n in range(33)], "question": "q"})
        self.assert_status(413, "POST", "/latent/read", raw=b" " * (64 * 1024 + 1))
        self.assert_status(400, "POST", "/latent/read", raw=b"{}", headers={"Content-Type": "text/plain"})

    def test_routing(self):
        self.assert_status(404, "GET", "/nope")
        self.assert_status(405, "GET", "/latent/read")
        self.assert_status(405, "PUT", "/latent/read", raw=b"{}")
        self.assert_status(405, "OPTIONS", "/latent/read")


class HostOriginTest(ServiceCase):
    def test_foreign_host_is_refused(self):
        port = self.service.port
        for host in ["evil.example:%d" % port, "127.0.0.1", "localhost", "127.0.0.1:1", ""]:
            status, payload = self.service.request("GET", "/latent/mappers", host=host)
            self.assertEqual(status, 403, host)
        for host in ["127.0.0.1:%d" % port, "localhost:%d" % port, "LOCALHOST:%d" % port]:
            status, _ = self.service.request("GET", "/latent/mappers", host=host)
            self.assertEqual(status, 200, host)

    def test_any_origin_is_refused(self):
        port = self.service.port
        for origin in ["http://evil.example", f"http://127.0.0.1:{port}", "null", ""]:
            status, payload = self.service.request("POST", "/latent/read", headers={"Origin": origin},
                                                   body={"paths": PATHS, "question": "q"})
            self.assertEqual(status, 403, origin)
        self.assertEqual(self.fake.requests, [])


class DebugPassRegressionTest(unittest.TestCase):
    """Inputs found in the debug pass that once broke or misbehaved."""

    def setUp(self):
        self.fake = FakeVllm()
        self.service = Service(self.fake.url, files={
            "empty.js": "",
            "dír/файл.js": "привет\r\nмир\r\n",
            "latin.txt": "caf\xe9\n".encode("latin-1"),
        })

    def tearDown(self):
        self.service.close()
        self.fake.close()

    def test_lone_surrogate_is_400_not_500(self):
        raw = b'{"paths": ["empty.js"], "question": "\\ud800"}'
        self.assertEqual(self.service.request("POST", "/latent/read", raw=raw)[0], 400)

    def test_deeply_nested_body_is_400(self):
        self.assertEqual(self.service.request("POST", "/latent/read", raw=b"[" * 60000)[0], 400)

    def test_only_empty_files_cannot_be_read(self):
        status, payload = self.service.request("POST", "/latent/read", {"paths": ["empty.js"], "question": "q"})
        self.assertEqual(status, 400)
        self.assertEqual(self.fake.requests, [])
        self.assertEqual(self.service.request("POST", "/latent/warm", {"paths": ["empty.js"]})[0], 200)

    def test_empty_files_are_not_offered_for_citation(self):
        status, payload = self.service.request("POST", "/latent/read", {
            "paths": ["empty.js", "dír/файл.js"], "question": "q", "workers": 1})
        self.assertEqual(status, 200, payload)
        synth = [b for b in self.fake.requests if b["messages"][1]["content"].startswith("ROLE: synthesizer")][0]
        schema = synth["response_format"]["json_schema"]["schema"]
        enum = schema["properties"]["findings"]["items"]["properties"]["evidence"]["items"]["properties"]["path"]["enum"]
        self.assertEqual(enum, ["dír/файл.js"])
        self.assertIn("=== FILE: empty.js ===\n=== FILE: dír/файл.js ===\n1| привет\n2| мир\n",
                      synth["messages"][0]["content"])
        self.assertEqual(payload["graph"]["findings"][0]["evidence"][0]["path"], "dír/файл.js")

    def test_non_utf8_file_is_400(self):
        status, payload = self.service.request("POST", "/latent/warm", {"paths": ["latin.txt"]})
        self.assertEqual(status, 400)
        self.assertIn("UTF-8", payload["error"])

    def test_windows_aliases_are_refused(self):
        for path in ["empty.js.", "empty.js ", "CON", "dír/NUL"]:
            status, _ = self.service.request("POST", "/latent/warm", {"paths": [path]})
            self.assertEqual(status, 400, path)


class ConcurrencyTest(ServiceCase):
    def test_parallel_reads_all_succeed(self):
        results = []

        def run(index):
            results.append(request(self.service.port, "POST", "/latent/read",
                                   body={"paths": PATHS, "question": f"q{index}", "workers": 2})[0])

        threads = [threading.Thread(target=run, args=(index,)) for index in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(60)
        self.assertEqual(results, [200] * 8)
        self.assertEqual(len(set(self.fake.systems())), 1)


if __name__ == "__main__":
    unittest.main()
