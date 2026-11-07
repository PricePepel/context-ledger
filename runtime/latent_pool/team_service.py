"""M2c serving: the latent agent team behind /latent/team and an OpenAI-compatible API.

Open WebUI (or any OpenAI client) adds http://<host>:4320/v1 as an OpenAI connection
and picks the model `ctm-latent-team`. Each chat turn runs planner, critic and
refiner in latent space on the local model; the solver writes the reply. Only text
leaves the process. Replies are model output, not checked facts.
"""
import json
import threading
import time
import uuid

from . import ApiError

MODEL_ID = "ctm-latent-team"
TEAM_FIELDS = frozenset({"question", "latentSteps", "maxNewTokens"})
CHAT_FIELDS = frozenset({"model", "messages", "stream", "max_tokens", "max_completion_tokens", "temperature",
                         "top_p", "stream_options", "user", "n", "stop", "presence_penalty", "frequency_penalty",
                         "seed"})
MAX_QUESTION_CHARS = 8000
MAX_STEPS = 80
MAX_NEW_TOKENS = 1024
SLOT_WAIT_SECONDS = 5.0
BUSY = "The latent team is busy. Try again shortly."


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


class TeamService:
    def __init__(self, team, steps=40, slot_wait=SLOT_WAIT_SECONDS):
        self.team = team
        self.steps = steps
        self.slot_wait = slot_wait
        self._slot = threading.Lock()

    def run(self, question, steps, max_new_tokens):
        if not self._slot.acquire(timeout=self.slot_wait):
            raise ApiError(503, BUSY)
        try:
            answers, receipt = self.team.latent_mas([question], steps=steps, max_new_tokens=max_new_tokens)
        finally:
            self._slot.release()
        return answers[0], receipt

    def receipt(self, receipt):
        return {"model": self.team.model_name, "agents": ["planner", "critic", "refiner", "solver"],
                "latentStepsPerAgent": receipt.latent_steps, "latentVectors": receipt.latent_vectors,
                "generatedTokens": receipt.generated_tokens[0], "seconds": round(receipt.seconds, 3)}

    # ------------------------------------------------------------ /latent/team
    def __call__(self, body):
        extra = sorted(set(body) - TEAM_FIELDS)
        if extra:
            raise ApiError(400, f"Unknown field(s): {', '.join(extra)}. Allowed: {', '.join(sorted(TEAM_FIELDS))}.")
        question = body.get("question")
        if not isinstance(question, str) or not question.strip() or len(question) > MAX_QUESTION_CHARS:
            raise ApiError(400, f"question must be 1 to {MAX_QUESTION_CHARS} characters.")
        steps = _int(body, "latentSteps", self.steps, 0, MAX_STEPS)
        limit = _int(body, "maxNewTokens", 512, 1, MAX_NEW_TOKENS)
        answer, receipt = self.run(question, steps, limit)
        return {"mode": "latent-team", "answer": answer, "answerVerified": False, "receipt": self.receipt(receipt)}

    # ------------------------------------------------------------ OpenAI API
    def models(self, _body=None):
        return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "created": 0,
                                            "owned_by": "context-ledger"}]}

    def chat(self, body):
        extra = sorted(set(body) - CHAT_FIELDS)
        if extra:
            raise ApiError(400, f"Unsupported field(s): {', '.join(extra)}.")
        if body.get("model") != MODEL_ID:
            raise ApiError(404, f"Unknown model. This server offers {MODEL_ID}.")
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages or not all(isinstance(m, dict) for m in messages):
            raise ApiError(400, "messages must be a non-empty list of objects.")
        if body.get("n", 1) != 1:
            raise ApiError(400, "Only n = 1 is supported.")
        turns = [(m.get("role"), _text_content(m.get("content"))) for m in messages]
        users = [text for role, text in turns if role == "user" and text.strip()]
        if not users:
            raise ApiError(400, "messages need at least one user message with text.")
        # Earlier turns become context for the team; the last user message is the question.
        history = "\n".join(f"{role}: {text}" for role, text in turns[:-1] if role in ("user", "assistant") and text)
        question = users[-1] if not history else f"Conversation so far:\n{history}\n\nNew message: {users[-1]}"
        question = question[-MAX_QUESTION_CHARS:]
        limit = body.get("max_completion_tokens", body.get("max_tokens", 512))
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ApiError(400, "max_tokens must be a positive integer.")
        answer, receipt = self.run(question, self.steps, min(limit, MAX_NEW_TOKENS))
        created, chat_id = int(time.time()), f"chatcmpl-{uuid.uuid4().hex[:24]}"
        usage = {"prompt_tokens": 0, "completion_tokens": receipt.generated_tokens[0],
                 "total_tokens": receipt.generated_tokens[0]}
        if body.get("stream"):
            base = {"id": chat_id, "object": "chat.completion.chunk", "created": created, "model": MODEL_ID}
            return SseResponse([
                {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": answer},
                                      "finish_reason": None}]},
                {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": usage},
            ])
        return {"id": chat_id, "object": "chat.completion", "created": created, "model": MODEL_ID,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": answer}, "finish_reason": "stop"}],
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
