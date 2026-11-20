"""H8: a model call keeps to its whole budget, not to a timeout per socket read.

A synthetic model server trickles its reply a byte at a time, so every single read
is quick but the reply as a whole is late. The call must stop at its budget and a
late reply must never be used.
"""

import json
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
from unittest import mock

from latent_pool import ApiError, ModelTimeout
from latent_pool.pool import DEADLINE, _Run
from latent_pool.vllm_client import NOT_READY, VllmClient

REPLY = json.dumps({"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}).encode()


class TrickleServer:
    """Answers one request at a time; mode is 'body', 'headers' or 'whole'.

    'body' sends the headers at once and the body a byte every `gap` seconds;
    'headers' trickles the status line and headers too; 'whole' answers at once.
    """

    def __init__(self, mode, gap=0.05):
        self.mode = mode
        self.gap = gap
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.listener.settimeout(0.2)
        self.closing = False
        self.finished = threading.Event()  # set once the last byte has gone out
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.listener.getsockname()[1]}/v1"

    def close(self):
        self.closing = True
        self.thread.join(5)
        self.listener.close()

    def _serve(self):
        while not self.closing:
            try:
                conn, _ = self.listener.accept()
            except (socket.timeout, OSError):
                continue
            threading.Thread(target=self._answer, args=(conn,), daemon=True).start()

    def _answer(self, conn):
        try:
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                data += chunk
            head, _, body = data.partition(b"\r\n\r\n")
            length = 0
            for line in head.split(b"\r\n")[1:]:
                name, _, value = line.partition(b":")
                if name.strip().lower() == b"content-length":
                    length = int(value.strip())
            while len(body) < length:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                body += chunk
            headers = (b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                       b"Content-Length: %d\r\nConnection: close\r\n\r\n" % len(REPLY))
            if self.mode == "error503":
                # The status line and headers at once, then the error body trickled.
                text = b'{"error": "model is loading, please wait a little longer"}'
                conn.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n"
                             b"Content-Length: %d\r\nConnection: close\r\n\r\n" % len(text))
                for index in range(len(text)):
                    if self.closing:
                        return
                    conn.sendall(text[index:index + 1])
                    time.sleep(self.gap)
                return
            if self.mode == "truncated400":
                # A chunk that says 100 bytes, 10 of them, then a hang-up: reading the
                # body raises IncompleteRead (a Content-Length body would read short).
                conn.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n"
                             b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n64\r\n0123456789")
                return
            if self.mode == "redirect":
                conn.sendall(b"HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1:9/v1/chat/completions\r\n"
                             b"Content-Length: 0\r\nConnection: close\r\n\r\n")
                return
            if self.mode == "whole":
                conn.sendall(headers + REPLY)
                return
            if self.mode == "body":
                conn.sendall(headers)
                slow = REPLY
            else:
                slow = headers + REPLY
            for index in range(len(slow)):
                if self.closing:
                    return
                conn.sendall(slow[index:index + 1])
                if index == len(slow) - 1:
                    self.finished.set()
                time.sleep(self.gap)
        except OSError:
            pass  # the client gave up, which is what these tests expect
        finally:
            conn.close()


def run_with(client, seconds_left):
    return _Run(client, "system", time.monotonic() + seconds_left)


class TrickledReplyTest(unittest.TestCase):
    def read(self, mode, client_timeout, seconds_left):
        server = TrickleServer(mode)
        try:
            run = run_with(VllmClient(server.url, "m", timeout=client_timeout), seconds_left)
            started = time.monotonic()
            with self.assertRaises(ApiError) as caught:
                run.call("reader", "user", 16)
            return caught.exception, time.monotonic() - started
        finally:
            server.close()

    def test_trickled_body_stops_at_the_deadline(self):
        # The body takes about 3 s at one byte per 50 ms; the deadline is 1 s away.
        error, elapsed = self.read("body", client_timeout=30, seconds_left=1)
        self.assertEqual((error.status, error.message), (504, DEADLINE))
        self.assertLess(elapsed, 2)

    def test_trickled_headers_stop_at_the_deadline(self):
        error, elapsed = self.read("headers", client_timeout=30, seconds_left=1)
        self.assertEqual((error.status, error.message), (504, DEADLINE))
        self.assertLess(elapsed, 2)

    def test_clients_own_timeout_stays_502(self):
        # The client's 0.5 s timeout is the shorter limit, so this is the model's timeout.
        error, elapsed = self.read("body", client_timeout=0.5, seconds_left=5)
        self.assertEqual((error.status, error.message), (502, "Model server timed out."))
        self.assertLess(elapsed, 1.5)

    def test_a_late_reply_is_a_timeout_not_a_result(self):
        server = TrickleServer("body", gap=0.015)  # about 1 s for the whole body
        try:
            client = VllmClient(server.url, "m", timeout=30)
            started = time.monotonic()
            with self.assertRaises(ModelTimeout):
                client.chat("system", "user", 16, timeout=0.5)
            self.assertLess(time.monotonic() - started, 1)
        finally:
            server.close()

    def test_a_prompt_reply_is_still_used(self):
        server = TrickleServer("whole")
        try:
            run = run_with(VllmClient(server.url, "m", timeout=30), 5)
            result = run.call("reader", "user", 16)
        finally:
            server.close()
        self.assertEqual(result.content, "ok")
        self.assertEqual(len(run.calls), 1)


