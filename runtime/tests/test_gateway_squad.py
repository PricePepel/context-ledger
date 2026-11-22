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


class Seen:
    """What every watchdog of the test saw, decoded as text: each turn's appended ids and the
    thought record's top tokens. Taken just before the watchdog runs its checks."""

    def __init__(self, tokenizer):
        self.tokenizer, self.prompts, self.tops = tokenizer, [], []

    def __enter__(self):
        from latent_team.watchdog import Watch
        original, seen = Watch.finish, self

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


@unittest.skipUnless(HAVE_TORCH, "torch and transformers are needed for the squad")
class PlaceholderEvalTest(unittest.TestCase):
    """Eval 7: a declared canary never reaches the model, the thought record, an uncleared
    answer, a report, a response or a log."""

    def test_a_declared_canary_on_both_routes(self):
        from latent_pool.team_service import MODEL_ID, TeamService
        team = text_team()
        service = TeamService(team, steps=STEPS)
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
        self.assertEqual(len(seen.prompts), 2)
        for text in seen.prompts + seen.tops + [json.dumps(b) for b in bodies] + [logs.getvalue(), err.getvalue(),
                                                                                    out.getvalue()]:
            self.assertNotIn(secret, text)
        self.assertTrue(all("[[secret-1-" in text for text in seen.prompts), "the model read the placeholder")

    def test_a_scanner_finding_is_a_placeholder_too(self):
        from latent_pool.team_service import TeamService
        team = text_team()
        token = "gh" + "p_" + "Ab3D" * 9
        with Seen(team.tokenizer) as seen:
            result = TeamService(team, steps=STEPS)({"question": f"push with {token} now", "latentSteps": STEPS,
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
        public = TeamService(team, steps=STEPS)(body)
        cleared = TeamService(team, steps=STEPS)(dict(body, clearance="sensitive"))
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
        from latent_team.watchdog import Watch, memory_layers
        team = text_team()
        kept = []
        for project in ("proj-a", "proj-b"):
            watch = Watch(team, [f"Question for {project}?"], steps=STEPS, max_new_tokens=TOKENS, keep_memory=True)
            team.latent_mas([f"Question for {project}?"], steps=STEPS, max_new_tokens=TOKENS, watch=watch)
            kept.append(watch)
        first, second = kept
        self.assertIsNot(first.cache, second.cache)
        pointers = [{t.untyped_storage().data_ptr() for layer in memory_layers(w.cache) for t in layer} for w in kept]
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
        service = TeamService(team, steps=STEPS)
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


if __name__ == "__main__":
    unittest.main()
