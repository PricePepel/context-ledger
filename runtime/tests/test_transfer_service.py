"""POST /latent/transfer with a fake trained pair (no torch needed)."""
import os
import tempfile
import threading
import time
import unittest

from latent_pool import ApiError
from latent_pool.mappers import MapperRegistry
from latent_pool.transfer import TransferService


class FakeTokenizer:
    def __call__(self, text, add_special_tokens=False):
        return {"input_ids": text.split()}


class FakePair:
    sender_name = "Qwen/Qwen2.5-0.5B-Instruct"
    receiver_name = "HuggingFaceTB/SmolLM2-360M-Instruct"
    checkpoint_id = "abc123"

    def __init__(self, delay=0.0):
        self.sender_tok = self.receiver_tok = FakeTokenizer()
        self.delay = delay
        self.calls = []

    def answer_from_sender(self, document, suffix, max_new_tokens):
        self.calls.append((document, suffix, max_new_tokens))
        time.sleep(self.delay)
        return "Denver Broncos", {"senderTokens": 7, "receiverTokens": 8, "senderMs": 1.234, "mapperMs": 2.345}


class TransferServiceTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        with open(os.path.join(self.dir.name, "notes.txt"), "w", encoding="utf-8") as handle:
            handle.write("The Broncos won.\nThe score was 24-10.\n")
        os.makedirs(os.path.join(self.dir.name, ".git"))
        with open(os.path.join(self.dir.name, ".git", "config"), "w") as handle:
            handle.write("secret")
        self.pair = FakePair()
        self.service = TransferService(self.dir.name, self.pair, max_tokens=40, slot_wait=0.2)
        self.body = {"sender": FakePair.sender_name, "receiver": FakePair.receiver_name,
                     "question": "Who won?", "text": "The Broncos won the game."}

    def tearDown(self):
        self.dir.cleanup()

    def status(self, body):
        with self.assertRaises(ApiError) as raised:
            self.service(body)
        return raised.exception.status

    def test_text_transfer_returns_an_unverified_answer_and_a_receipt(self):
        result = self.service(self.body)
        self.assertEqual(result["mode"], "transfer")
        self.assertEqual(result["answer"], "Denver Broncos")
        self.assertIs(result["answerVerified"], False)
        receipt = result["receipt"]
        self.assertEqual(receipt["mapperId"], "abc123")
        self.assertEqual(receipt["senderMs"], 1.23)
        self.assertIn("totalMs", receipt)
        # Only text and numbers leave the runtime: no cache, no tensors.
        self.assertEqual(set(result), {"mode", "answer", "answerVerified", "receipt"})
        self.assertTrue(all(isinstance(v, (str, int, float)) for v in receipt.values()))
        document, suffix, limit = self.pair.calls[0]
        self.assertIn("The Broncos won the game.", document)
        self.assertIn("Who won?", suffix)
        self.assertEqual(limit, 32)

    def test_paths_are_read_under_the_root_with_the_m2a_rules(self):
        result = self.service({**{k: v for k, v in self.body.items() if k != "text"}, "paths": ["notes.txt"]})
        self.assertEqual(result["paths"], ["notes.txt"])
        self.assertIn("The score was 24-10.", self.pair.calls[0][0])
        body = {k: v for k, v in self.body.items() if k != "text"}
        self.assertEqual(self.status({**body, "paths": [".git/config"]}), 400)
        self.assertEqual(self.status({**body, "paths": ["../outside.txt"]}), 400)

    def test_bad_requests(self):
        self.assertEqual(self.status({**self.body, "paths": ["notes.txt"]}), 400)  # both text and paths
        self.assertEqual(self.status({k: v for k, v in self.body.items() if k != "text"}), 400)  # neither
        self.assertEqual(self.status({**self.body, "question": "  "}), 400)
        self.assertEqual(self.status({**self.body, "maxNewTokens": 0}), 400)
        self.assertEqual(self.status({**self.body, "maxNewTokens": True}), 400)
        self.assertEqual(self.status({**self.body, "extra": 1}), 400)
        self.assertEqual(self.status({**self.body, "text": "word " * 41}), 413)  # over the mapper's length
        self.assertEqual(self.status({**self.body, "text": "x" * 8001}), 413)
        self.assertEqual(self.pair.calls, [])

    def test_a_second_request_waits_then_gets_503(self):
        slow = TransferService(self.dir.name, FakePair(delay=0.6), max_tokens=40, slot_wait=0.1)
        first = threading.Thread(target=lambda: slow(self.body))
        first.start()
        time.sleep(0.1)
        with self.assertRaises(ApiError) as raised:
            slow(self.body)
        first.join()
        self.assertEqual(raised.exception.status, 503)
        self.assertEqual(slow(self.body)["answer"], "Denver Broncos", "the slot is released")

    def test_registry_routes_to_the_registered_pair_and_refuses_others(self):
        registry = MapperRegistry()
        registry.register(FakePair.sender_name, FakePair.receiver_name, self.service, name="pair")
        self.assertEqual(registry.transfer(self.body)["answer"], "Denver Broncos")
        with self.assertRaises(ApiError) as raised:
            registry.transfer({**self.body, "receiver": "meta-llama/Llama-3.2-1B"})
        self.assertEqual(raised.exception.status, 501)
        self.assertEqual([p["name"] for p in registry.pairs()], ["pair"])


if __name__ == "__main__":
    unittest.main()