class _SilentTimer:
    """A watch timer that never fires, as if its thread had not been scheduled yet."""

    def __init__(self, *args, **kwargs):
        self.daemon = True

    def start(self):
        pass

    def cancel(self):
        pass


class ReviewRoundOneTest(unittest.TestCase):
    """Codex review of 5686880."""

    def test_a_late_reply_is_refused_even_if_the_timer_has_not_run(self):
        server = TrickleServer("body", gap=0.02)  # about 1.4 s for the whole body
        try:
            client = VllmClient(server.url, "m", timeout=30)
            # Each byte comes well inside the per-read timeout, so only the deadline
            # check after the read can refuse the reply.
            with mock.patch("latent_pool.vllm_client.threading.Timer", _SilentTimer):
                with self.assertRaises(ModelTimeout):
                    client.chat("system", "user", 16, timeout=0.3)
        finally:
            server.close()
        self.assertTrue(server.finished.wait(2), "the whole reply was sent before it was refused")

    def test_a_slow_503_body_after_the_deadline_is_504(self):
        server = TrickleServer("error503")
        try:
            run = run_with(VllmClient(server.url, "m", timeout=30), 1)
            started = time.monotonic()
            with self.assertRaises(ApiError) as caught:
                run.call("reader", "user", 16)
            elapsed = time.monotonic() - started
        finally:
            server.close()
        self.assertEqual((caught.exception.status, caught.exception.message), (504, DEADLINE))
        self.assertLess(elapsed, 2)

    def test_a_truncated_error_body_is_still_mapped(self):
        server = TrickleServer("truncated400")
        try:
            run = run_with(VllmClient(server.url, "m", timeout=30), 5)
            with self.assertRaises(ApiError) as caught:
                run.call("reader", "user", 16)
        finally:
            server.close()
        self.assertEqual((caught.exception.status, caught.exception.message),
                         (502, "Model server returned HTTP 400."))

    def test_a_stalled_name_lookup_stops_at_the_deadline(self):
        release = threading.Event()
        returned = threading.Event()

        def stalled(host, *args, **kwargs):
            release.wait(10)
            returned.set()
            raise socket.gaierror("synthetic resolver")

        client = VllmClient("http://model.invalid:8000/v1", "m", timeout=30)
        started = time.monotonic()
        with mock.patch("urllib.request.getproxies", lambda: {}), \
                mock.patch("latent_pool.vllm_client.socket.getaddrinfo", stalled):
            with self.assertRaises(ModelTimeout):
                client.chat("system", "user", 16, timeout=0.5)
            elapsed = time.monotonic() - started
            release.set()
            self.assertTrue(returned.wait(5), "the abandoned lookup finished")
        self.assertLess(elapsed, 1.5)

    def test_a_stalled_tls_handshake_stops_at_the_deadline(self):
        listener = socket.create_server(("127.0.0.1", 0))
        held = []
        stop = threading.Event()

        def accept_and_say_nothing():
            listener.settimeout(0.2)
            while not stop.is_set():
                try:
                    held.append(listener.accept()[0])
                except OSError:
                    continue

        thread = threading.Thread(target=accept_and_say_nothing, daemon=True)
        thread.start()
        try:
            client = VllmClient(f"https://127.0.0.1:{listener.getsockname()[1]}/v1", "m", timeout=30)
            started = time.monotonic()
            with self.assertRaises(ModelTimeout):
                client.chat("system", "user", 16, timeout=0.5)
            self.assertLess(time.monotonic() - started, 1.5)
        finally:
            stop.set()
            thread.join(5)
            for conn in held:
                conn.close()
            listener.close()


