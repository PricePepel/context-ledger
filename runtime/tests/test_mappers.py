import hashlib
import unittest

from latent_pool import ApiError
from latent_pool.mappers import NO_MAPPER, MapperRegistry, model_hash
from tests.helpers import FakeVllm, Service

SENDER = "Qwen/Qwen2.5-7B-Instruct-AWQ"
RECEIVER = "meta-llama/Llama-3.1-8B-Instruct"


class RegistryTest(unittest.TestCase):
    def test_model_hash_is_sha256_of_the_id(self):
        self.assertEqual(model_hash(SENDER), hashlib.sha256(SENDER.encode()).hexdigest())

    def test_empty_registry_has_no_pairs_and_refuses_transfer(self):
        registry = MapperRegistry()
        self.assertEqual(registry.pairs(), [])
        with self.assertRaises(ApiError) as caught:
            registry.transfer({"sender": SENDER, "receiver": RECEIVER})
        self.assertEqual((caught.exception.status, caught.exception.message), (501, NO_MAPPER))

    def test_registered_pair_is_keyed_by_hashes_and_directional(self):
        registry = MapperRegistry()
        registry.register(SENDER, RECEIVER, lambda body: {"ok": True, "echo": body["payload"]})
        self.assertEqual(registry.pairs(), [{
            "sender": model_hash(SENDER), "receiver": model_hash(RECEIVER), "name": f"{SENDER} -> {RECEIVER}",
        }])
        self.assertEqual(registry.transfer({"sender": SENDER, "receiver": RECEIVER, "payload": 7}),
                         {"ok": True, "echo": 7})
        with self.assertRaises(ApiError) as caught:
            registry.transfer({"sender": RECEIVER, "receiver": SENDER})
        self.assertEqual(caught.exception.status, 501)

    def test_bad_transfer_body_is_400(self):
        for body in [{}, {"sender": SENDER}, {"sender": 1, "receiver": RECEIVER}, {"sender": "", "receiver": RECEIVER}]:
            with self.assertRaises(ApiError) as caught:
                MapperRegistry().transfer(body)
            self.assertEqual(caught.exception.status, 400)


class MapperEndpointTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeVllm()

    def tearDown(self):
        self.fake.close()

    def test_endpoints_with_empty_registry(self):
        service = Service(self.fake.url)
        try:
            self.assertEqual(service.request("GET", "/latent/mappers"), (200, {"pairs": []}))
            self.assertEqual(service.request("POST", "/latent/transfer", {"sender": SENDER, "receiver": RECEIVER}),
                             (501, {"error": "No trained mapper for this model pair."}))
            self.assertEqual(service.request("POST", "/latent/transfer", {"sender": SENDER})[0], 400)
        finally:
            service.close()

    def test_endpoints_with_a_registered_pair(self):
        registry = MapperRegistry()
        registry.register(SENDER, RECEIVER, lambda body: {"transferred": True})
        service = Service(self.fake.url, registry=registry)
        try:
            status, payload = service.request("GET", "/latent/mappers")
            self.assertEqual(status, 200)
            self.assertEqual(len(payload["pairs"]), 1)
            self.assertEqual(service.request("POST", "/latent/transfer", {"sender": SENDER, "receiver": RECEIVER}),
                             (200, {"transferred": True}))
        finally:
            service.close()


if __name__ == "__main__":
    unittest.main()
