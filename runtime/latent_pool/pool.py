"""Warm and read orchestration (docs/latent-read.md).

/latent/read runs reader -> planner -> workers (parallel) -> synthesizer.
Every call sends the same system message (preamble + rendered prefix), so
only the first call computes the prefix and the rest hit vLLM's warm cache.
"""

import json
import math
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

from . import ApiError
from .prefix import load_files, prefix_id, render_prefix

PREAMBLE = (
    "You are a careful code reader. The files below are your only source of truth. "
    "Each file starts with a line '=== FILE: <path> ===' and every line of a file "
    "starts with its 1-based line number followed by '| '. Answer only from these "
    "files. When they do not say, say so. Cite evidence as a file path with "
    "startLine and endLine taken from the line numbers, plus quote: the code from "
    "those lines copied exactly, without the line-number prefix. State exact values "
    "from the code (numbers with their units, names, strings) in answers and labels "
    "rather than describing them. Do the task in the user message and reply with "
    "JSON only, in the requested shape."
)

MIN_BUDGET, MAX_BUDGET, DEFAULT_BUDGET = 64, 2048, 600
MIN_WORKERS, MAX_WORKERS, DEFAULT_WORKERS = 1, 4, 3
MAX_QUESTION_CHARS = 2000
MAX_FINDINGS = 12
MAX_WORKER_FINDINGS = 3  # each quoted finding costs about 110 tokens
MAX_SPANS = 4
MAX_LABEL_CHARS = 500
MAX_ANSWER_CHARS = 4000
MAX_SUBQUESTION_CHARS = 300
MAX_QUOTE_CHARS = 200
PLANNER_MAX_TOKENS = 400
WORKER_MAX_TOKENS = 900
CONCURRENT_PIPELINES = 4
# Below the ledger's 180 s timeout, so no read outlives the caller (review finding 1).
REQUEST_DEADLINE_S = 150.0
SLOT_WAIT_S = 5.0

_SPACE = re.compile(r"\s+")


class InvalidOutput(Exception):
    """The model's reply did not parse or did not match the expected shape."""


def build_system(prefix):
    """The one system message shared by every call for this prefix."""
    return PREAMBLE + "\n\n" + prefix


def one_line(text, limit):
    return _SPACE.sub(" ", text).strip()[:limit]


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


# ----------------------------------------------------------------- schemas

def planner_schema(count):
    return {
        "type": "object",
        "properties": {
            "subQuestions": {
                "type": "array",
                "items": {"type": "string", "minLength": 1, "maxLength": MAX_SUBQUESTION_CHARS},
                "minItems": count,
                "maxItems": count,
            }
        },
        "required": ["subQuestions"],
        "additionalProperties": False,
    }


def _finding_schema(paths):
    return {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": MAX_LABEL_CHARS},
            "evidence": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "enum": list(paths)},
                        "startLine": {"type": "integer", "minimum": 1},
                        "endLine": {"type": "integer", "minimum": 1},
                        "quote": {"type": "string", "minLength": 1, "maxLength": MAX_QUOTE_CHARS},
                    },
                    "required": ["path", "startLine", "endLine", "quote"],
                    "additionalProperties": False,
                },
                "minItems": 1,
                "maxItems": MAX_SPANS,
            },
        },
        "required": ["label", "evidence"],
        "additionalProperties": False,
    }


def findings_schema(paths, min_findings, max_findings):
    return {
        "type": "object",
        "properties": {
            "answer": {"type": "string", "minLength": 1, "maxLength": 2000},
            "findings": {
                "type": "array",
                "items": _finding_schema(paths),
                "minItems": min_findings,
                "maxItems": max_findings,
            },
        },
        "required": ["answer", "findings"],
        "additionalProperties": False,
    }


# -------------------------------------------------------------- validation

def parse_json_object(content):
    try:
        value = json.loads(content, parse_constant=_reject_constant)
    except (ValueError, TypeError):
        raise InvalidOutput("not JSON") from None
    if not isinstance(value, dict):
        raise InvalidOutput("not a JSON object")
    return value


def _reject_constant(name):
    raise ValueError(name)


