"""M2c serving with a fake team: /latent/team and the OpenAI-compatible API (no torch)."""
import http.client
import json
import threading
import time
import unittest

from latent_pool import ApiError
from latent_pool.server import Config, LatentServer
from latent_pool.team_service import MODEL_ID, TeamService
from latent_pool.vllm_client import VllmClient
from latent_team.guard import Outcome

CHECKS = {name: True for name in ("turnStructure", "configuration", "legibility", "spanLedger", "memoryChecksum",
                                  "numbers", "budgets")}


class FakeReceipt:
    def __init__(self, steps):
        self.latent_steps, self.latent_vectors, self.generated_tokens, self.seconds = steps, steps * 3, [5], 0.25


class FakeTeam:
    model_name = "Qwen/Qwen2.5-3B-Instruct"

    def __init__(self, delay=0.0):
        self.delay, self.calls = delay, []

    def latent_mas(self, questions, steps, max_new_tokens):
        self.calls.append((questions[0], steps, max_new_tokens))
        time.sleep(self.delay)
        if "boom" in questions[0]:
            raise RuntimeError("CUDA error")
        return ["The answer is 18."], FakeReceipt(steps)


class FakeGuard:
    """Stands in for latent_team.guard.Guard (which needs torch): runs the fake team and
    returns the outcome a supervisor decision would give."""

    def __init__(self, team, action="release", reason="uncalibrated"):
        self.team, self.action, self.reason = team, action, reason

    def run(self, questions, steps, max_new_tokens, gateways=None):
        if gateways is not None:   # the squad reads what the gateway admitted
            questions = [g.admission.text for g in gateways]
        self.gateways = gateways
        answers, receipt = self.team.latent_mas(questions, steps=steps, max_new_tokens=max_new_tokens)
        checks = dict(CHECKS)
        answer, system, marks, action = answers[0], "latent_mas", ["uncalibrated"], self.action
        if self.action == "hold":
            answer, marks, checks[self.reason] = None, [], False
        elif self.action == "abstain":   # a broken guard that returns text with an abstention
            marks = []
        elif self.action == "fallback":
            answer, system, marks, action = "The answer is 20.", "single", ["fallback", "uncalibrated"], "release"
        return [Outcome(answer=answer, decision={"action": action, "reason": self.reason, "marks": marks,
                                                 "quarantined": []},
                        checks=checks, audits={"replay": "not-run", "mismatchedMemory": "not-run",
                                               "solverAlone": "not-run"},
                        statistical={"degenerate": "measured", "distance": "measured"},
                        scores={"degenerate": 2, "distance": 3}, system=system, tokens=receipt.generated_tokens[0],
                        latent_steps=receipt.latent_steps, latent_vectors=receipt.latent_vectors,
                        seconds=receipt.seconds,
                        gateway=dict(gateways[0].admission.receipt(), redactions=0) if gateways else {})]


