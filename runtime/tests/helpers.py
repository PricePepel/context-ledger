"""Test helpers: a fake vLLM, a service on port 0 and a raw HTTP client."""

import http.client
import json
import os
import socket
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from latent_pool.server import Config, LatentServer
from latent_pool.vllm_client import VllmClient

MODEL = "Qwen/Qwen2.5-7B-Instruct-AWQ"


def split_messages(body):
    """(system, user) of a request, also when the client folded the system text into
    the user message (a template that refuses system messages): it splits at the ROLE line."""
    messages = body["messages"]
    if len(messages) == 2:
        return messages[0]["content"], messages[1]["content"]
    content = messages[0]["content"]
    at = content.find("\n\nROLE: ")
    return (content[:at], content[at + 2:]) if at >= 0 else ("", content)


def role_of(body):
    user = split_messages(body)[1]
    first = user.split("\n", 1)[0]
    return first[len("ROLE: "):] if first.startswith("ROLE: ") else "unknown"


def default_reply(role, body):
    if role == "reader":
        return "O"
    if role == "planner":
        schema = body["response_format"]["json_schema"]["schema"]
        count = schema["properties"]["subQuestions"]["minItems"]
        return json.dumps({"subQuestions": [f"Sub-question {index}?" for index in range(1, count + 1)]})
    schema = body["response_format"]["json_schema"]["schema"]
    path = schema["properties"]["findings"]["items"]["properties"]["evidence"]["items"]["properties"]["path"]["enum"][0]
    return json.dumps({
        "answer": f"{role} answer",
        "findings": [{"label": f"{role} finding", "evidence": [{"path": path, "startLine": 1, "endLine": 1}]}],
    })


class FakeVllm:
    """An OpenAI-compatible /v1/chat/completions that answers per role.

    replies maps a role to a list of replies (consumed in order, the last one
    repeats) or to a callable(body) -> reply. A reply is a content string or a
    (content, finish_reason) tuple. Requests are recorded in self.requests.
    """

    def __init__(self, replies=None, report_cache=True, status=200, error_message="fake failure", reject_system=False):
        self.replies = dict(replies or {})
        # Like Mistral v0.3's chat template: any system message is refused with HTTP 400.
        self.reject_system = reject_system
        self.rejected = 0
        self.error_message = error_message
        self.report_cache = report_cache
        self.status = status
        self.requests = []
        self.lock = threading.Lock()
        self._seen_systems = set()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length))
                status, payload = fake.answer(self.path, body)
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        # A deadline test hangs up before the fake answers; the broken pipe is expected.
        self.server.handle_error = lambda request, client_address: None
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def systems(self):
        with self.lock:
            return [split_messages(request)[0] for request in self.requests]

    def roles(self):
        with self.lock:
            return [role_of(request) for request in self.requests]

    def answer(self, path, body):
        if path != "/v1/chat/completions":
            return 404, {"error": "not found"}
        if self.status != 200:
            return self.status, {"object": "error", "message": self.error_message, "code": self.status}
        if self.reject_system and any(message["role"] == "system" for message in body["messages"]):
            with self.lock:
                self.rejected += 1
            return 400, {"object": "error", "code": 400,
                         "message": "Conversation roles must alternate user/assistant/user/assistant/..."}
        role = role_of(body)
        system, user = split_messages(body)
        with self.lock:
            self.requests.append(body)
            warm = system in self._seen_systems
            self._seen_systems.add(system)
            source = self.replies.get(role)
            if callable(source):
                reply = source(body)
            elif source:
                reply = source.pop(0) if len(source) > 1 else source[0]
            else:
                reply = default_reply(role, body)
        content, finish = reply if isinstance(reply, tuple) else (reply, "stop")
        prompt_tokens = (len(system) + len(user)) // 4 + 1
        usage = {"prompt_tokens": prompt_tokens, "completion_tokens": max(1, len(content) // 4), "total_tokens": 0}
        if self.report_cache:
            usage["prompt_tokens_details"] = {"cached_tokens": (len(system) // 4) // 16 * 16 if warm else 0}
        return 200, {
            "id": "fake",
            "object": "chat.completion",
            "model": body.get("model"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": finish}],
            "usage": usage,
        }


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Service:
    """The latent pool on port 0 against a vLLM URL, with a temp LATENT_ROOT."""

    def __init__(self, vllm_url, root=None, files=None, registry=None, timeout=10.0, **limits):
        self._tmp = None
        if root is None:
            self._tmp = tempfile.TemporaryDirectory()
            root = self._tmp.name
        self.root = os.path.realpath(root)
        for rel, content in (files or {}).items():
            write(self.root, rel, content)
        config = Config(root=self.root, vllm_url=vllm_url, model=MODEL, port=0, timeout=timeout, **limits)
        self.server = LatentServer(config, client=VllmClient(vllm_url, MODEL, timeout), registry=registry, quiet=True)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        if self._tmp:
            self._tmp.cleanup()

    def request(self, method, path, body=None, headers=None, raw=None, host=None):
        return request(self.port, method, path, body=body, headers=headers, raw=raw, host=host)


def write(root, rel, content):
    full = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    mode = "wb" if isinstance(content, bytes) else "w"
    kwargs = {} if isinstance(content, bytes) else {"encoding": "utf-8", "newline": ""}
    with open(full, mode, **kwargs) as handle:
        handle.write(content)
    return full


def request(port, method, path, body=None, headers=None, raw=None, host=None):
    """Send one request with full control of Host and headers. Returns (status, json)."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    try:
        connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        connection.putheader("Host", host if host is not None else f"127.0.0.1:{port}")
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        merged = {"Content-Type": "application/json"} if data is not None else {}
        merged.update(headers or {})
        for name, value in merged.items():
            if value is not None:
                connection.putheader(name, value)
        if data is not None and "Content-Length" not in merged:
            connection.putheader("Content-Length", str(len(data)))
        connection.endheaders()
        if data is not None:
            connection.send(data)
        response = connection.getresponse()
        text = response.read()
        return response.status, (json.loads(text) if text else None)
    finally:
        connection.close()
