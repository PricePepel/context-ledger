"""M2c serving: the latent agent team behind /latent/team and an OpenAI-compatible API.

Open WebUI (or any OpenAI client) adds http://<host>:4320/v1 as an OpenAI connection
and picks the model `ctm-latent-team`. Each chat turn runs planner, critic and
refiner in latent space on the local model; the solver writes the reply. Only text
leaves the process. Replies are model output, not checked facts.

Notes for operators:
- There is no authentication: any process that can reach the listener can use the GPU.
  It listens on 127.0.0.1 only; LATENT_ALLOWED_HOSTS opts extra Host names in.
- Open WebUI's background tasks (titles, tags, follow-ups) default to the chat model.
  Set a separate task model there, or each task runs a full team pass and holds the slot.
"""
import json
import threading
import time
import uuid

from . import ApiError

MODEL_ID = "ctm-latent-team"
TEAM_FIELDS = frozenset({"question", "latentSteps", "maxNewTokens"})
MAX_QUESTION_CHARS = 8000
MAX_STEPS = 80
MAX_NEW_TOKENS = 1024
SLOT_WAIT_SECONDS = 5.0
BUSY = "The latent team is busy. Try again shortly."
GONE = "The client left before the team started."


class SseResponse:
    """A route result the server writes as text/event-stream instead of JSON."""

    def __init__(self, events):
        self.events = events  # list of JSON-serializable objects; "[DONE]" is appended


def _int(body, name, default, low, high):
    value = body.get(name, default)
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise ApiError(400, f"{name} must be an integer from {low} to {high}.")
    return value


def _text_content(content):
    """OpenAI message content: a string, or a list of parts of which text parts count."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content
                         if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str))
    return ""


def fit(text, limit=MAX_QUESTION_CHARS):
    """Keep the head and the tail of an oversized prompt: instructions usually open a
    message and the question closes it."""
    if len(text) <= limit:
        return text
    marker = "\n[... middle omitted: the conversation was longer than the team accepts ...]\n"
    head = (limit - len(marker)) // 4
    return text[:head] + marker + text[-(limit - len(marker) - head):]


def build_question(messages):
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
    return fit("\n\n".join(parts))


class TeamService:
    def __init__(self, team, steps=40, slot_wait=SLOT_WAIT_SECONDS):
        self.team = team
        self.steps = steps
        self.slot_wait = slot_wait
        self._slot = threading.Lock()

    def run(self, question, steps, max_new_tokens, gone=None):
        if not self._slot.acquire(timeout=self.slot_wait):
            raise ApiError(503, BUSY)
        try:
            # A caller that gave up while waiting for the slot gets no GPU work.
            if gone is not None and gone():
                raise ApiError(499, GONE)
            answers, receipt = self.team.latent_mas([question], steps=steps, max_new_tokens=max_new_tokens)
        finally:
            self._slot.release()
        return answers[0], receipt

    def receipt(self, receipt):
        return {"model": self.team.model_name, "agents": ["planner", "critic", "refiner", "solver"],
                "latentStepsPerAgent": receipt.latent_steps, "latentVectors": receipt.latent_vectors,
                "generatedTokens": receipt.generated_tokens[0], "seconds": round(receipt.seconds, 3)}

    def prompt_tokens(self, question):
        tokenizer = getattr(self.team, "tokenizer", None)
        if tokenizer is None:
            return 0
        return len(tokenizer(question, add_special_tokens=False)["input_ids"])

    # ------------------------------------------------------------ /latent/team
    def __call__(self, body, gone=None):
        extra = sorted(set(body) - TEAM_FIELDS)
        if extra:
            raise ApiError(400, f"Unknown field(s): {', '.join(extra)}. Allowed: {', '.join(sorted(TEAM_FIELDS))}.")
        question = body.get("question")
        if not isinstance(question, str) or not question.strip() or len(question) > MAX_QUESTION_CHARS:
            raise ApiError(400, f"question must be 1 to {MAX_QUESTION_CHARS} characters.")
        steps = _int(body, "latentSteps", self.steps, 0, MAX_STEPS)
        limit = _int(body, "maxNewTokens", 512, 1, MAX_NEW_TOKENS)
        answer, receipt = self.run(question, steps, limit, gone)
        return {"mode": "latent-team", "answer": answer, "answerVerified": False, "receipt": self.receipt(receipt)}

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
        question = build_question(messages)
        limit = body.get("max_completion_tokens") or body.get("max_tokens") or 512
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ApiError(400, "max_tokens must be a positive integer.")
        limit = min(limit, MAX_NEW_TOKENS)
        answer, receipt = self.run(question, self.steps, limit, gone)
        completion = receipt.generated_tokens[0]
        finish = "length" if completion >= limit else "stop"
        prompt = self.prompt_tokens(question)
        usage = {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}
        created, chat_id = int(time.time()), f"chatcmpl-{uuid.uuid4().hex[:24]}"
        if body.get("stream") is True:
            base = {"id": chat_id, "object": "chat.completion.chunk", "created": created, "model": MODEL_ID}
            events = [
                {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": answer},
                                      "finish_reason": None}]},
                {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
            ]
            options = body.get("stream_options")
            if isinstance(options, dict) and options.get("include_usage") is True:
                events.append({**base, "choices": [], "usage": usage})
            return SseResponse(events)
        return {"id": chat_id, "object": "chat.completion", "created": created, "model": MODEL_ID,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": answer}, "finish_reason": finish}],
                "usage": usage, "latent_receipt": self.receipt(receipt)}


def sse_bytes(response):
    return b"".join(f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8")
                    for event in response.events) + b"data: [DONE]\n\n"


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
