"""Minimal client for vLLM's OpenAI-compatible /v1/chat/completions (stdlib only)."""

import json
import socket
import time
import urllib.error
import urllib.request

from . import ApiError

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
        try:
            return self._chat(system, user, max_tokens, schema, schema_name, budget)
        except _SystemRoleRefused:
            self.fold_system = True
        # The retry gets only what is left of this call's budget, and the receipt's ms
        # covers both attempts, so a slow refusal cannot hold a slot past the deadline.
        left = budget - (time.perf_counter() - started)
        if left <= 0:
            raise ApiError(502, "Model server timed out.")
        try:
            result = self._chat(system, user, max_tokens, schema, schema_name, left)
        except _SystemRoleRefused:
            raise ApiError(502, "Model server returned HTTP 400.") from None
        result.ms = round((time.perf_counter() - started) * 1000)
        return result

    def _chat(self, system, user, max_tokens, schema, schema_name, timeout):
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
        try:
            with urllib.request.urlopen(request, timeout=self.timeout if timeout is None else min(self.timeout, timeout)) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            detail = ""
            try:
                detail = error.read(4096).decode("utf-8", "replace").lower()
            except OSError:
                pass
            if error.code == 503:
                raise ApiError(503, NOT_READY) from None
            if error.code == 400 and any(hint in detail for hint in _CONTEXT_HINTS):
                raise ApiError(413, "The files do not fit in the model's context.") from None
            if error.code == 400 and not folded and any(hint in detail for hint in _SYSTEM_ROLE_HINTS):
                raise _SystemRoleRefused() from None
            raise ApiError(502, f"Model server returned HTTP {error.code}.") from None
        except (socket.timeout, TimeoutError):
            raise ApiError(502, "Model server timed out.") from None
        except (urllib.error.URLError, ConnectionError, OSError):
            raise ApiError(503, NOT_READY) from None
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
        return ChatResult(
            content=content,
            finish_reason=choice.get("finish_reason") if isinstance(choice, dict) else None,
            prompt_tokens=_int(usage.get("prompt_tokens")),
            completion_tokens=_int(usage.get("completion_tokens")),
            cached_tokens=cached,
            ms=ms,
        )