class TeamServiceTest(unittest.TestCase):
    def setUp(self):
        self.team = FakeTeam()
        self.service = TeamService(self.team, steps=40, slot_wait=0.1, guard=FakeGuard(self.team))

    def status(self, call, body):
        with self.assertRaises(ApiError) as raised:
            call(body)
        return raised.exception.status

    def test_latent_team_answer_and_receipt(self):
        result = self.service({"question": "Janet has 16 eggs...", "latentSteps": 20})
        self.assertEqual(result["answer"], "The answer is 18.")
        self.assertIs(result["answerVerified"], False)
        self.assertEqual(result["receipt"]["latentStepsPerAgent"], 20)
        self.assertEqual(result["receipt"]["agents"], ["planner", "critic", "refiner", "solver"])
        self.assertEqual(self.team.calls[0][1:], (20, 512))
        receipt = result["receipt"]
        self.assertEqual(receipt["decision"]["action"], "release")
        self.assertEqual(receipt["checks"], CHECKS)
        self.assertEqual(receipt["system"], "latent_mas")
        self.assertEqual(set(receipt["audits"]), {"replay", "mismatchedMemory", "solverAlone"})

    def test_a_hold_returns_the_reason_and_no_answer_on_both_routes(self):
        service = TeamService(self.team, slot_wait=0.1, guard=FakeGuard(self.team, "hold", "memoryChecksum"))
        for call, body in [(service, {"question": "q"}),
                           (service.chat, {"model": MODEL_ID, "messages": [{"role": "user", "content": "q"}]}),
                           (service.chat, {"model": MODEL_ID, "stream": True,
                                           "messages": [{"role": "user", "content": "q"}]})]:
            with self.assertRaises(ApiError) as raised:
                call(body)
            self.assertEqual(raised.exception.status, 409)
            self.assertIn("memoryChecksum", raised.exception.message)
            self.assertNotIn("18", raised.exception.message, "nothing of the squad's text leaves with a hold")

    def test_a_fallback_answer_is_the_solver_alone_and_marked(self):
        service = TeamService(self.team, slot_wait=0.1, guard=FakeGuard(self.team, "fallback", "statistical-flag"))
        result = service({"question": "q"})
        self.assertEqual(result["answer"], "The answer is 20.")
        self.assertEqual(result["receipt"]["system"], "single")
        self.assertEqual(result["receipt"]["decision"]["marks"], ["fallback", "uncalibrated"])
        chat = service.chat({"model": MODEL_ID, "messages": [{"role": "user", "content": "q"}]})
        self.assertEqual(chat["latent_receipt"]["decision"]["reason"], "statistical-flag")
        events = service.chat({"model": MODEL_ID, "stream": True, "messages": [{"role": "user", "content": "q"}]}).events
        self.assertEqual(events[1]["latent_receipt"]["decision"]["marks"], ["fallback", "uncalibrated"],
                         "a streamed fallback is marked too")

    def test_only_a_release_leaves_the_route(self):
        service = TeamService(self.team, slot_wait=0.1, guard=FakeGuard(self.team, "abstain", "low-confidence"))
        with self.assertRaises(ApiError) as raised:
            service({"question": "q"})
        self.assertEqual(raised.exception.status, 409)

    def test_no_response_carries_a_vector_or_a_free_number(self):
        def leaves(value):
            if isinstance(value, dict):
                for item in value.values():
                    yield from leaves(item)
            elif isinstance(value, list):
                for item in value:
                    yield from leaves(item)
            else:
                yield value
        receipt = self.service({"question": "q"})["receipt"]
        for name in ("checks", "audits", "statistical", "scores", "decision"):
            for leaf in leaves(receipt[name]):
                self.assertTrue(isinstance(leaf, (bool, str)) or (type(leaf) is int and 0 <= leaf <= 9),
                                (name, leaf))

    def test_w2_declared_secrets_never_reach_the_squad_and_labels_follow_origin(self):
        import secrets as random_secrets
        canary = "cnry" + random_secrets.token_hex(16)
        guard = FakeGuard(self.team)
        service = TeamService(self.team, slot_wait=0.1, guard=guard)
        result = service({"question": f"My code is {canary}. Repeat it.", "secrets": [canary]})
        self.assertNotIn(canary, self.team.calls[-1][0], "the squad reads a placeholder")
        self.assertNotIn(canary, json.dumps(result))
        self.assertEqual(result["receipt"]["gateway"]["label"], {"trust": "user", "sensitivity": "public"})
        self.assertEqual(result["receipt"]["gateway"]["placeholders"], 1)
        service.chat({"model": MODEL_ID, "messages": [{"role": "system", "content": "be kind"},
                                                      {"role": "user", "content": "2+2?"}]})
        self.assertEqual(guard.gateways[0].admission.label.trust, "untrusted", "the chat route is untrusted as a whole")

    def test_w2_a_long_chat_is_cut_after_the_gateway(self):
        # Review W2-1 finding 5: a declared value across the cut never reaches the squad in part.
        import secrets as random_secrets
        canary = "cnry" + random_secrets.token_hex(16)
        guard = FakeGuard(self.team)
        service = TeamService(self.team, slot_wait=0.1, guard=guard)
        filler = "word " * 900
        text = filler[:1990] + canary + filler + canary + " end"
        service.chat({"model": MODEL_ID, "secrets": [canary], "messages": [{"role": "user", "content": text}]})
        read = self.team.calls[-1][0]
        self.assertLessEqual(len(read), 8000 + 64)
        for size in (8, 12, 20, 36):
            for start in range(0, len(canary) - size + 1, 4):
                self.assertNotIn(canary[start:start + size], read)

    def test_w2_the_guard_keeps_to_one_project_and_to_the_fixed_budgets(self):
        from latent_team.gateway import Gateway, Permissions, Span
        from latent_team.guard import Guard
        gateways = []
        for project in ("proj-a", "proj-b"):
            g = Gateway(project)
            g.fix_permissions(Permissions())
            g.admit([Span("request", "request", "q")])
            gateways.append(g)
        guard = Guard(self.team, thresholds=None)
        with self.assertRaises(ValueError):
            guard.run(["q", "q"], steps=3, max_new_tokens=6, gateways=gateways)
        tight = Gateway("proj-a")
        tight.fix_permissions(Permissions(max_steps=2))
        tight.admit([Span("request", "request", "q")])
        with self.assertRaises(ValueError):
            guard.run(["q"], steps=3, max_new_tokens=6, gateways=[tight])
        self.assertEqual(self.team.calls, [], "nothing ran")

    def test_w2_bad_declarations_are_refused(self):
        for body in [{"question": "q", "secrets": "abcdefgh"}, {"question": "q", "secrets": ["short"]},
                     {"question": "q", "secrets": ["x" * 513]}, {"question": "q", "secrets": ["abcdefgh"] * 17},
                     {"question": "q", "secrets": [12345678]}, {"question": "q", "clearance": "top"}]:
            self.assertEqual(self.status(self.service, body), 400, body)

    def test_bad_team_requests(self):
        for body in [{}, {"question": " "}, {"question": "q", "latentSteps": 81}, {"question": "q", "latentSteps": True},
                     {"question": "q", "maxNewTokens": 0}, {"question": "q", "extra": 1}, {"question": "x" * 8001}]:
            self.assertEqual(self.status(self.service, body), 400, body)
        self.assertEqual(self.team.calls, [])

    def test_openai_chat_uses_the_last_user_message_and_history(self):
        body = {"model": MODEL_ID, "messages": [
            {"role": "system", "content": "ignored system text"},
            {"role": "user", "content": "I have 3 apples."},
            {"role": "assistant", "content": "Noted."},
            {"role": "user", "content": [{"type": "text", "text": "I buy 2 more. How many?"}]},
        ]}
        result = self.service.chat(body)
        self.assertEqual(result["object"], "chat.completion")
        self.assertEqual(result["choices"][0]["message"], {"role": "assistant", "content": "The answer is 18."})
        question = self.team.calls[0][0]
        self.assertIn("Instructions:\nignored system text", question, "system text is kept as instructions")
        self.assertIn("user: I have 3 apples.", question)
        self.assertTrue(question.endswith("New message: I buy 2 more. How many?"))
        self.assertEqual(question.count("I buy 2 more"), 1)

    def test_an_open_webui_payload_is_accepted(self):
        body = {"model": MODEL_ID, "stream": True, "stream_options": {"include_usage": True},
                "messages": [{"role": "system", "content": "Use the context below.\n<context>Eggs: 16</context>"},
                             {"role": "user", "content": "How many eggs?"}],
                "temperature": 0.7, "top_p": 0.9, "max_tokens": 64, "logit_bias": {}, "user": "u1",
                "metadata": {"chat_id": "c"}, "tools": [], "response_format": {"type": "text"}}
        events = self.service.chat(body).events
        self.assertEqual(events[0]["choices"][0]["delta"]["content"], "The answer is 18.")
        self.assertEqual(events[1]["choices"][0]["finish_reason"], "stop")
        self.assertEqual(events[2]["choices"], [])
        self.assertEqual(events[2]["usage"]["completion_tokens"], 5)
        no_usage = self.service.chat({**body, "stream_options": None}).events
        self.assertEqual(len(no_usage), 2, "usage only when include_usage is set")

    def test_finish_reason_is_length_at_the_limit(self):
        result = self.service.chat({"model": MODEL_ID, "max_tokens": 5, "messages": [{"role": "user", "content": "q"}]})
        self.assertEqual(result["choices"][0]["finish_reason"], "length")

    def test_a_long_message_keeps_its_head_and_tail(self):
        from latent_pool.team_service import fit
        text = "INSTRUCTION: summarise.\n" + "x" * 20000 + "\nQUESTION: what is it?"
        kept = fit(text)
        self.assertLessEqual(len(kept), 8000)
        self.assertTrue(kept.startswith("INSTRUCTION: summarise."))
        self.assertTrue(kept.endswith("QUESTION: what is it?"))
        self.assertIn("middle omitted", kept)

    def test_a_caller_that_left_gets_no_gpu_work(self):
        with self.assertRaises(ApiError) as raised:
            self.service({"question": "q"}, gone=lambda: True)
        self.assertEqual(raised.exception.status, 499)
        self.assertEqual(self.team.calls, [])
        self.assertEqual(self.service({"question": "q"}, gone=lambda: False)["answer"], "The answer is 18.")

    def test_openai_chat_refusals(self):
        ok = {"model": MODEL_ID, "messages": [{"role": "user", "content": "hi"}]}
        self.assertEqual(self.status(self.service.chat, {**ok, "model": "gpt-4o"}), 404)
        self.assertEqual(self.status(self.service.chat, {**ok, "messages": []}), 400)
        self.assertEqual(self.status(self.service.chat, {**ok, "messages": [{"role": "system", "content": "x"}]}), 400)
        self.assertEqual(self.status(self.service.chat, {**ok, "n": 2}), 400)
        self.assertEqual(self.status(self.service.chat, {**ok, "tools": [{"type": "function"}]}), 400)
        self.assertEqual(self.status(self.service.chat, {**ok, "response_format": {"type": "json_object"}}), 400)
        self.assertEqual(self.status(self.service.chat, {**ok, "n": True}), 400)
        self.assertEqual(self.status(self.service.chat, {**ok, "max_tokens": "big"}), 400)

    def test_busy_and_failure_release(self):
        slow_team = FakeTeam(delay=0.5)
        slow = TeamService(slow_team, slot_wait=0.1, guard=FakeGuard(slow_team))
        worker = threading.Thread(target=lambda: slow({"question": "q"}))
        worker.start()
        time.sleep(0.1)
        self.assertEqual(self.status(slow, {"question": "q"}), 503)
        worker.join()
        with self.assertRaises(RuntimeError):
            self.service({"question": "boom"})
        self.assertEqual(self.service({"question": "q"})["answer"], "The answer is 18.")


