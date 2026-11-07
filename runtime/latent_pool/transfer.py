"""M2b: serve a trained cross-family mapper at POST /latent/transfer.

The sender model prefills the document, the mapper writes the receiver's KV cache,
and the receiver answers the question from that cache without reading the text.
Tensors never leave this process: the response is the receiver's answer text plus a
receipt. The answer carries no citations, so it is marked unverified, like the M2a
answer field.

Body: {"sender", "receiver", "question", and exactly one of "text" or "paths"}.
Paths follow the M2a rules (under LATENT_ROOT, no secrets, size limits).
"""
import threading
import time

from . import ApiError
from .prefix import load_files

FIELDS = frozenset({"sender", "receiver", "question", "text", "paths", "maxNewTokens"})
MAX_TEXT_CHARS = 8000
MAX_QUESTION_CHARS = 2000
MAX_NEW_TOKENS = 64
SLOT_WAIT_SECONDS = 5.0
BUSY = "The transfer model is busy. Try again shortly."


class TransferService:
    """One trained pair on one device; requests run one at a time."""

    def __init__(self, root, pair, max_tokens=384, slot_wait=SLOT_WAIT_SECONDS):
        self.root = root
        self.pair = pair
        self.max_tokens = max_tokens
        self.slot_wait = slot_wait
        self._slot = threading.Lock()

    def document(self, body):
        has_text, has_paths = "text" in body, "paths" in body
        if has_text == has_paths:
            raise ApiError(400, "Send exactly one of text or paths.")
        if has_text:
            text = body["text"]
            if not isinstance(text, str) or not text.strip():
                raise ApiError(400, "text must be a non-empty string.")
            if len(text) > MAX_TEXT_CHARS:
                raise ApiError(413, f"text is longer than {MAX_TEXT_CHARS} characters.")
            return text, None
        files = load_files(self.root, body["paths"])
        passage = "\n\n".join("\n".join(lines) for _, lines in files)
        # The same character cap as text mode, checked before any tokenizing (review finding 2).
        if len(passage) > MAX_TEXT_CHARS:
            raise ApiError(413, f"The files hold more than {MAX_TEXT_CHARS} characters.")
        return passage, [path for path, _ in files]

    def __call__(self, body):
        extra = sorted(set(body) - FIELDS)
        if extra:
            raise ApiError(400, f"Unknown field(s): {', '.join(extra)}. Allowed: {', '.join(sorted(FIELDS))}.")
        question = body.get("question")
        if not isinstance(question, str) or not question.strip():
            raise ApiError(400, "question must be a non-empty string.")
        if len(question) > MAX_QUESTION_CHARS:
            raise ApiError(400, f"question is longer than {MAX_QUESTION_CHARS} characters.")
        limit = body.get("maxNewTokens", 32)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_NEW_TOKENS:
            raise ApiError(400, f"maxNewTokens must be an integer from 1 to {MAX_NEW_TOKENS}.")
        passage, paths = self.document(body)

        from latent_transfer.data import doc_text, question_suffix  # torch is only needed when serving M2b
        document = doc_text(passage)
        if not self._slot.acquire(timeout=self.slot_wait):
            raise ApiError(503, BUSY)
        try:
            # Tokenizers are not shared across threads: count tokens inside the slot.
            tokens = len(self.pair.receiver_tok(document, add_special_tokens=False)["input_ids"])
            sender_tokens = len(self.pair.sender_tok(document, add_special_tokens=False)["input_ids"])
            if max(tokens, sender_tokens) > self.max_tokens:
                raise ApiError(413, f"The document is {max(tokens, sender_tokens)} tokens; this mapper was "
                                    f"trained on at most {self.max_tokens}.")
            started = time.perf_counter()
            answer, receipt = self.pair.answer_from_sender(document, question_suffix(question), limit)
            receipt["totalMs"] = round((time.perf_counter() - started) * 1000, 2)
        finally:
            self._slot.release()
        receipt.update({"sender": self.pair.sender_name, "receiver": self.pair.receiver_name,
                        "mapperId": self.pair.checkpoint_id})
        for key in ("alignMs", "senderMs", "mapperMs"):
            receipt[key] = round(receipt[key], 2)
        result = {"mode": "transfer", "answer": answer, "answerVerified": False, "receipt": receipt}
        if paths:
            result["paths"] = paths
        return result


def register_from_env(registry, root, env):
    """LATENT_MAPPER=<checkpoint> loads one trained pair at startup (needs torch and a GPU)."""
    checkpoint = env.get("LATENT_MAPPER")
    if not checkpoint:
        return None
    from latent_transfer.pair import TransferPair
    import torch
    try:
        state = torch.load(checkpoint, map_location="cpu", weights_only=True)
        sender, receiver = state["sender"], state["receiver"]
    except (OSError, RuntimeError, KeyError, TypeError) as error:
        raise SystemExit(f"LATENT_MAPPER is not a usable mapper checkpoint: {checkpoint} ({error})") from None
    device = env.get("LATENT_MAPPER_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
    pair = TransferPair(sender, receiver, device=device, checkpoint=checkpoint)
    service = TransferService(root, pair)
    registry.register(sender, receiver, service, name=f"{sender} -> {receiver} ({pair.checkpoint_id})")
    return service
