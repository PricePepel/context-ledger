"""HTTP front for the warm latent pool.  Run: python -m latent_pool.server

Listens on 127.0.0.1 only. Requests must carry Host 127.0.0.1:<port> or
localhost:<port> (blocks DNS rebinding) and no Origin header at all: the
ledger calls this service server to server, and browsers attach Origin to
every cross-origin and every POST request, so a web page cannot drive it.
"""

import json
import os
import select
import socket
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from . import ApiError
from .mappers import MapperRegistry
from .transfer import register_from_env
from .team_service import SseResponse, register_team_from_env, sse_bytes
from .pool import REQUEST_DEADLINE_SECONDS, SLOT_WAIT_SECONDS, LatentPool
from .vllm_client import VllmClient

MAX_BODY_BYTES = 64 * 1024
# Whole-request read deadline: the request line, headers and body must all arrive
# within this many seconds. The per-receive timeout alone let a client trickle one
# byte every few seconds and hold a connection (and one of the 64 slots) forever.
READ_DEADLINE_SECONDS = 15.0  # merged: Leo's live-verified value
DRAIN_LIMIT = 1024 * 1024
DEFAULT_VLLM_URL = "http://127.0.0.1:8000/v1"
DEFAULT_MODEL = "Qwen/Qwen2.5-7B-Instruct-AWQ"
DEFAULT_PORT = 4320


class Config:
    def __init__(self, root, vllm_url=DEFAULT_VLLM_URL, model=DEFAULT_MODEL, port=DEFAULT_PORT, timeout=300.0,
                 deadline=REQUEST_DEADLINE_SECONDS, slot_wait=SLOT_WAIT_SECONDS, allowed_hosts=()):
        self.root = root
        # Extra Host header values to accept, e.g. "host.docker.internal:4320" for Open WebUI
        # in Docker. The server still listens on 127.0.0.1 only.
        self.allowed_hosts = tuple(allowed_hosts)
        self.deadline = deadline
        self.slot_wait = slot_wait
        self.vllm_url = vllm_url
        self.model = model
        self.port = port
        self.timeout = timeout


def load_config(env=None):
    env = os.environ if env is None else env
    root = env.get("LATENT_ROOT", "")
    if not root:
        raise SystemExit("LATENT_ROOT is required: the directory the service may read.")
    if not os.path.isdir(root):
        raise SystemExit(f"LATENT_ROOT is not a directory: {root}")
    port_text = env.get("LATENT_PORT", str(DEFAULT_PORT))
    try:
        port = int(port_text)
    except ValueError:
        raise SystemExit(f"LATENT_PORT must be a number: {port_text}") from None
    if not 0 <= port <= 65535:
        raise SystemExit(f"LATENT_PORT is out of range: {port}")
    return Config(
        root=os.path.realpath(root),
        vllm_url=env.get("VLLM_URL") or DEFAULT_VLLM_URL,
        model=env.get("LATENT_MODEL") or DEFAULT_MODEL,
        port=port,
        allowed_hosts=_allowed_hosts(env.get("LATENT_ALLOWED_HOSTS", "")),
    )


def _allowed_hosts(text):
    """Comma-separated host:port names, e.g. host.docker.internal:4320. Wildcards,
    bare names and unspecified addresses are refused at startup."""
    hosts = []
    for entry in (part.strip().lower() for part in text.split(",")):
        if not entry:
            continue
        name, _, port = entry.rpartition(":")
        if not name or not port.isdigit() or "*" in name or name in ("0.0.0.0", "[::]"):
            raise SystemExit(f"LATENT_ALLOWED_HOSTS entries must be host:port names, not {entry!r}.")
        hosts.append(entry)
    return hosts


def _reject_constant(name):
    raise ValueError(name)


