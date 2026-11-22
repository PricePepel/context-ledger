"""W2 evals 7, 9 and 10 through the guarded squad: a tiny random Qwen2 on the CPU with a
tokenizer that maps characters back to themselves, so decoded tokens can be searched as
text. Synthetic data only: canaries are random strings made at run time."""
import contextlib
import io
import json
import logging
import os
import secrets
import sys
import unittest
from unittest import mock

from tests.test_latent_team import HAVE_TORCH, CharTokenizer

if HAVE_TORCH:
    import torch
    from transformers import Qwen2Config, Qwen2ForCausalLM

STEPS, TOKENS = 3, 6
ALPHABET = [chr(code) for code in range(32, 127)] + ["\n"]


class TextTokenizer(CharTokenizer):
    """One id per printable character, and decode gives the characters back."""

    def encode(self, text):
        return [3 + ALPHABET.index(ch) if ch in ALPHABET else 2 for ch in text]

    def decode(self, ids, skip_special_tokens=True):
        return "".join(ALPHABET[i - 3] for i in ids if 3 <= i < 3 + len(ALPHABET))

    def batch_decode(self, rows):
        return [self.decode(row) for row in rows]

    def __len__(self):
        return 3 + len(ALPHABET)


def text_team():
    from latent_team.team import LatentTeam
    torch.manual_seed(0)
    config = Qwen2Config(vocab_size=128, hidden_size=32, intermediate_size=64, num_hidden_layers=2,
                         num_attention_heads=4, num_key_value_heads=2, max_position_embeddings=4096)
    return LatentTeam("tiny", device="cpu", dtype=torch.float32, model=Qwen2ForCausalLM(config).eval(),
                      tokenizer=TextTokenizer())


def canary():
    return "cnry" + secrets.token_hex(16)


def quiet_service(team):
    """The service with its real guard, but no sampled audit, so each request is exactly one
    watched run and a random fallback cannot change an answer under test."""
    from latent_pool.team_service import TeamService
    service = TeamService(team, steps=STEPS)
    service.guard.sample = lambda: False
    return service


