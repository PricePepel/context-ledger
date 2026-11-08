"""Warm latent pool runtime for Context Ledger (milestone M2a).

One local open model reads a set of files once. vLLM keeps the KV cache for
that shared prefix warm, and every later call for the same prefix (planner,
workers, synthesizer) differs only in its user message. See
docs/latent-read.md for the contract.
"""


class ApiError(Exception):
    """An error that maps to an HTTP status and a JSON {"error": message} body."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message
