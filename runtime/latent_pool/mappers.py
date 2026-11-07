"""M2b scaffold: a registry of trained latent mappers between model pairs.

A mapper would carry hidden state from a sender model to a receiver model of a
different family. None is trained yet, so the registry starts empty and
/latent/transfer answers 501. The scaffold fixes the shape for later work.
"""

import hashlib
import threading

from . import ApiError

NO_MAPPER = "No trained mapper for this model pair."


def model_hash(model_id):
    """sha256 hex of the model id string, e.g. "Qwen/Qwen2.5-7B-Instruct-AWQ"."""
    return hashlib.sha256(model_id.encode("utf-8")).hexdigest()


class MapperRegistry:
    """Mappers keyed by (sender model hash, receiver model hash)."""

    def __init__(self):
        self._pairs = {}
        self._lock = threading.Lock()

    def register(self, sender_model, receiver_model, mapper, name=None):
        """mapper is a callable taking the transfer request body and returning a dict."""
        key = (model_hash(sender_model), model_hash(receiver_model))
        with self._lock:
            self._pairs[key] = {"mapper": mapper, "name": name or f"{sender_model} -> {receiver_model}"}

    def lookup(self, sender_model, receiver_model):
        with self._lock:
            entry = self._pairs.get((model_hash(sender_model), model_hash(receiver_model)))
        return entry["mapper"] if entry else None

    def pairs(self):
        with self._lock:
            return [
                {"sender": sender, "receiver": receiver, "name": entry["name"]}
                for (sender, receiver), entry in sorted(self._pairs.items())
            ]

    def transfer(self, body):
        sender, receiver = body.get("sender"), body.get("receiver")
        if not isinstance(sender, str) or not sender or not isinstance(receiver, str) or not receiver:
            raise ApiError(400, "sender and receiver must be model id strings.")
        mapper = self.lookup(sender, receiver)
        if mapper is None:
            raise ApiError(501, NO_MAPPER)
        return mapper(body)