class Seen:
    """What every watchdog of the test saw, decoded as text: each turn's appended ids and the
    thought record's top tokens. Taken just before the watchdog runs its checks."""

    def __init__(self, tokenizer):
        self.tokenizer, self.prompts, self.tops, self.reports = tokenizer, [], [], []

    def __enter__(self):
        from latent_team.supervisor import Run
        from latent_team.watchdog import Watch
        original, seen = Watch.finish, self
        submit = Run.submit

        def spy_submit(run, envelope):
            seen.reports.append(json.dumps(envelope))
            return submit(run, envelope)

        self.submit_patch = mock.patch.object(Run, "submit", spy_submit)
        self.submit_patch.start()

        def spy(watch, answers, counts, seconds):
            for row in range(watch.rows):
                seen.prompts.append("".join(seen.tokenizer.decode(c["ids"][row].tolist())
                                            for c in watch.calls if c.get("ids") is not None))
                seen.tops.append(seen.tokenizer.decode([int(ids[row, 0]) for _, ids, _ in watch.record]))
            return original(watch, answers, counts, seconds)

        self.patch = mock.patch.object(Watch, "finish", spy)
        self.patch.start()
        return self

    def __exit__(self, *exc):
        self.patch.stop()
        self.submit_patch.stop()


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for the squad")
class PlaceholderEvalTest(unittest.TestCase):
    """Eval 7: a declared canary never reaches the model, the thought record, an uncleared
    answer, a report, a response or a log."""

    def test_a_declared_canary_on_both_routes(self):
        from latent_pool.team_service import MODEL_ID, TeamService
        team = text_team()
        service = quiet_service(team)
        secret = canary()
        logs, err, out = io.StringIO(), io.StringIO(), io.StringIO()
        handler = logging.StreamHandler(logs)
        logging.getLogger().addHandler(handler)
        logging.getLogger().setLevel(logging.DEBUG)
        try:
            with Seen(team.tokenizer) as seen, contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
                bodies = [service({"question": f"My code is {secret}. Repeat it.", "secrets": [secret],
                                   "latentSteps": STEPS, "maxNewTokens": TOKENS}),
                          service.chat({"model": MODEL_ID, "secrets": [secret], "max_tokens": TOKENS,
                                        "messages": [{"role": "system", "content": f"The code is {secret}."},
                                                     {"role": "user", "content": "What is the code?"}]})]
        finally:
            logging.getLogger().removeHandler(handler)
        self.assertEqual((len(seen.prompts), len(seen.reports)), (2, 2))
        for text in seen.prompts + seen.tops + seen.reports + [json.dumps(b) for b in bodies] + \
                [logs.getvalue(), err.getvalue(), out.getvalue()]:
            self.assertNotIn(secret, text)
        self.assertTrue(all("[[secret-1-" in text for text in seen.prompts), "the model read the placeholder")

    def test_the_observation_would_see_an_undeclared_canary(self):
        # Positive control (review W2-1 finding 8): without a declaration the canary is just
        # text, and the same observation finds it in what the model read.
        from latent_pool.team_service import TeamService
        team = text_team()
        secret = canary()
        with Seen(team.tokenizer) as seen:
            quiet_service(team)({"question": f"My code is {secret}.", "latentSteps": STEPS,
                                            "maxNewTokens": TOKENS})
        self.assertIn(secret, seen.prompts[0])

    def test_the_streamed_http_route_carries_no_canary(self):
        import http.client
        import threading
        from latent_pool.server import Config, LatentServer
        from latent_pool.team_service import MODEL_ID, TeamService
        from latent_pool.vllm_client import VllmClient
        team = text_team()
        config = Config(root=".", vllm_url="http://127.0.0.1:9/v1", model="m", port=0)
        server = LatentServer(config, client=VllmClient("http://127.0.0.1:9/v1", "m", 1), quiet=True,
                              team=quiet_service(team))
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        secret = canary()
        body = json.dumps({"model": MODEL_ID, "stream": True, "secrets": [secret], "max_tokens": TOKENS,
                           "messages": [{"role": "user", "content": f"The code is {secret}. Say it."}]}).encode()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=60)
        connection.request("POST", "/v1/chat/completions", body=body,
                           headers={"Host": f"127.0.0.1:{server.server_port}", "Content-Type": "application/json",
                                    "Content-Length": str(len(body))})
        response = connection.getresponse()
        raw = response.read().decode()
        connection.close()
        self.assertEqual(response.status, 200)
        self.assertIn("[DONE]", raw)
        self.assertNotIn(secret, raw)

    def test_a_scanner_finding_is_a_placeholder_too(self):
        from latent_pool.team_service import TeamService
        team = text_team()
        token = "gh" + "p_" + "Ab3D" * 9
        with Seen(team.tokenizer) as seen:
            result = quiet_service(team)({"question": f"push with {token} now", "latentSteps": STEPS,
                                                     "maxNewTokens": TOKENS})
        self.assertNotIn(token, seen.prompts[0])
        self.assertEqual(result["receipt"]["gateway"]["placeholders"], 1)

    def test_a_cleared_output_gets_the_value_back(self):
        from latent_pool.team_service import TeamService
        team = text_team()
        decode = team.decode

        def echoing(memory, memory_mask, prompts, max_new_tokens, **kwargs):
            # The model's answer quotes the placeholder it read (counts stay the real ones).
            texts, counts = decode(memory, memory_mask, prompts, max_new_tokens, **kwargs)
            return [p.split("Question: ")[-1] for p in prompts], counts

        team.decode = echoing
        secret = canary()
        body = {"question": f"Echo {secret}", "secrets": [secret], "latentSteps": STEPS, "maxNewTokens": TOKENS}
        public = quiet_service(team)(body)
        cleared = quiet_service(team)(dict(body, clearance="sensitive"))
        self.assertNotIn(secret, public["answer"])
        self.assertIn("[[secret-1-", public["answer"])
        self.assertIn(secret, cleared["answer"])
        self.assertNotIn(secret, json.dumps(cleared["receipt"]))


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for the squad")
class LabelEvalTest(unittest.TestCase):
    """Eval 9 through the squad: the label rule holds, and two projects share no memory."""

    def test_a_sensitive_memory_with_an_uncleared_output_is_held(self):
        from latent_team.gateway import Gateway, Permissions, Span
        from latent_team.guard import Guard
        team = text_team()
        gateway = Gateway("proj-a")
        gateway.fix_permissions(Permissions(clearance="public"))
        gateway.admit([Span("request", "request", "Summarise my diary.", sensitive=True)])
        [outcome] = Guard(team, thresholds=None).run(["unused"], steps=STEPS, max_new_tokens=TOKENS,
                                                     gateways=[gateway])
        self.assertEqual((outcome.decision["action"], outcome.decision["reason"], outcome.answer),
                         ("hold", "label-rule", None))

    def test_two_projects_never_share_a_memory_or_a_tensor(self):
        # Through the guarded entry point (review W2-1 finding 8): the memories of two
        # projects' runs, both kept alive, share no object and no storage.
        from latent_team.gateway import Gateway, Permissions, Span
        from latent_team.guard import Guard
        from latent_team.watchdog import Watch, memory_layers
        team = text_team()
        guard = Guard(team, thresholds=None, sample=lambda: False)
        caches, drop = [], Watch.drop

        def keep(watch):
            caches.append(watch.cache)
            drop(watch)

        with mock.patch.object(Watch, "drop", keep):
            for project in ("proj-a", "proj-b"):
                gateway = Gateway(project)
                gateway.fix_permissions(Permissions())
                gateway.admit([Span("request", "request", f"Question for {project}?")])
                guard.run(["unused"], steps=STEPS, max_new_tokens=TOKENS, gateways=[gateway])
        first, second = caches
        self.assertIsNot(first, second)
        pointers = [{t.untyped_storage().data_ptr() for layer in memory_layers(c) for t in layer} for c in caches]
        self.assertEqual(pointers[0] & pointers[1], set())


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for the squad")
class NothingOnDiskTest(unittest.TestCase):
    """Eval 10: a guarded run on both routes writes no file at all."""

    writes = []
    active = False

    @classmethod
    def setUpClass(cls):
        def hook(event, args):
            if not cls.active:
                return
            if event == "open":
                path, mode, flags = (list(args) + [None, None, 0])[:3]
                writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or \
                    (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND))
                if writing:
                    cls.writes.append((event, str(path)))
            elif event in ("os.rename", "os.replace", "os.remove", "os.unlink", "os.mkdir", "os.rmdir",
                           "shutil.copyfile", "shutil.move", "os.truncate"):
                cls.writes.append((event, str(args[0]) if args else ""))
        sys.addaudithook(hook)   # stays for the process, active only inside the test

    def test_a_guarded_run_writes_nothing(self):
        from latent_pool.team_service import MODEL_ID, TeamService
        team = text_team()
        service = quiet_service(team)
        service({"question": "warm up", "latentSteps": STEPS, "maxNewTokens": TOKENS})   # imports done before
        import tempfile
        with tempfile.TemporaryDirectory() as folder:   # the hook itself must see a write
            type(self).active = True
            with open(os.path.join(folder, "probe.txt"), "w") as handle:
                handle.write("x")
            type(self).active = False
        self.assertTrue(any(path.endswith("probe.txt") for _, path in self.writes), self.writes)
        self.writes.clear()
        secret = canary()
        before = sys.dont_write_bytecode
        sys.dont_write_bytecode = True
        type(self).active = True
        try:
            service({"question": f"Keep {secret} safe.", "secrets": [secret], "latentSteps": STEPS,
                     "maxNewTokens": TOKENS})
            service.chat({"model": MODEL_ID, "max_tokens": TOKENS, "messages": [{"role": "user", "content": "2+2?"}]})
        finally:
            type(self).active = False
            sys.dont_write_bytecode = before
        self.assertEqual(self.writes, [])

    def test_a_fresh_process_writes_nothing_from_its_first_request(self):
        # Review W2-1 finding 8: a separate process with its own empty home, working and
        # temporary folders, and no warm-up request. The audit hook goes in after the imports
        # and the model are loaded and before the first request, so a write that only a first
        # request makes is seen; the folders are listed before and after the requests.
        import subprocess
        import tempfile
        runtime = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        script = (
            "import json, os, sys\n"
            "from tests.test_gateway_squad import text_team\n"
            "from latent_pool.team_service import MODEL_ID, TeamService\n"
            "service = TeamService(text_team(), steps=3)\n"
            "def listing():\n"
            "    return sorted(os.path.join(r, n) for r, d, f in os.walk(os.getcwd()) for n in f + d)\n"
            "before = listing()\n"
            "writes = []\n"
            "def hook(event, args):\n"
            "    if event == 'open' and len(args) > 1 and isinstance(args[1], str) and any(c in args[1] for c in 'wax+'):\n"
            "        writes.append([event, str(args[0])])\n"
            "    elif event in ('os.rename', 'os.replace', 'os.remove', 'os.unlink', 'os.mkdir', 'os.rmdir',\n"
            "                   'shutil.copyfile', 'shutil.move', 'os.truncate'):\n"
            "        writes.append([event, str(args[0]) if args else ''])\n"
            "sys.addaudithook(hook)\n"
            "service({'question': 'Keep cnry0123456789abcdef0123456789abcdef safe.', "
            "'secrets': ['cnry0123456789abcdef0123456789abcdef'], 'latentSteps': 3, 'maxNewTokens': 6})\n"
            "service.chat({'model': MODEL_ID, 'max_tokens': 6, 'messages': [{'role': 'user', 'content': '2+2?'}]})\n"
            "sys.stdout.write(json.dumps({'writes': writes, 'added': sorted(set(listing()) - set(before))}))\n")
        with tempfile.TemporaryDirectory() as folder:
            env = dict(os.environ, HOME=folder, USERPROFILE=folder, TMPDIR=folder, TEMP=folder, TMP=folder,
                       PYTHONDONTWRITEBYTECODE="1", PYTHONPATH=runtime)
            result = subprocess.run([sys.executable, "-c", script], cwd=folder, env=env, capture_output=True,
                                    text=True, timeout=300)
            self.assertEqual(result.returncode, 0, result.stderr[-2000:])
            report = json.loads(result.stdout.strip().splitlines()[-1])
            self.assertEqual(report, {"writes": [], "added": []})

if __name__ == "__main__":
    unittest.main()