def validate_plan(value, count):
    questions = value.get("subQuestions")
    if not isinstance(questions, list) or len(questions) != count:
        raise InvalidOutput("wrong number of sub-questions")
    cleaned = []
    for question in questions:
        if not isinstance(question, str):
            raise InvalidOutput("sub-question is not a string")
        question = one_line(question, MAX_SUBQUESTION_CHARS)
        if not question:
            raise InvalidOutput("empty sub-question")
        cleaned.append(question)
    return cleaned


def clamp_span(span, line_counts):
    """Return a span clamped to the file's real lines, or None if it cannot be kept."""
    if not isinstance(span, dict):
        return None
    path, start, end = span.get("path"), span.get("startLine"), span.get("endLine")
    if not isinstance(path, str) or path not in line_counts or not _is_int(start) or not _is_int(end):
        return None
    count = line_counts[path]
    if start > end:
        start, end = end, start
    start, end = max(1, start), min(count, end)
    if start > end:
        return None
    return {"path": path, "startLine": start, "endLine": end}


def clean_findings(raw, line_counts, max_findings):
    """Validate findings. Returns (findings, dropped).

    Structural problems raise InvalidOutput. Findings whose evidence has no
    valid span after clamping are dropped and counted, as are findings beyond
    max_findings.
    """
    if not isinstance(raw, list):
        raise InvalidOutput("findings is not an array")
    kept, dropped, seen = [], 0, set()
    for finding in raw:
        if not isinstance(finding, dict):
            raise InvalidOutput("finding is not an object")
        label, evidence = finding.get("label"), finding.get("evidence")
        if not isinstance(label, str) or not isinstance(evidence, list):
            raise InvalidOutput("finding has the wrong shape")
        label = one_line(label, MAX_LABEL_CHARS)
        spans = []
        for span in evidence:
            clamped = clamp_span(span, line_counts)
            # A span that needed clamping cited lines that do not exist. Clamping it
            # would hide the invention from the ledger, so the span is dropped instead.
            exact = clamped and isinstance(span, dict) and clamped["startLine"] == span.get("startLine") \
                and clamped["endLine"] == span.get("endLine")
            if exact and clamped not in spans:
                # Pass the quote through for the ledger to verify; it is file text, so
                # keep it on one line and bounded.
                # A blank quote is passed on as "" so the ledger counts it as a bad
                # quote instead of seeing an unquoted finding (6b review).
                quote = span.get("quote")
                if isinstance(quote, str):
                    clamped = {**clamped, "quote": one_line(quote, MAX_QUOTE_CHARS)}
                spans.append(clamped)
        finding_key = (label, tuple((s["path"], s["startLine"], s["endLine"]) for s in spans))
        if not label or not spans or len(kept) >= max_findings or finding_key in seen:
            dropped += 1
            continue
        seen.add(finding_key)
        kept.append({"label": label, "evidence": spans[:MAX_SPANS]})
    return kept, dropped


def validate_answer(value, line_counts, max_findings, require_findings):
    answer = value.get("answer")
    if not isinstance(answer, str):
        raise InvalidOutput("answer is not a string")
    answer = answer.strip()[:MAX_ANSWER_CHARS]
    findings, dropped = clean_findings(value.get("findings"), line_counts, max_findings)
    if require_findings and (not answer or not findings):
        raise InvalidOutput("no answer or no finding with valid evidence")
    return answer, findings, dropped


