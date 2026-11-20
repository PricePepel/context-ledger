"""H7: a model call whose timeout was capped by the read deadline is a 504.

On Windows the socket timeout and time.monotonic() tick at about 15.6 ms, so a
socket can time out while remaining() still shows a few milliseconds left. These
tests make the timeout fire with the deadline still ahead, so they do not depend
on the clock's resolution.
"""

import io
import socket
import time
import unittest
import urllib.error
from unittest import mock

from latent_pool import ApiError
from latent_pool.pool import DEADLINE, _Run
from latent_pool.vllm_client import VllmClient


def raise_timeout(*args, **kwargs):
    raise socket.timeout("timed out")


def raise_http_500(request, *args, **kwargs):
    raise urllib.error.HTTPError(request.full_url, 500, "boom", {}, None)


def run_with(client, seconds_left):
    return _Run(client, "system", time.monotonic() + seconds_left)


class CappedTimeoutTest(unittest.TestCase):
    def call(self, run, opener):
        with mock.patch("latent_pool.vllm_client._open", opener):
            with self.assertRaises(ApiError) as caught:
                run.call("reader", "user", 16)
        return caught.exception

    def test_timeout_capped_by_the_deadline_is_504_with_time_left(self):
        # The deadline (5 s away) is below the client's own 30 s timeout, so it set
        # this call's timeout. The socket times out while remaining() is still > 0.
        run = run_with(VllmClient("http://127.0.0.1:9", "m", timeout=30), 5)
        timeouts = []

        def record_then_time_out(request, *args, timeout=None, **kwargs):
            timeouts.append(timeout)
            raise_timeout()

        error = self.call(run, record_then_time_out)
        self.assertGreater(run.remaining(), 0)
        self.assertEqual((error.status, error.message), (504, DEADLINE))
        # The socket got what was left of the deadline, not the client's 30 s.
        self.assertEqual(len(timeouts), 1)
        self.assertLessEqual(timeouts[0], 5)

    def test_timeout_on_the_folded_retry_is_504_with_time_left(self):
        # A chat template refuses the system message, and the folded retry times out.
        run = run_with(VllmClient("http://127.0.0.1:9", "m", timeout=30), 5)
        timeouts = []

        def refuse_then_time_out(request, *args, timeout=None, **kwargs):
            timeouts.append(timeout)
            if len(timeouts) == 1:
                body = io.BytesIO(b"system role not supported")
                raise urllib.error.HTTPError(request.full_url, 400, "bad", {}, body)
            raise_timeout()

        error = self.call(run, refuse_then_time_out)
        self.assertGreater(run.remaining(), 0)
        self.assertEqual((error.status, error.message), (504, DEADLINE))
        self.assertEqual(len(timeouts), 2)
        self.assertLessEqual(timeouts[1], timeouts[0])
        self.assertLessEqual(timeouts[0], 5)

    def test_folded_retry_with_no_budget_left_is_504(self):
        # The refusal itself uses up the call's budget, so the retry is never sent.
        run = run_with(VllmClient("http://127.0.0.1:9", "m", timeout=30), 5)
        calls = []

        now = [0.0]

        def slow_refusal(request, *args, **kwargs):
            calls.append(request)
            now[0] = 6.0  # 6 s pass during the refusal
            body = io.BytesIO(b"system role not supported")
            raise urllib.error.HTTPError(request.full_url, 400, "bad", {}, body)

        # H8: the client reads its clock at several steps, so the clock moves when the
        # refusal arrives instead of after a fixed number of reads.
        with mock.patch("latent_pool.vllm_client.time.perf_counter", lambda: now[0]):
            error = self.call(run, slow_refusal)
        self.assertEqual(len(calls), 1)
        self.assertGreater(run.remaining(), 0)
        self.assertEqual((error.status, error.message), (504, DEADLINE))

    def test_client_timeout_shorter_than_the_deadline_stays_502(self):
        run = run_with(VllmClient("http://127.0.0.1:9", "m", timeout=1), 5)
        error = self.call(run, raise_timeout)
        self.assertEqual((error.status, error.message), (502, "Model server timed out."))

    def test_other_502_with_time_left_stays_502(self):
        run = run_with(VllmClient("http://127.0.0.1:9", "m", timeout=30), 5)
        error = self.call(run, raise_http_500)
        self.assertEqual((error.status, error.message), (502, "Model server returned HTTP 500."))

    def test_other_502_after_the_deadline_is_504_as_before(self):
        client = VllmClient("http://127.0.0.1:9", "m", timeout=30)
        run = run_with(client, 5)

        def late_http_500(request, *args, **kwargs):
            run.deadline = time.monotonic() - 1  # the deadline passes during the call
            raise_http_500(request)

        error = self.call(run, late_http_500)
        self.assertEqual((error.status, error.message), (504, DEADLINE))


if __name__ == "__main__":
    unittest.main()
