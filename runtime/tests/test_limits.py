"""Ali's review of ali/latent-pool, findings 1 and 2: deadlines, cancellation, busy, slow clients."""
import json
import socket
import threading
import time
import unittest

import latent_pool.pool as pool_module
import latent_pool.server as server_module
from tests.helpers import FakeVllm, Service, default_reply, role_of

FILES = {"src/a.js": "".join(f"const a{n} = {n};\n" for n in range(1, 11))}
BODY = {"paths": ["src/a.js"], "question": "What is a3?", "budgetTokens": 400, "workers": 1}


def slow(seconds, calls):
    """A fake vLLM reply that records each call and takes `seconds` to answer."""
    def reply(body):
        calls.append(role_of(body))
        time.sleep(seconds)
        return default_reply(role_of(body), body)
    return reply


class Patched(unittest.TestCase):
    """Shrinks the module limits for a test and restores them afterwards."""

    limits = {}

    def setUp(self):
        self._saved = {}
        for (module, name), value in self.limits.items():
            self._saved[(module, name)] = getattr(module, name)
            setattr(module, name, value)

    def tearDown(self):
        for (module, name), value in self._saved.items():
            setattr(module, name, value)


class DeadlineTest(Patched):
    limits = {(pool_module, "REQUEST_DEADLINE_S"): 2.5}

    def test_a_read_that_outruns_its_deadline_returns_504_and_stops_calling(self):
        calls = []
        fake = FakeVllm(replies={role: slow(1.0, calls) for role in ("reader", "planner", "worker", "synthesizer")})
        service = Service(fake.url, files=FILES)
        try:
            status, payload = service.request("POST", "/latent/read", BODY)
        finally:
            service.close()
            fake.close()
        self.assertEqual(status, 504, payload)
        self.assertIn("deadline", payload["error"])
        self.assertLess(len(calls), 4, "the read stopped before running every stage")


class BusyTest(Patched):
    limits = {(pool_module, "SLOT_WAIT_S"): 0.3, (pool_module, "CONCURRENT_PIPELINES"): 1}

    def test_a_full_pool_answers_503_busy_instead_of_queueing_forever(self):
        calls = []
        fake = FakeVllm(replies={role: slow(0.8, calls) for role in ("reader", "planner", "worker", "synthesizer")})
        service = Service(fake.url, files=FILES)
        results = []
        try:
            first = threading.Thread(target=lambda: results.append(service.request("POST", "/latent/read", BODY)))
            first.start()
            time.sleep(0.3)
            started = time.monotonic()
            status, payload = service.request("POST", "/latent/read", BODY)
            waited = time.monotonic() - started
            first.join()
        finally:
            service.close()
            fake.close()
        self.assertEqual(status, 503, payload)
        self.assertIn("busy", payload["error"])
        self.assertLess(waited, 2.0)
        self.assertEqual(results[0][0], 200)


class CancelTest(Patched):
    def test_a_client_that_hangs_up_stops_the_read_between_calls(self):
        calls = []
        fake = FakeVllm(replies={role: slow(0.6, calls) for role in ("reader", "planner", "worker", "synthesizer")})
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


class SlowClientTest(Patched):
    limits = {(server_module, "RECEIVE_DEADLINE_S"): 1.0}

    def test_a_trickling_client_is_cut_off_after_the_receive_deadline(self):
        fake = FakeVllm()
        service = Service(fake.url, files=FILES)
        try:
            sock = socket.create_connection(("127.0.0.1", service.port))
            sock.settimeout(5)
            started = time.monotonic()
            sock.sendall(b"POST /latent/read HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n" % service.port)
            closed = False
            for _ in range(10):  # one header byte every 0.4 s, well inside the 10 s per-recv timeout
                time.sleep(0.4)
                try:
                    sock.sendall(b"X")
                except OSError:
                    closed = True
                    break
            if not closed:
                try:
                    closed = sock.recv(1) == b""
                except OSError:
                    closed = True
            elapsed = time.monotonic() - started
            sock.close()
        finally:
            service.close()
            fake.close()
        self.assertTrue(closed, "the server kept the trickling connection open")
        self.assertLess(elapsed, 4.5)


if __name__ == "__main__":
    unittest.main()