def slice_tokens_estimate(graph):
    text = json.dumps(graph, ensure_ascii=False, separators=(",", ":"))
    return math.ceil(len(text.encode("utf-16-le")) // 2 / 4)


# ------------------------------------------------------------ request body

def _paths_field(body):
    if "paths" not in body:
        raise ApiError(400, "paths is required.")
    return body["paths"]


def _int_field(body, name, low, high, default):
    value = body.get(name, default)
    if not _is_int(value) or not low <= value <= high:
        raise ApiError(400, f"{name} must be an integer from {low} to {high}.")
    return value


def parse_read_body(body):
    paths = _paths_field(body)
    question = body.get("question")
    if not isinstance(question, str) or not question.strip():
        raise ApiError(400, "question must be a non-empty string.")
    question = question.strip()
    if len(question) > MAX_QUESTION_CHARS:
        raise ApiError(400, f"question must be at most {MAX_QUESTION_CHARS} characters.")
    budget = _int_field(body, "budgetTokens", MIN_BUDGET, MAX_BUDGET, DEFAULT_BUDGET)
    workers = _int_field(body, "workers", MIN_WORKERS, MAX_WORKERS, DEFAULT_WORKERS)
    return paths, question, budget, workers


# -------------------------------------------------------------------- pool

class _Run:
    """One warm or read: the shared system message, its deadline and the call receipts."""

    def __init__(self, client, system, deadline, is_cancelled=None):
        self.client = client
        self.system = system
        self.deadline = deadline
        self.is_cancelled = is_cancelled
        self.calls = []
        self._lock = threading.Lock()

    def call(self, role, user, max_tokens, schema=None):
        # Review finding 1: stop work nobody is waiting for. The ledger gives up at
        # 180 s, so every read ends by REQUEST_DEADLINE_S, and each model call gets only
        # the time that is left. A client that hung up stops the read between calls.
        if self.is_cancelled is not None and self.is_cancelled():
            raise ApiError(503, "The client went away, so the read was stopped.")
        remaining = self.deadline - time.monotonic()
        if remaining <= 1:
            raise ApiError(504, f"The read ran past its {int(REQUEST_DEADLINE_S)} s deadline.")
        result = self.client.chat(self.system, user, max_tokens, schema=schema, schema_name=role,
                                  timeout=min(self.client.timeout, remaining))
        with self._lock:
            self.calls.append({
                "role": role,
                "promptTokens": result.prompt_tokens,
                "cachedTokens": result.cached_tokens,
                "completionTokens": result.completion_tokens,
                "ms": result.ms,
            })
        return result

    def call_json(self, role, user, max_tokens, schema, validate, compact_user=None):
        """Call, parse and validate; retry once on invalid output, then 502.

        A reply cut off at max_tokens would be cut off again by the same request,
        so the retry uses compact_user (a request for a shorter reply) when given.
        """
        cut_off = False
        for _ in range(2):
            prompt = compact_user if cut_off and compact_user else user
            result = self.call(role, prompt, max_tokens, schema)
            cut_off = result.finish_reason == "length"
            try:
                return validate(parse_json_object(result.content))
            except InvalidOutput:
                continue
        if cut_off:
            raise ApiError(502, f"The model's {role} reply was cut off before it finished.")
        raise ApiError(502, f"The model returned an invalid {role} reply.")


def _citable(line_counts):
    """Paths the model may cite: every requested file with at least one line."""
    return [path for path, count in line_counts.items() if count]


def _user(role, *lines):
    return "\n".join([f"ROLE: {role}", *lines])


class LatentPool:
    def __init__(self, root, client):
        self.root = root
        self.client = client
        self._slots = threading.BoundedSemaphore(CONCURRENT_PIPELINES)

    @property
    def model(self):
        return self.client.model

    def _prepare(self, paths):
        files = load_files(self.root, paths)
        prefix = render_prefix(files)
        line_counts = {path: len(lines) for path, lines in files}
        return prefix, line_counts

    def _warm(self, run):
        reader = run.call("reader", _user("reader", "Read the files. Reply with OK."), 1)
        return reader.prompt_tokens

    @contextmanager
    def _slot(self):
        """A pipeline slot, or 503 busy after SLOT_WAIT_S (no unbounded queue)."""
        if not self._slots.acquire(timeout=SLOT_WAIT_S):
            raise ApiError(503, "The latent pool is busy; try again shortly.")
        try:
            yield
        finally:
            self._slots.release()

    def warm(self, body, is_cancelled=None):
        deadline = time.monotonic() + REQUEST_DEADLINE_S
        paths = _paths_field(body)
        prefix, _ = self._prepare(paths)
        pid = prefix_id(prefix)
        with self._slot():
            run = _Run(self.client, build_system(prefix), deadline, is_cancelled)
            prefix_tokens = self._warm(run)
        return {
            "prefixId": pid,
            "prefixTokens": prefix_tokens,
            "receipt": {"model": self.model, "prefixId": pid, "prefixTokens": prefix_tokens, "calls": run.calls},
        }

    def read(self, body, is_cancelled=None):
        started = time.perf_counter()
        deadline = time.monotonic() + REQUEST_DEADLINE_S
        paths, question, budget, workers = parse_read_body(body)
        prefix, line_counts = self._prepare(paths)
        if not any(line_counts.values()):
            raise ApiError(400, "The files are empty, so nothing can be cited.")
        pid = prefix_id(prefix)
        with self._slot():
            run = _Run(self.client, build_system(prefix), deadline, is_cancelled)
            prefix_tokens = self._warm(run)
            sub_questions = self._plan(run, question, workers)
            results = self._work(run, question, sub_questions, line_counts)
            answer, findings, dropped = self._synthesize(run, question, results, line_counts, budget)

        graph = {
            "version": 1,
            "kind": "latent-slice",
            "question": question,
            "answer": answer,
            "findings": [{"id": f"f{index}", **finding} for index, finding in enumerate(findings, 1)],
        }
        prompt_total = sum(call["promptTokens"] for call in run.calls)
        cached_total = sum(call["cachedTokens"] for call in run.calls)
        return {
            "graph": graph,
            "receipt": {
                "model": self.model,
                "prefixId": pid,
                "prefixTokens": prefix_tokens,
                "subQuestions": sub_questions,
                "droppedFindings": dropped,
                "calls": run.calls,
            },
            "stats": {
                "prefixTokens": prefix_tokens,
                "sliceTokensEstimate": slice_tokens_estimate(graph),
                "cachedShare": round(cached_total / prompt_total, 4) if prompt_total else 0.0,
                "totalMs": round((time.perf_counter() - started) * 1000),
            },
        }

    def _plan(self, run, question, count):
        user = _user(
            "planner",
            f"Question: {question}",
            f"Split the question into exactly {count} focused sub-question(s) that, answered "
            "from the files, together answer it. Reply as JSON: {\"subQuestions\": [string, ...]}.",
        )
        # Live debug: the planner was cut off once at 400 tokens; retry compactly.
        compact = user + " Your previous reply was too long: keep each sub-question under 15 words."
        return run.call_json("planner", user, PLANNER_MAX_TOKENS, planner_schema(count),
                             lambda value: validate_plan(value, count), compact_user=compact)

    def _work(self, run, question, sub_questions, line_counts):
        schema = findings_schema(_citable(line_counts), 0, MAX_WORKER_FINDINGS)

        def answer(sub_question):
            user = _user(
                "worker",
                f"Main question: {question}",
                f"Sub-question: {sub_question}",
                "Answer the sub-question from the files. List up to "
                f"{MAX_WORKER_FINDINGS} findings, each a one-line label with evidence spans "
                "(path, startLine, endLine, quote). Reply as JSON: "
                "{\"answer\": string, \"findings\": [{\"label\": string, \"evidence\": "
                "[{\"path\": string, \"startLine\": int, \"endLine\": int, \"quote\": string}]}]}.",
            )

            def validate(value):
                text, findings, _ = validate_answer(value, line_counts, MAX_WORKER_FINDINGS, False)
                return {"subQuestion": sub_question, "answer": text, "findings": findings}

            compact = user + " Your previous reply was too long: give one finding with one short quote."
            return run.call_json("worker", user, WORKER_MAX_TOKENS, schema, validate, compact_user=compact)

        with ThreadPoolExecutor(max_workers=len(sub_questions)) as executor:
            futures = [executor.submit(answer, sub_question) for sub_question in sub_questions]
            return [future.result() for future in futures]

    def _synthesize(self, run, question, results, line_counts, budget):
        notes = json.dumps(results, ensure_ascii=False, separators=(",", ":"))
        # A finding with one quoted span costs roughly 90-110 tokens of JSON, so size the
        # list to the budget instead of letting the reply run past max_tokens.
        fit = max(1, min(MAX_FINDINGS, budget // 110))

        def request(count, extra):
            return _user(
                "synthesizer",
                f"Question: {question}",
                f"Worker notes: {notes}",
                "Check the notes against the files and write the final answer: a short answer "
                f"and 1 to {count} findings, each a one-line label with 1 to {MAX_SPANS} "
                "evidence spans (path, startLine, endLine, quote). Reply as JSON: {\"answer\": string, "
                "\"findings\": [{\"label\": string, \"evidence\": [{\"path\": string, "
                "\"startLine\": int, \"endLine\": int, \"quote\": string}]}]}." + extra,
            )

        compact = max(1, fit // 2)
        schema = findings_schema(_citable(line_counts), 1, fit)
        return run.call_json(
            "synthesizer", request(fit, ""), budget, schema,
            lambda value: validate_answer(value, line_counts, fit, True),
            compact_user=request(compact, " Your previous reply was too long: answer in one sentence, "
                                 f"give at most {compact} findings, and keep each label under 15 words."),
        )
