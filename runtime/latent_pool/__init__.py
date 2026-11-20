"""Warm latent pool runtime for Context Ledger (milestone M2a).

One local open model reads a set of files once. vLLM keeps the KV cache for
that shared prefix warm, and every later call for the same prefix (planner,
workers, synthesizer) differs only in its user message. See
docs/latent-read.md for the contract.

The same server also serves M2b transfer (transfer.py, mappers.py) and the
M2c latent team (team_service.py).
"""


class ApiError(Exception):
    """An error that maps to an HTTP status and a JSON {"error": message} body."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class ModelTimeout(ApiError):
    """The model server did not answer within the call's timeout (a 502)."""

    def __init__(self):
        super().__init__(502, "Model server timed out.")
