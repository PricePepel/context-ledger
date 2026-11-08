"""Merged L14 work: Leo's disconnect check and the test gaps from Ali's review of 72ce5cb.

Busy, deadline and slow-client behaviour are covered in test_review_fixes.py.
"""
import json
import socket
import threading
import time
import unittest

from tests.helpers import FakeVllm, Service, default_reply, role_of

FILES = {"src/a.js": "".join(f"const a{n} = {n};\n" for n in range(1, 11))}
BODY = {"paths": ["src/a.js"], "question": "What is a3?", "budgetTokens": 400, "workers": 1}
ROLES = ("reader", "planner", "worker", "synthesizer")


def slow(seconds, calls):
    """A fake vLLM reply that records each call and takes `seconds` to answer."""
    def reply(body):
        calls.append(role_of(body))
        time.sleep(seconds)
        return default_reply(role_of(body), body)
    return reply


class CancelTest(unittest.TestCase):
    def test_a_client_that_hangs_up_stops_the_read_between_calls(self):
        calls = []
        fake = FakeVllm(replies={role: slow(0.6, calls) for role in ROLES})
        service = Service(fake.url, files=FILES)
        try:
            data = json.dumps(BODY).encode()
            sock = socket.create_connection(("127.0.0.1", service.port))
            sock.sendall(
                b"POST /latent/read HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nContent-Type: application/json\r\n"
                b"Content-Length: %d\r\n\r\n%s" % (service.port, len(data), data))
            time.sleep(0.3)
            sock.close()  # the caller gives up during the first model call
            time.sleep(2.5)
        finally:
            service.close()
            fake.close()
        self.assertLessEqual(len(calls), 2, f"calls after the client left: {calls}")


class DeadlineBeforeNextCallTest(unittest.TestCase):
    """Ali's review low 3: the deadline passes while the reader runs, so no planner call follows."""

    def test_only_the_reader_runs_and_the_read_returns_504(self):
        calls = []
        fake = FakeVllm(replies={role: slow(0.5, calls) for role in ROLES})
        service = Service(fake.url, files=FILES, deadline=0.4, timeout=5)
        try:
            status, payload = service.request("POST", "/latent/read", BODY)
        finally:
            service.close()
            fake.close()
        self.assertEqual(status, 504, payload)
        self.assertEqual(calls, ["reader"])


class SlotReleaseWithFourWorkersTest(unittest.TestCase):
    """Ali's review low 3: slots come back after a read that used 4 parallel workers."""

    def test_four_worker_reads_release_their_slots(self):
        fake = FakeVllm()
        service = Service(fake.url, files=FILES, slot_wait=0.2)
        try:
            body = {**BODY, "workers": 4}
            results = []
            threads = [threading.Thread(target=lambda: results.append(service.request("POST", "/latent/read", body)))
                       for _ in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            again = [service.request("POST", "/latent/read", body)[0] for _ in range(4)]
        finally:
            service.close()
            fake.close()
        self.assertEqual([status for status, _ in results], [200] * 4)
        self.assertEqual(again, [200] * 4, "a slot leaked after a 4-worker read")


class SecretRuleTest(unittest.TestCase):
    """Ali's review low 2: wider secret list, env templates allowed, Cn not blocked."""

    def test_secret_rule(self):
        from latent_pool.prefix import is_secret_path, check_path_syntax
        for path in [".git-credentials", ".docker/config.json", ".kube/config", "a/.env", ".env.local"]:
            self.assertTrue(is_secret_path(path.split("/")), path)
        for path in [".env.example", ".env.sample", ".env.template", "src/a.js", ".github/workflows/e2e.yml"]:
            self.assertFalse(is_secret_path(path.split("/")), path)
        # An unassigned code point in Python's tables is not a path error here.
        self.assertEqual(check_path_syntax("src/a" + chr(0x1C89) + ".js")[-1], "a" + chr(0x1C89) + ".js")


if __name__ == "__main__":
    unittest.main()
