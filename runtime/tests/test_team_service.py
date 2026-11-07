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


class TeamServiceTest(unittest.TestCase):
    def setUp(self):
        self.team = FakeTeam()
        self.service = TeamService(self.team, steps=40, slot_wait=0.1)

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
        self.assertIn("user: I have 3 apples.", question)
        self.assertIn("New message: I buy 2 more. How many?", question)
        self.assertNotIn("ignored system text", question)

    def test_openai_chat_refusals(self):
        ok = {"model": MODEL_ID, "messages": [{"role": "user", "content": "hi"}]}
        self.assertEqual(self.status(self.service.chat, {**ok, "model": "gpt-4o"}), 404)
        self.assertEqual(self.status(self.service.chat, {**ok, "messages": []}), 400)
        self.assertEqual(self.status(self.service.chat, {**ok, "messages": [{"role": "system", "content": "x"}]}), 400)
        self.assertEqual(self.status(self.service.chat, {**ok, "n": 2}), 400)
        self.assertEqual(self.status(self.service.chat, {**ok, "tools": []}), 400)
        self.assertEqual(self.status(self.service.chat, {**ok, "max_tokens": "big"}), 400)

    def test_busy_and_failure_release(self):
        slow = TeamService(FakeTeam(delay=0.5), slot_wait=0.1)
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

    def start(self, team, allowed_hosts=()):
        config = Config(root=".", vllm_url="http://127.0.0.1:9/v1", model="m", port=0, allowed_hosts=allowed_hosts)
        server = LatentServer(config, client=VllmClient("http://127.0.0.1:9/v1", "m", 1), quiet=True,
                              team=TeamService(team) if team else None)
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

    def test_no_team_loaded_is_503_and_foreign_hosts_need_opt_in(self):
        port = self.start(None)
        self.assertEqual(self.call(port, "GET", "/v1/models")[0], 503)
        port = self.start(FakeTeam(), allowed_hosts=("host.docker.internal:4320",))
        self.assertEqual(self.call(port, "GET", "/v1/models", host="host.docker.internal:4320")[0], 200)
        self.assertEqual(self.call(port, "GET", "/v1/models", host="evil.example:4320")[0], 403)
        self.assertEqual(self.call(port, "GET", "/v1/models", headers={"Origin": "https://evil.example"})[0], 403)


if __name__ == "__main__":
    unittest.main()