class ReviewRoundTwoTest(unittest.TestCase):
    """Codex review of 1ecfb27."""

    @unittest.skipUnless(shutil.which("openssl"), "needs the openssl command to make a throwaway certificate")
    def test_a_reply_trickled_over_tls_stops_at_the_deadline(self):
        # wrap_socket moves the descriptor into the TLS socket and detaches the plain
        # one, so the watch must hold the TLS socket. After a normal handshake the
        # server trickles its reply a byte every 50 ms; each read is quick, so only the
        # watch can stop the call. The certificate is made here and never committed.
        with tempfile.TemporaryDirectory() as folder:
            cert, key = os.path.join(folder, "cert.pem"), os.path.join(folder, "key.pem")
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
                            "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1",
                            "-addext", "subjectAltName=IP:127.0.0.1"],
                           check=True, capture_output=True, timeout=60)
            server_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            server_tls.load_cert_chain(cert, key)
            client_tls = ssl.create_default_context(cafile=cert)
        listener = socket.create_server(("127.0.0.1", 0))
        listener.settimeout(5)
        stop = threading.Event()

        def trickle():
            try:
                raw, _ = listener.accept()
                conn = server_tls.wrap_socket(raw, server_side=True)
            except OSError:
                return
            with conn:
                try:
                    data = b""
                    while b"\r\n\r\n" not in data:
                        data += conn.recv(65536)
                    reply = (b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                             b"Content-Length: %d\r\nConnection: close\r\n\r\n" % len(REPLY)) + REPLY
                    for index in range(len(reply)):
                        if stop.is_set():
                            return
                        conn.sendall(reply[index:index + 1])
                        time.sleep(0.05)
                except OSError:
                    pass

        thread = threading.Thread(target=trickle, daemon=True)
        thread.start()
        try:
            client = VllmClient(f"https://127.0.0.1:{listener.getsockname()[1]}/v1", "m", timeout=30)
            started = time.monotonic()
            with mock.patch("urllib.request.getproxies", lambda: {}), \
                    mock.patch("latent_pool.vllm_client._tls_context", lambda: client_tls):
                with self.assertRaises(ModelTimeout):
                    client.chat("system", "user", 16, timeout=1)
            self.assertLess(time.monotonic() - started, 2)
        finally:
            stop.set()
            thread.join(10)
            listener.close()

    def test_a_redirect_is_reported_not_followed(self):
        server = TrickleServer("redirect")
        try:
            run = run_with(VllmClient(server.url, "m", timeout=30), 5)
            with self.assertRaises(ApiError) as caught:
                run.call("reader", "user", 16)
        finally:
            server.close()
        self.assertEqual((caught.exception.status, caught.exception.message),
                         (502, "Model server returned HTTP 302."))

    def test_an_address_whose_socket_cannot_be_made_is_skipped(self):
        server = TrickleServer("whole")
        port = int(server.url.rsplit(":", 1)[1].split("/")[0])
        real_socket = socket.socket

        def addresses(host, *args, **kwargs):
            return [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", port, 0, 0)),
                    (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]

        def no_ipv6(family, *args, **kwargs):
            if family == socket.AF_INET6:
                raise OSError("synthetic: no IPv6 here")
            return real_socket(family, *args, **kwargs)

        try:
            client = VllmClient(f"http://dual.invalid:{port}/v1", "m", timeout=30)
            with mock.patch("urllib.request.getproxies", lambda: {}), \
                    mock.patch("latent_pool.vllm_client.socket.getaddrinfo", addresses), \
                    mock.patch("latent_pool.vllm_client._new_socket", no_ipv6):
                result = client.chat("system", "user", 16, timeout=5)
        finally:
            server.close()
        self.assertEqual(result.content, "ok")

    def test_a_resolver_that_raises_something_odd_is_not_ready_not_a_timeout(self):
        def broken(host, *args, **kwargs):
            raise RuntimeError("synthetic resolver bug")

        run = run_with(VllmClient("http://model.invalid:8000/v1", "m", timeout=30), 5)
        with mock.patch("urllib.request.getproxies", lambda: {}), \
                mock.patch("latent_pool.vllm_client.socket.getaddrinfo", broken):
            with self.assertRaises(ApiError) as caught:
                run.call("reader", "user", 16)
        self.assertEqual((caught.exception.status, caught.exception.message), (503, NOT_READY))


class ReviewRoundThreeTest(unittest.TestCase):
    """Codex review of 027fe2b."""

    def test_the_watch_keeps_the_tls_state_when_it_shuts_a_tls_socket(self):
        from latent_pool.vllm_client import _Watch
        mine, peer = socket.socketpair()
        tls = ssl.create_default_context().wrap_socket(mine, server_hostname="model.invalid",
                                                        do_handshake_on_connect=False)
        watch = _Watch(time.perf_counter() + 30)
        try:
            watch.attach(tls)
            watch._expire()
            self.assertIsNotNone(tls._sslobj, "an in-flight TLS read keeps its state")
            peer.settimeout(2)
            self.assertEqual(peer.recv(16), b"", "the transport was shut down")
        finally:
            watch.cancel()
            tls.close()
            peer.close()

    def test_a_socket_that_connects_after_the_deadline_is_not_handed_over(self):
        from latent_pool.vllm_client import _Watch, _connector
        server = TrickleServer("whole")
        port = int(server.url.rsplit(":", 1)[1].split("/")[0])
        made = []

        class SlowConnect(socket.socket):
            def connect(self, address):
                super().connect(address)
                time.sleep(0.4)  # connected, but only after the deadline

        def slow_socket(*args, **kwargs):
            made.append(SlowConnect(*args, **kwargs))
            return made[-1]

        try:
            with mock.patch("latent_pool.vllm_client.threading.Timer", _SilentTimer), \
                    mock.patch("latent_pool.vllm_client._new_socket", slow_socket):
                watch = _Watch(time.perf_counter() + 0.2)
                with self.assertRaises(socket.timeout):
                    _connector(watch)(("127.0.0.1", port))
        finally:
            server.close()
        self.assertEqual(len(made), 1)
        self.assertEqual(made[0].fileno(), -1, "the late socket was closed")


class _LateClient:
    """A client that answers, or fails with `error`, only after `delay` seconds."""

    timeout = 30

    def __init__(self, delay, error=None):
        self.delay = delay
        self.error = error

    def chat(self, *args, **kwargs):
        time.sleep(self.delay)
        if self.error is not None:
            raise self.error
        from latent_pool.vllm_client import ChatResult
        return ChatResult("ok", "stop", 1, 1, 0, 1)


class PoolDeadlineTest(unittest.TestCase):
    """Codex review of 1ecfb27: the read's own deadline is checked after each call."""

    def test_a_reply_that_lands_after_the_read_deadline_is_504(self):
        run = run_with(_LateClient(0.3), 0.1)
        with self.assertRaises(ApiError) as caught:
            run.call("reader", "user", 16)
        self.assertEqual((caught.exception.status, caught.exception.message), (504, DEADLINE))
        self.assertEqual(run.calls, [])

    def test_a_503_after_the_read_deadline_is_504(self):
        run = run_with(_LateClient(0.3, ApiError(503, NOT_READY)), 0.1)
        with self.assertRaises(ApiError) as caught:
            run.call("reader", "user", 16)
        self.assertEqual((caught.exception.status, caught.exception.message), (504, DEADLINE))

    def test_a_prompt_503_stays_503(self):
        run = run_with(_LateClient(0, ApiError(503, NOT_READY)), 5)
        with self.assertRaises(ApiError) as caught:
            run.call("reader", "user", 16)
        self.assertEqual((caught.exception.status, caught.exception.message), (503, NOT_READY))


class ConnectTimeoutTest(unittest.TestCase):
    def call(self, run, error):
        def fail(request, *args, **kwargs):
            raise error
        with mock.patch("latent_pool.vllm_client._open", fail):
            with self.assertRaises(ApiError) as caught:
                run.call("reader", "user", 16)
        return caught.exception

    def test_connect_timeout_capped_by_the_deadline_is_504(self):
        run = run_with(VllmClient("http://127.0.0.1:9", "m", timeout=30), 5)
        error = self.call(run, urllib.error.URLError(socket.timeout("timed out")))
        self.assertEqual((error.status, error.message), (504, DEADLINE))

    def test_connect_timeout_on_the_clients_own_timeout_is_502(self):
        run = run_with(VllmClient("http://127.0.0.1:9", "m", timeout=1), 5)
        error = self.call(run, urllib.error.URLError(socket.timeout("timed out")))
        self.assertEqual((error.status, error.message), (502, "Model server timed out."))

    def test_refused_connection_stays_503(self):
        run = run_with(VllmClient("http://127.0.0.1:9", "m", timeout=30), 5)
        error = self.call(run, urllib.error.URLError(ConnectionRefusedError("refused")))
        self.assertEqual((error.status, error.message), (503, NOT_READY))


if __name__ == "__main__":
    unittest.main()
