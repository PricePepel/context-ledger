"""Minimal client for vLLM's OpenAI-compatible /v1/chat/completions (stdlib only)."""

import http.client
import json
import socket
import threading
import time
import urllib.error
import urllib.request

from . import ApiError, ModelTimeout

NOT_READY = "Model server is not ready."

_CONTEXT_HINTS = ("maximum context length", "maximum model length", "max_model_len", "context length", "too long")

# vLLM's 400 text when the model's chat template refuses a system message
# (Mistral v0.3: "Conversation roles must alternate user/assistant/...").
_SYSTEM_ROLE_HINTS = ("roles must alternate", "system role not supported", "system role is not supported",
                      "system messages are not supported", "system message is not supported")


class _SystemRoleRefused(Exception):
    pass


class ChatResult:
    __slots__ = ("content", "finish_reason", "prompt_tokens", "completion_tokens", "cached_tokens", "ms")

    def __init__(self, content, finish_reason, prompt_tokens, completion_tokens, cached_tokens, ms):
        self.content = content
        self.finish_reason = finish_reason
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.cached_tokens = cached_tokens
        self.ms = ms


class _Watch:
    """Card H8: keeps one model call inside its whole budget.

    A socket timeout limits each connect, send and receive on its own, so a model
    server that trickles its reply could keep a call going past its budget. The
    watch holds the call's absolute deadline (on time.perf_counter()). A timer shuts
    the call's socket down when the deadline comes, which wakes a blocked connect,
    TLS handshake or receive at once, and every step checks the clock itself, so a
    reply that completes late is never used even if the timer has not run yet.
    """

    def __init__(self, deadline):
        self.deadline = deadline
        self._fired = False
        self._sock = None
        self._lock = threading.Lock()
        self._timer = threading.Timer(max(self.left(), 0), self._expire)
        self._timer.daemon = True
        self._timer.start()

    def left(self):
        return self.deadline - time.perf_counter()

    @property
    def expired(self):
        return self._fired or self.left() <= 0

    def attach(self, sock):
        with self._lock:
            self._sock = sock
            if self._fired:
                self._shut()

    def _expire(self):
        with self._lock:
            self._fired = True
            self._shut()

    def _shut(self):
        if self._sock is not None:
            try:
                # The plain socket's shutdown, even for a TLS socket: SSLSocket.shutdown
                # drops the TLS state that an in-flight read or handshake still uses.
                socket.socket.shutdown(self._sock, socket.SHUT_RDWR)
            except OSError:
                pass

    def cancel(self):
        self._timer.cancel()


# At most this many name lookups run at once. A lookup that outlives its call keeps
# its slot until it ends, so a stalled resolver cannot pile up threads.
_LOOKUPS = threading.BoundedSemaphore(4)


def _numeric(host):
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            socket.inet_pton(family, host)
            return True
        except (OSError, ValueError):
            pass
    return False


def _resolve(host, port, watch):
    """getaddrinfo has no timeout. A numeric host (the usual 127.0.0.1) needs no
    lookup; any other runs on a helper thread that the call waits on only until its
    deadline, with at most _LOOKUPS of them at once."""
    if _numeric(host):
        return socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM, 0, socket.AI_NUMERICHOST)
    if not _LOOKUPS.acquire(timeout=max(watch.left(), 0)):
        raise socket.timeout("name lookup ran out of time")
    done = threading.Event()
    outcome = {}

    def lookup():
        try:
            outcome["addresses"] = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
        except BaseException as error:  # handed to the caller, never left on the thread
            outcome["error"] = error
        finally:
            _LOOKUPS.release()
            done.set()

    try:
        threading.Thread(target=lookup, daemon=True).start()
    except BaseException:
        _LOOKUPS.release()
        raise
    if not done.wait(max(watch.left(), 0)):
        raise socket.timeout("name lookup ran out of time")
    if "error" in outcome:
        error = outcome["error"]
        raise error if isinstance(error, OSError) else OSError(f"name lookup failed: {type(error).__name__}")
    return outcome["addresses"]


# The socket constructor, a seam for tests.
_new_socket = socket.socket