class Handler(BaseHTTPRequestHandler):
    server_version = "latent-pool"
    sys_version = ""
    # Per-recv deadline. The ledger sends each request in one burst, so a client
    # that trickles bytes is cut off quickly; the connection cap bounds the rest.
    timeout = 10

    read_deadline = READ_DEADLINE_SECONDS

    # ------------------------------------------------------------ plumbing

    def setup(self):
        super().setup()
        self._deadline_timer = threading.Timer(self.read_deadline, self._read_too_slow)
        self._deadline_timer.daemon = True
        self._deadline_timer.start()

    def _read_too_slow(self):
        """Cut a client that has not sent its whole request in time."""
        try:
            self.request.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def _request_read(self):
        """The request is fully read: from here on, time belongs to the work."""
        self._deadline_timer.cancel()

    def finish(self):
        self._deadline_timer.cancel()
        try:
            super().finish()
        except OSError:  # the client already hung up; nothing left to flush to
            pass

    def _client_gone(self):
        """True once the client has closed its side (Leo's disconnect check)."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    def log_message(self, format, *args):
        if not getattr(self.server, "quiet", False):
            super().log_message(format, *args)

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        self.close_connection = True

    def send_sse(self, response):
        """An OpenAI-style event stream (the whole reply is ready, so it is sent at once)."""
        data = sse_bytes(response)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        self.close_connection = True

    def send_error(self, code, message=None, explain=None):
        """Malformed request lines and headers also get a JSON error body."""
        self.send_json(code, {"error": message or "Bad request."})

    def _allowed(self):
        port = self.server.server_port
        host = (self.headers.get("Host") or "").strip().lower()
        extra = getattr(getattr(self.server, "config", None), "allowed_hosts", ())
        if host not in (f"127.0.0.1:{port}", f"localhost:{port}", *extra):
            raise ApiError(403, "Host not allowed.")
        if self.headers.get("Origin") is not None:
            raise ApiError(403, "Cross-origin requests are not allowed.")

    def _read_json(self):
        content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        length_text = self.headers.get("Content-Length")
        if self.headers.get("Transfer-Encoding") or length_text is None:
            raise ApiError(400, "Content-Length is required.")
        try:
            length = int(length_text)
        except ValueError:
            raise ApiError(400, "Content-Length is invalid.") from None
        if length < 0:
            raise ApiError(400, "Content-Length is invalid.")
        if length > MAX_BODY_BYTES:
            raise ApiError(413, f"The request body exceeds {MAX_BODY_BYTES // 1024} KiB.")
        raw = self.rfile.read(length)
        self._body_read = True
        if content_type != "application/json":
            raise ApiError(400, "Content-Type must be application/json.")
        try:
            body = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise ApiError(400, "The request body is not valid JSON.") from None
        if not isinstance(body, dict):
            raise ApiError(400, "The request body must be a JSON object.")
        try:  # a JSON escape for a lone surrogate parses, but cannot be sent on as UTF-8
            json.dumps(body, ensure_ascii=False).encode("utf-8")
        except UnicodeEncodeError:
            raise ApiError(400, "The request body contains invalid Unicode.") from None
        return body

    def _drain(self):
        """Read an unread body so the client sees our error rather than a reset."""
        if getattr(self, "_body_read", False):
            return
        self._body_read = True
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return
        if 0 < length <= DRAIN_LIMIT:
            try:
                self.rfile.read(length)
            except OSError:
                pass

    def _route(self, method):
        self._body_read = False
        try:
            self._allowed()
            path = urlsplit(self.path).path
            routes = self.server.routes
            if path not in routes:
                raise ApiError(404, "Not found.")
            handler = routes[path].get(method)
            if handler is None:
                raise ApiError(405, "Method not allowed.")
            body = self._read_json() if method == "POST" else None
            self._request_read()
            result = handler(body, self._client_gone)
            if isinstance(result, SseResponse):
                self.send_sse(result)
            else:
                self.send_json(200, result)
        except ApiError as error:
            self._drain()
            self._request_read()
            self.send_json(error.status, {"error": error.message})
        except Exception:  # never leak internals to the caller
            traceback.print_exc(file=sys.stderr)
            self.send_json(500, {"error": "Internal error."})

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_PATCH(self):
        self._route("PATCH")

    def do_DELETE(self):
        self._route("DELETE")

    def do_OPTIONS(self):
        self._route("OPTIONS")

    def do_HEAD(self):
        self._route("HEAD")


MAX_CONNECTIONS = 64


class LatentServer(ThreadingHTTPServer):
    """Caps open connections: each holds a thread, so slow or idle clients
    (slowloris) are refused once the cap is reached instead of piling up."""

    daemon_threads = True

    def __init__(self, config, client=None, registry=None, quiet=False, team=None):
        self.config = config
        self.quiet = quiet
        self._connections = threading.BoundedSemaphore(MAX_CONNECTIONS)
        client = client or VllmClient(config.vllm_url, config.model, config.timeout)
        self.pool = LatentPool(config.root, client, deadline_seconds=config.deadline,
                               slot_wait_seconds=config.slot_wait)
        self.registry = registry or MapperRegistry()
        self.routes = {
            "/latent/warm": {"POST": self.pool.warm},
            "/latent/read": {"POST": self.pool.read},
            # Handlers get the body and a callable that reports a departed client.
            "/latent/mappers": {"GET": lambda _body, _gone: {"pairs": self.registry.pairs()}},
            "/latent/transfer": {"POST": lambda body, _gone: self.registry.transfer(body)},
            # M2c: the latent agent team, and the same team as an OpenAI-compatible model.
            "/latent/team": {"POST": lambda body, gone: self._team()(body, gone)},
            "/v1/models": {"GET": lambda _body, _gone: self._team().models()},
            "/v1/chat/completions": {"POST": lambda body, gone: self._team().chat(body, gone)},
        }
        self.team = team
        super().__init__(("127.0.0.1", config.port), Handler)

    def _team(self):
        if self.team is None:
            raise ApiError(503, "No latent team is loaded. Start the runtime with LATENT_TEAM_MODEL set.")
        return self.team

    def process_request(self, request, client_address):
        if not self._connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._connections.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._connections.release()


def main():
    config = load_config()
    server = LatentServer(config, team=register_team_from_env(os.environ))
    if register_from_env(server.registry, config.root, os.environ):
        print(f"mapper pairs: {server.registry.pairs()}", flush=True)
    print(
        f"latent pool on http://127.0.0.1:{server.server_port} "
        f"(root {config.root}, model {config.model}, vLLM {config.vllm_url})",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
