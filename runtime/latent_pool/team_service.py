"""M2c serving: the latent agent team behind /latent/team and an OpenAI-compatible API.

Open WebUI (or any OpenAI client) adds http://<host>:4320/v1 as an OpenAI connection
and picks the model `ctm-latent-team`. Each chat turn runs planner, critic and
refiner in latent space on the local model; the solver writes the reply. Only text
leaves the process. Replies are model output, not checked facts.

Every run goes through the W1 guard (latent_team/guard.py): a code watchdog checks each
hand-off and signs a number-only report, and a code supervisor decides. Before the squad
reads anything, the W2 gateway (latent_team/gateway.py) labels the input by origin and
replaces declared secrets and scanner findings with placeholders; /latent/team's question
is the caller's own request, while the chat route's flattened conversation is untrusted as
a whole. Neither route has tools. The output gate replaces any known value an uncleared
answer holds, scans every answer, and puts the values back (declared ones and the ones its
scanner found) only when the request is cleared to receive them. A hold returns
HTTP 409 with the reason and no answer, on both routes, before any byte of an answer is
sent. A fallback answer comes from the solver alone and is marked in the receipt. No
thought record, vector or per-step value is ever part of a response.

Notes for operators:
- There is no authentication: any process that can reach the listener can use the GPU.
  It listens on 127.0.0.1 only; LATENT_ALLOWED_HOSTS opts extra Host names in.
- Open WebUI's background tasks (titles, tags, follow-ups) default to the chat model.
  Set a separate task model there, or each task runs a full team pass and holds the slot.
"""
import json
import re
import threading
import time
import uuid

from latent_team.guard import Guard

from . import ApiError

MODEL_ID = "ctm-latent-team"
TEAM_FIELDS = frozenset({"question", "latentSteps", "maxNewTokens", "secrets", "clearance", "task"})
ABSTAINED = ("The latent team declined to answer: on this kind of task its confidence was below the calibrated "
             "threshold, so no answer is released.")
MAX_SECRETS, SECRET_CHARS = 16, (8, 512)
PROJECT = "local"   # one project per runtime today; the gateway refuses spans of any other
MAX_QUESTION_CHARS = 8000
MAX_STEPS = 80
MAX_NEW_TOKENS = 1024
SLOT_WAIT_SECONDS = 5.0
BUSY = "The latent team is busy. Try again shortly."
GONE = "The client left before the team started."
HELD = "The latent team's answer was held by its watchdog ({reason}); no answer was returned."
TIME_CAP_SECONDS = 180.0


class SseResponse:
    """A route result the server writes as text/event-stream instead of JSON."""

    def __init__(self, events):
        self.events = events  # list of JSON-serializable objects; "[DONE]" is appended


def _int(body, name, default, low, high):
    value = body.get(name, default)
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise ApiError(400, f"{name} must be an integer from {low} to {high}.")
    return value


def declared_secrets(body):
    """W2: values the caller declares secret ("secrets", also accepted as an extension field on
    the chat route). Each is replaced by a placeholder before the model sees any text."""
    secrets = body.get("secrets", [])
    low, high = SECRET_CHARS
    if not isinstance(secrets, list) or len(secrets) > MAX_SECRETS or not all(
            isinstance(s, str) and low <= len(s) <= high for s in secrets):
        raise ApiError(400, f"secrets must be a list of at most {MAX_SECRETS} strings of {low} to {high} characters.")
    return secrets