def _connector(watch):
    """socket.create_connection kept to the call's deadline: the lookup is bounded,
    each address gets only what is left, and the socket is handed to the watch before
    it connects, so the connect and a proxy's CONNECT reply can be cut off at the
    deadline. Addresses are tried one after another, as socket.create_connection does."""

    def create_connection(address, timeout=None, source_address=None):
        host, port = address
        last = None
        for family, kind, proto, _, sockaddr in _resolve(host, port, watch):
            left = watch.left()
            if left <= 0:
                raise socket.timeout("connect ran out of time")
            sock = None
            try:
                sock = _new_socket(family, kind, proto)
                sock.settimeout(left if timeout is None else min(timeout, left))
                if source_address:
                    sock.bind(source_address)
                watch.attach(sock)
                sock.connect(sockaddr)
                # The timer may have fired while the socket was still connecting, when
                # shutdown has nothing to act on: check again before handing it over.
                if watch.expired:
                    raise socket.timeout("connect ran out of time")
                return sock
            except OSError as error:
                if sock is not None:
                    sock.close()
                last = error
                if watch.expired:
                    raise socket.timeout("connect ran out of time") from None
        raise last if last is not None else OSError("no address to connect to")

    return create_connection


def _watched(connection_class, watch):
    """A connection class whose socket is made by _connector."""

    class Watched(connection_class):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._create_connection = _connector(watch)

    return Watched


def _watched_tls(watch):
    """HTTPSConnection whose TLS socket is handed to the watch before the handshake.

    wrap_socket moves the descriptor into a new SSLSocket and leaves the plain socket
    detached, so the watch must hold the SSLSocket: it is attached first, and the
    handshake then runs with only what is left of the deadline.
    """

    class WatchedTLS(_watched(http.client.HTTPSConnection, watch)):
        def connect(self):
            http.client.HTTPConnection.connect(self)
            server_hostname = self._tunnel_host or self.host
            sock = self._context.wrap_socket(self.sock, server_hostname=server_hostname,
                                             do_handshake_on_connect=False)
            self.sock = sock
            watch.attach(sock)
            left = watch.left()
            if left <= 0:
                raise socket.timeout("TLS handshake ran out of time")
            sock.settimeout(left if self.timeout is None else min(self.timeout, left))
            sock.do_handshake()

    return WatchedTLS


class _WatchedHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, watch):
        super().__init__()
        self.watch = watch

    def http_open(self, req):
        return self.do_open(_watched(http.client.HTTPConnection, self.watch), req)


_tls = None


def _tls_context():
    """One verifying TLS context, made the first time a call uses https."""
    global _tls
    if _tls is None:
        import ssl
        _tls = ssl.create_default_context()
    return _tls


class _WatchedHTTPSHandler(urllib.request.HTTPSHandler):
    """Always installed, so no https hop of a call (a proxy, say) leaves the watch.
    The TLS context is made only when a call first uses https."""

    def __init__(self, watch):
        urllib.request.AbstractHTTPHandler.__init__(self)
        self.watch = watch

    def https_open(self, req):
        return self.do_open(_watched_tls(self.watch), req, context=_tls_context())


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A model server has no reason to redirect, and a followed redirect would be a
    second call inside the first one's budget. A 3xx is reported as it is."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _open(request, timeout, watch):
    """urlopen, with every socket of the call kept to watch (the seam tests patch).

    Proxies come from the environment as with urlopen; redirects are not followed;
    an opener installed with install_opener() is not used.
    """
    opener = urllib.request.build_opener(_WatchedHTTPHandler(watch), _WatchedHTTPSHandler(watch), _NoRedirect())
    return opener.open(request, timeout=timeout)


def _is_timeout(error):
    return isinstance(error, (socket.timeout, TimeoutError)) or isinstance(
        getattr(error, "reason", None), (socket.timeout, TimeoutError))


def _int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