class OpenAiRoutesTest(unittest.TestCase):
    """Through the real HTTP server, as Open WebUI would call it."""

    def start(self, team, allowed_hosts=(), decision=()):
        config = Config(root=".", vllm_url="http://127.0.0.1:9/v1", model="m", port=0, allowed_hosts=allowed_hosts)
        server = LatentServer(config, client=VllmClient("http://127.0.0.1:9/v1", "m", 1), quiet=True,
                              team=TeamService(team, guard=FakeGuard(team, *decision)) if team else None)
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_port

    def call(self, port, method, path, body=None, host=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        data = json.dumps(body).encode() if body is not None else None
        all_headers = {"Host": host or f"127.0.0.1:{port}", "Authorization": "Bearer anything", **(headers or {})}
        if data is not None:
            all_headers.update({"Content-Type": "application/json", "Content-Length": str(len(data))})
        connection.request(method, path, body=data, headers=all_headers)
        response = connection.getresponse()
        raw = response.read()
        connection.close()
        return response.status, response.getheader("Content-Type"), raw

    def test_models_and_a_streamed_chat(self):
        port = self.start(FakeTeam())
        status, _, raw = self.call(port, "GET", "/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["data"][0]["id"], MODEL_ID)
        status, kind, raw = self.call(port, "POST", "/v1/chat/completions",
                                      {"model": MODEL_ID, "stream": True, "messages": [{"role": "user", "content": "2+2?"}]})
        self.assertEqual(status, 200)
        self.assertTrue(kind.startswith("text/event-stream"))
        events = [line[6:] for line in raw.decode().split("\n\n") if line.startswith("data: ")]
        self.assertEqual(events[-1], "[DONE]")
        first = json.loads(events[0])
        self.assertEqual(first["choices"][0]["delta"]["content"], "The answer is 18.")
        self.assertEqual(json.loads(events[1])["choices"][0]["finish_reason"], "stop")
        self.assertEqual(len(events), 3, "two chunks and [DONE] without include_usage")

    def test_a_hold_over_http_is_409_before_any_stream_byte(self):
        port = self.start(FakeTeam(), decision=("hold", "turnStructure"))
        for path, body in [("/latent/team", {"question": "2+2?"}),
                           ("/v1/chat/completions", {"model": MODEL_ID, "stream": True,
                                                     "messages": [{"role": "user", "content": "2+2?"}]})]:
            status, kind, raw = self.call(port, "POST", path, body)
            self.assertEqual(status, 409, path)
            self.assertTrue(kind.startswith("application/json"), kind)
            self.assertNotIn(b"18", raw)
            self.assertIn(b"turnStructure", raw)

    def test_no_team_loaded_is_503_and_foreign_hosts_need_opt_in(self):
        port = self.start(None)
        self.assertEqual(self.call(port, "GET", "/v1/models")[0], 503)
        port = self.start(FakeTeam(), allowed_hosts=("host.docker.internal:4320",))
        self.assertEqual(self.call(port, "GET", "/v1/models", host="host.docker.internal:4320")[0], 200)
        self.assertEqual(self.call(port, "GET", "/v1/models", host="evil.example:4320")[0], 403)
        self.assertEqual(self.call(port, "GET", "/v1/models", headers={"Origin": "https://evil.example"})[0], 403)


class AllowedHostsTest(unittest.TestCase):
    def test_entries_must_be_host_and_port(self):
        from latent_pool.server import _allowed_hosts
        self.assertEqual(_allowed_hosts(" Host.Docker.Internal:4320 , ,localhost:4320"),
                         ["host.docker.internal:4320", "localhost:4320"])
        for bad in ["host.docker.internal", "*:4320", "0.0.0.0:4320", "a:b"]:
            with self.assertRaises(SystemExit):
                _allowed_hosts(bad)


if __name__ == "__main__":
    unittest.main()