def task_name(body):
    """W3: the kind of task a request names for calibrated abstention, or None."""
    task = body.get("task")
    if task is not None and (not isinstance(task, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,39}", task)):
        raise ApiError(400, "task must be a short lower-case name, such as gsm8k-arithmetic.")
    return task


def _text_content(content):
    """OpenAI message content: a string, or a list of parts of which text parts count."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content
                         if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str))
    return ""


FIT_MARKER = "\n[... middle omitted: the conversation was longer than the team accepts ...]\n"


def fit(text, limit=MAX_QUESTION_CHARS):
    """Keep the head and the tail of an oversized prompt: instructions usually open a
    message and the question closes it."""
    if len(text) <= limit:
        return text
    marker = FIT_MARKER
    head = (limit - len(marker)) // 4
    return text[:head] + marker + text[-(limit - len(marker) - head):]


def build_question(messages, limit=MAX_QUESTION_CHARS):
    """System and developer messages become instructions, earlier turns context, the
    last user message the question."""
    turns = [(m.get("role"), _text_content(m.get("content")).strip()) for m in messages]
    last_user = max((i for i, (role, text) in enumerate(turns) if role == "user" and text), default=None)
    if last_user is None:
        raise ApiError(400, "messages need at least one user message with text.")
    instructions = [text for role, text in turns if role in ("system", "developer") and text]
    history = [f"{role}: {text}" for i, (role, text) in enumerate(turns)
               if i != last_user and role in ("user", "assistant") and text]
    parts = []
    if instructions:
        parts.append("Instructions:\n" + "\n".join(instructions))
    if history:
        parts.append("Conversation so far:\n" + "\n".join(history))
    parts.append(("New message: " if parts else "") + turns[last_user][1])
    text = "\n\n".join(parts)
    return text if limit is None else fit(text, limit)


class TeamService:
    def __init__(self, team, steps=40, slot_wait=SLOT_WAIT_SECONDS, guard=None):
        self.team = team
        self.steps = steps
        self.slot_wait = slot_wait
        self.guard = guard if guard is not None else Guard(team, time_cap=TIME_CAP_SECONDS,
                                                           reference=reference_from_env(team))
        self._slot = threading.Lock()

    def gateway(self, steps, max_new_tokens, secrets=(), clearance="public"):
        """A gateway for one run, its permissions fixed before any span is read: no tools,
        the run's budgets, and the output's clearance."""
        from latent_team.gateway import Gateway, Permissions
        gateway = Gateway(PROJECT, declared_secrets=secrets)
        gateway.fix_permissions(Permissions(tools=(), max_tool_calls=0, max_steps=steps, max_new_tokens=max_new_tokens,
                                            max_seconds=TIME_CAP_SECONDS, clearance=clearance))
        return gateway

    def run(self, question, steps, max_new_tokens, gone=None, origin="request", secrets=(), clearance="public",
            task=None, gateway=None):
        from latent_team.abstain import service_profile
        from latent_team.gateway import GatewayError, Span
        gateway = gateway if gateway is not None else self.gateway(steps, max_new_tokens, secrets, clearance)
        try:
            gateway.admit([Span(origin, origin, question)])
            # The cut of an oversized conversation comes after the gateway, so no secret can
            # straddle it, and it never splits a placeholder; the cut text is checked too.
            gateway.fit(MAX_QUESTION_CHARS, FIT_MARKER)
        except GatewayError as error:   # fail closed: the squad reads nothing it could not clear
            raise ApiError(400, f"The gateway refused the input ({error.reason}).") from None
        if not self._slot.acquire(timeout=self.slot_wait):
            raise ApiError(503, BUSY)
        try:
            # A caller that gave up while waiting for the slot gets no GPU work.
            if gone is not None and gone():
                raise ApiError(499, GONE)
            # W3: a calibration applies only to the service profile it was measured on (review
            # W3-4): the route's origin, the clearance and whether secrets were declared.
            profile = service_profile(origin, gateway.permissions.clearance, bool(gateway.declared))
            outcome = self.guard.run([question], steps=steps, max_new_tokens=max_new_tokens, gateways=[gateway],
                                     **({"task": task, "profile": profile} if task else {}))[0]
        finally:
            self._slot.release()
        # Fail closed: the supervisor's hold leaves as an error, so no client can take it
        # for an answer, and nothing of the squad's text goes with it.
        if outcome.decision["action"] == "abstain":   # W3: declining is an outcome, not an error
            return None, outcome, gateway.admission.text
        if outcome.decision["action"] != "release" or outcome.answer is None:
            raise ApiError(409, HELD.format(reason=outcome.decision["reason"]))
        return outcome.answer, outcome, gateway.admission.text

    def receipt(self, outcome):
        return {"model": self.team.model_name, "agents": ["planner", "critic", "refiner", "solver"],
                "system": outcome.system, "latentStepsPerAgent": outcome.latent_steps,
                "latentVectors": outcome.latent_vectors, "generatedTokens": outcome.tokens,
                "seconds": round(outcome.seconds, 3), "decision": dict(outcome.decision),
                "checks": dict(outcome.checks), "audits": dict(outcome.audits),
                "statistical": dict(outcome.statistical), "scores": dict(outcome.scores),
                "gateway": dict(outcome.gateway)}

    def prompt_tokens(self, question):
        tokenizer = getattr(self.team, "tokenizer", None)
        if tokenizer is None:
            return 0
        return len(tokenizer(question, add_special_tokens=False)["input_ids"])

    # ------------------------------------------------------------ /latent/team
    def __call__(self, body, gone=None):
        if set(body) - TEAM_FIELDS:   # never echo a field name: it could be a declared secret
            raise ApiError(400, f"Unknown field. Allowed: {', '.join(sorted(TEAM_FIELDS))}.")
        question = body.get("question")
        if not isinstance(question, str) or not question.strip() or len(question) > MAX_QUESTION_CHARS:
            raise ApiError(400, f"question must be 1 to {MAX_QUESTION_CHARS} characters.")
        steps = _int(body, "latentSteps", self.steps, 0, MAX_STEPS)
        limit = _int(body, "maxNewTokens", 512, 1, MAX_NEW_TOKENS)
        secrets = declared_secrets(body)
        clearance = body.get("clearance", "public")
        if clearance not in ("public", "sensitive"):
            raise ApiError(400, "clearance must be public or sensitive.")
        task = task_name(body)
        answer, outcome, _ = self.run(question, steps, limit, gone, origin="request", secrets=secrets,
                                      clearance=clearance, task=task)
        if answer is None:   # abstained: no model text leaves
            return {"mode": "abstained", "answer": None, "answerVerified": False,
                    "reason": outcome.decision["reason"], "receipt": self.receipt(outcome)}
        return {"mode": "latent-team", "answer": answer, "answerVerified": False, "receipt": self.receipt(outcome)}

    # ------------------------------------------------------------ OpenAI API
    def models(self, _body=None):
        return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "created": 0,
                                            "owned_by": "context-ledger"}]}

    def chat(self, body, gone=None):
        # Like other OpenAI-compatible servers, unknown fields and sampling knobs are
        # ignored. Refused: only what would make the reply silently wrong.
        if body.get("model") != MODEL_ID:
            raise ApiError(404, f"Unknown model. This server offers {MODEL_ID}.")
        if body.get("tools") or body.get("functions"):
            raise ApiError(400, "Tool calling is not supported by the latent team.")
        response_format = body.get("response_format")
        if isinstance(response_format, dict) and response_format.get("type") not in (None, "text"):
            raise ApiError(400, "Only text responses are supported by the latent team.")
        n = body.get("n", 1)
        if n is not None and (n != 1 or isinstance(n, bool) or not isinstance(n, int)):
            raise ApiError(400, "Only n = 1 is supported.")
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages or not all(isinstance(m, dict) for m in messages):
            raise ApiError(400, "messages must be a non-empty list of objects.")
        limit = body.get("max_completion_tokens") or body.get("max_tokens") or 512
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ApiError(400, "max_tokens must be a positive integer.")
        limit = min(limit, MAX_NEW_TOKENS)
        # Permissions are fixed before any message is read (review W2-16): the gateway exists,
        # its budgets and clearance set, before the conversation is flattened.
        # W3: "task" is accepted here too, as an extension field like "secrets" (review W3-1);
        # it is checked before any message. A calibration applies only to the profile it was
        # measured on, so this route's runs are uncalibrated unless one was measured on chat
        # input (W3's was measured on /latent/team requests, review W3-4).
        task = task_name(body)
        gateway = self.gateway(self.steps, limit, declared_secrets(body))
        question = build_question(messages, limit=None)
        # The flattened conversation mixes system text, history and the new message, so its
        # origin is lost: it is untrusted as a whole (docs/watchdog-security.md, "The gateway").
        answer, outcome, admitted = self.run(question, self.steps, limit, gone, origin="chat", gateway=gateway,
                                             task=task)
        if answer is None:   # abstained (W3): a fixed sentence, never model text
            answer = ABSTAINED
        completion = outcome.tokens
        finish = "length" if completion >= limit else "stop"
        prompt = self.prompt_tokens(admitted)   # what the model read, placeholders and all
        usage = {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}
        created, chat_id = int(time.time()), f"chatcmpl-{uuid.uuid4().hex[:24]}"
        if body.get("stream") is True:
            base = {"id": chat_id, "object": "chat.completion.chunk", "created": created, "model": MODEL_ID}
            # The receipt rides on the closing chunk (clients ignore unknown fields), so a
            # streamed fallback answer is marked as one too.
            events = [
                {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": answer},
                                      "finish_reason": None}]},
                {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                 "latent_receipt": self.receipt(outcome)},
            ]
            options = body.get("stream_options")
            if isinstance(options, dict) and options.get("include_usage") is True:
                events.append({**base, "choices": [], "usage": usage})
            return SseResponse(events)
        return {"id": chat_id, "object": "chat.completion", "created": created, "model": MODEL_ID,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": answer}, "finish_reason": finish}],
                "usage": usage, "latent_receipt": self.receipt(outcome)}


def sse_bytes(response):
    return b"".join(f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8")
                    for event in response.events) + b"data: [DONE]\n\n"


def reference_from_env(team, env=None):
    """LATENT_WATCH_REFERENCE=<file> loads the distance score's reference statistics (built by
    latent_team.watch_eval --part reference). It is used only when its SHA-256 is the one the
    committed threshold set names; otherwise the distance check does not run and releases are
    marked unscreened."""
    import hashlib
    import os
    path = (env if env is not None else os.environ).get("LATENT_WATCH_REFERENCE")
    if not path:
        return None
    from latent_team.watchdog import Reference, load_thresholds, team_weights
    thresholds = load_thresholds(team.model_name, team_weights(team)[0])
    with open(path, "rb") as handle:
        data = handle.read()
    if not thresholds or (thresholds.get("distance") or {}).get("reference") != hashlib.sha256(data).hexdigest():
        return None
    # The bytes that were hashed are the bytes that are loaded.
    return Reference.from_bytes(data, device=team.device, weights_hash=thresholds["weightsHash"])


def register_team_from_env(env):
    """LATENT_TEAM_MODEL=<hf model id> loads the team at startup (needs torch and a GPU)."""
    name = env.get("LATENT_TEAM_MODEL")
    if not name:
        return None
    from latent_team.team import LatentTeam
    import torch
    steps_text = env.get("LATENT_TEAM_STEPS", "40")
    try:
        steps = int(steps_text)
    except ValueError:
        raise SystemExit(f"LATENT_TEAM_STEPS must be a number: {steps_text}") from None
    if not 0 <= steps <= MAX_STEPS:
        raise SystemExit(f"LATENT_TEAM_STEPS must be 0 to {MAX_STEPS}.")
    device = env.get("LATENT_TEAM_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
    return TeamService(LatentTeam(name, device=device), steps=steps)