class VllmClient:
    def __init__(self, base_url, model, timeout=300.0):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        # Set for good the first time the chat template refuses a system message;
        # from then on the system text opens the user message instead. It stays the
        # first thing in the prompt, so the shared prefix still hits the cache.
        self.fold_system = False

    def messages(self, system, user):
        if self.fold_system:
            return [{"role": "user", "content": f"{system}\n\n{user}"}]
        return [{"role": "system", "content": system}, {"role": "user", "content": user}]

    def chat(self, system, user, max_tokens, schema=None, schema_name="output", timeout=None):
        """Send one chat completion at temperature 0 and return a ChatResult.

        timeout, when given, shortens this call's deadline below self.timeout
        (the pool passes what is left of the request deadline).

        Raises ApiError(503) when vLLM cannot be reached or is still loading,
        ApiError(413) when the prompt does not fit the model's context, and
        ApiError(502) for any other failure of the model server. A chat template
        that refuses a system message (Mistral v0.3) is retried once with the
        system text folded into the user message, and later calls fold at once.
        """
        budget = self.timeout if timeout is None else min(self.timeout, timeout)
        started = time.perf_counter()
        # One absolute deadline for the call, both attempts included (card H8).
        deadline = started + budget
        try:
            return self._chat(system, user, max_tokens, schema, schema_name, deadline)
        except _SystemRoleRefused:
            self.fold_system = True
        # The retry gets only what is left of this call's budget, and the receipt's ms
        # covers both attempts, so a slow refusal cannot hold a slot past the deadline.
        if deadline - time.perf_counter() <= 0:
            raise ModelTimeout()
        try:
            result = self._chat(system, user, max_tokens, schema, schema_name, deadline)
        except _SystemRoleRefused:
            raise ApiError(502, "Model server returned HTTP 400.") from None
        result.ms = round((time.perf_counter() - started) * 1000)
        return result

    def _chat(self, system, user, max_tokens, schema, schema_name, deadline):
        folded = self.fold_system
        body = {
            "model": self.model,
            "messages": self.messages(system, user),
            "max_tokens": max_tokens,
            "temperature": 0,
        }
        if schema is not None:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": schema_name, "schema": schema},
            }
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + "/chat/completions",
            data=data,
            method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        started = time.perf_counter()
        # The socket timeout still bounds each operation; the watch bounds the call.
        watch = _Watch(deadline)
        try:
            if watch.expired:
                raise ModelTimeout()
            with _open(request, timeout=watch.left(), watch=watch) as response:
                raw = response.read()
            if watch.expired:
                raise ModelTimeout()
        except urllib.error.HTTPError as error:
            detail = ""
            try:
                detail = error.read(4096).decode("utf-8", "replace").lower()
            except (OSError, http.client.HTTPException):
                pass
            finally:
                error.close()
            # Checked after the body: an error that finishes late is a timeout, so a
            # deadline-capped 503 or 400 is never reported as the model's answer.
            if watch.expired:
                raise ModelTimeout() from None
            if error.code == 503:
                raise ApiError(503, NOT_READY) from None
            if error.code == 400 and any(hint in detail for hint in _CONTEXT_HINTS):
                raise ApiError(413, "The files do not fit in the model's context.") from None
            if error.code == 400 and not folded and any(hint in detail for hint in _SYSTEM_ROLE_HINTS):
                raise _SystemRoleRefused() from None
            raise ApiError(502, f"Model server returned HTTP {error.code}.") from None
        except (socket.timeout, TimeoutError):
            raise ModelTimeout() from None
        except (urllib.error.URLError, ConnectionError, OSError) as error:
            # A connect that timed out is wrapped in URLError: it is a timeout too, so
            # a read whose deadline set this budget returns 504, not 503 (card H8).
            if watch.expired or _is_timeout(error):
                raise ModelTimeout() from None
            raise ApiError(503, NOT_READY) from None
        except http.client.HTTPException:
            # A reply cut short, here usually by the watch shutting the socket.
            if watch.expired:
                raise ModelTimeout() from None
            raise ApiError(502, "Model server sent an unreadable response.") from None
        finally:
            watch.cancel()
        ms = round((time.perf_counter() - started) * 1000)

        try:
            payload = json.loads(raw.decode("utf-8"))
            choice = payload["choices"][0]
            content = choice["message"]["content"]
            if content is None:
                content = ""
            if not isinstance(content, str):
                raise TypeError("content")
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            raise ApiError(502, "Model server sent an unreadable response.") from None
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        details = usage.get("prompt_tokens_details")
        cached = _int(details.get("cached_tokens")) if isinstance(details, dict) else 0
        if time.perf_counter() >= deadline:
            raise ModelTimeout()  # read and parsed, but after the deadline: never used
        return ChatResult(
            content=content,
            finish_reason=choice.get("finish_reason") if isinstance(choice, dict) else None,
            prompt_tokens=_int(usage.get("prompt_tokens")),
            completion_tokens=_int(usage.get("completion_tokens")),
            cached_tokens=cached,
            ms=ms,
        )
