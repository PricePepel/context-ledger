"""T1a: the mapper hub prototype (docs/mapper-hub.md).

The library and the plan run on the standard library. The split and the chain need torch
and skip without it. Everything here is synthetic: random weights, made-up digests.
"""
import hashlib
import io
import os
import tempfile
import unittest

from latent_hub import plan
from latent_hub.library import (LibraryError, MAX_PART_BYTES, Library, NotCovered, build_key, canary_passes, fetch,
                                verify)

try:
    import torch
    HAVE_TORCH = True
except ImportError:  # the runtime's own tests run without torch
    HAVE_TORCH = False


def no_grad(test):
    """torch.no_grad() as a decorator that still lets the file load without torch."""
    def run(self):
        with torch.no_grad():
            return test(self)
    run.__name__, run.__doc__ = test.__name__, test.__doc__
    return run

# KV shapes as L2 measured them (docs/evals.md, L2, "Models"), and each model's hidden size.
PHI, QWEN15, QWEN3, GRANITE = (32, 32, 96), (28, 2, 128), (36, 2, 128), (40, 8, 64)
EMBED = {PHI: 3072, QWEN15: 1536, QWEN3: 2048, GRANITE: 2048}


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def key_of(model, quantisation="bf16", revision="rev1"):
    return build_key(model, revision, {"model.safetensors": digest(model + quantisation)}, quantisation, "bf16",
                     {"tokenizer.json": digest("tok" + model)}, [28, 2, 128])


A, B, C = key_of("org/model-a"), key_of("org/model-b"), key_of("org/model-c")


def part(role, build, gate="passed", data=None):
    data = data if data is not None else f"{role}-{build}".encode()
    return {"role": role, "build": build, "file": f"{role}-{build[:8]}.safetensors",
            "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "gate": gate, "card": "T1b"}


def manifest(kind="split", **changes):
    builds = {key: {"model": name, "revision": "rev1", "quantisation": "bf16", "kvDtype": "bf16",
                    "shape": [28, 2, 128], "licence": "Apache-2.0"}
              for key, name in ((A, "org/model-a"), (B, "org/model-b"), (C, "org/model-c"))}
    spokes = (A, B, C) if kind == "split" else (B, C)
    hub = {"id": "hub-v1", "kind": kind, "slots": 8, "dim": 384, "alignment": 2, "maxTokens": 256,
           "document": "m2b-chatml-v1"}
    if kind == "pivot":
        hub["pivot"] = A
    routes = [{"sender": s, "receiver": r, "status": "passed", "f1": 0.8, "card": "T1b"}
              for s in (A, B, C) for r in (A, B, C) if s != r]
    body = {"schema": 1, "library": "context-ledger-mappers", "version": "0.1.0", "hub": hub, "builds": builds,
            "parts": [part(role, key) for key in spokes for role in ("encoder", "decoder")], "routes": routes,
            "canary": {"passage": "The lighthouse at Vell was painted green in 1911.",
                       "question": "What colour was the lighthouse painted?", "expect": "green"}}
    body.update(changes)
    return body


class PlanTest(unittest.TestCase):
    def test_part_counts(self):
        self.assertEqual([plan.parts(4, design) for design in plan.DESIGNS], [12, 8, 6])
        self.assertEqual([plan.parts(8, design) for design in plan.DESIGNS], [56, 16, 14])
        # One more model: a direct library retrains against every member, a hub trains two parts.
        self.assertEqual([plan.parts_for_one_more(4, design) for design in plan.DESIGNS], [8, 2, 2])
        self.assertEqual([plan.parts_for_one_more(8, design) for design in plan.DESIGNS], [16, 2, 2])

    def test_refuses_what_it_does_not_know(self):
        for call in (lambda: plan.parts(1, "split"), lambda: plan.parts(4, "star"),
                     lambda: plan.mappers_per_handoff("star")):
            with self.assertRaises(ValueError):
                call()

    def test_a_direct_mapper_is_its_encoder_plus_its_decoder(self):
        # 100.5M is the M2b-S mapper as trained and logged (docs/evals.md, M2b-S, run 1).
        self.assertEqual(plan.direct_params(PHI, QWEN15, EMBED[QWEN15]), 100_509_696)
        self.assertEqual(plan.encoder_params(PHI) + plan.decoder_params(QWEN15, EMBED[QWEN15]), 100_509_696)

    def test_the_encoder_carries_the_weight_of_a_wide_cache(self):
        self.assertEqual(plan.cache_width(PHI), 196_608)
        self.assertEqual(plan.cache_width(QWEN15), 14_336)
        self.assertEqual(plan.encoder_params(PHI), 196_608 * 384)
        self.assertEqual(plan.encoder_params(QWEN15), 14_336 * 384)
        self.assertGreater(plan.encoder_params(PHI), 3 * plan.decoder_params(PHI, EMBED[PHI]) // 4)

    def test_hub_state_is_small(self):
        self.assertEqual(plan.hub_bytes_per_token(), 6144)
        self.assertLess(plan.hub_bytes_per_token(), plan.cache_width(QWEN15) * 2)

    def test_pivot_runs_two_mappers_unless_one_end_is_the_pivot(self):
        self.assertEqual(plan.mappers_per_handoff("pivot"), 2)
        self.assertEqual(plan.mappers_per_handoff("pivot", through_pivot=False), 1)
        self.assertEqual(plan.mappers_per_handoff("split"), 1)

    def test_gpu_hours_scale_with_the_design(self):
        self.assertEqual([plan.gpu_hours(4, design, 3) for design in plan.DESIGNS], [36, 12, 18])

    @unittest.skipUnless(HAVE_TORCH, "torch is needed to import the mapper")
    def test_layer_groups_match_the_mapper(self):
        from latent_transfer.mapper import layer_groups
        for layers in (8, 24, 28, 32, 36, 40):
            self.assertEqual(plan.layer_groups(layers, 8), layer_groups(layers, 8))


class BuildKeyTest(unittest.TestCase):
    def test_everything_that_changes_the_cache_changes_the_key(self):
        base = dict(model="org/model-a", revision="rev1", weights={"model.safetensors": digest("w")},
                    quantisation="bf16", kv_dtype="bf16", tokenizer={"tokenizer.json": digest("t")}, shape=[28, 2, 128])
        keys = {build_key(**base)}
        for change in (dict(model="org/model-b"), dict(revision="rev2"), dict(weights={"model.safetensors": digest("x")}),
                       dict(quantisation="awq-int4"), dict(kv_dtype="fp8"),
                       dict(tokenizer={"tokenizer.json": digest("u")}), dict(shape=[28, 2, 64])):
            keys.add(build_key(**{**base, **change}))
        self.assertEqual(len(keys), 8)
        self.assertEqual(build_key(**base), build_key(**base))

    def test_file_order_does_not_change_the_key(self):
        one = {"a.safetensors": digest("1"), "b.safetensors": digest("2")}
        two = dict(reversed(list(one.items())))
        make = lambda weights: build_key("org/m", "rev", weights, "bf16", "bf16", {"tokenizer.json": digest("t")}, [8, 2, 64])
        self.assertEqual(make(one), make(two))

    def test_bad_input_is_refused(self):
        good = dict(model="org/m", revision="rev", weights={"m.safetensors": digest("w")}, quantisation="bf16",
                    kv_dtype="bf16", tokenizer={"tokenizer.json": digest("t")}, shape=[8, 2, 64])
        for change in (dict(model="org/m\nx"), dict(weights={}), dict(weights={"m.safetensors": "ABC"}),
                       dict(weights={"../m": digest("w")}), dict(tokenizer=None), dict(shape=[8, 2]),
                       dict(shape=[8, 0, 64]), dict(shape=[8, True, 64]), dict(quantisation="")):
            with self.assertRaises(LibraryError):
                build_key(**{**good, **change})


class RouteTest(unittest.TestCase):
    def test_split_hub_gives_the_senders_encoder_and_the_receivers_decoder(self):
        library = Library(manifest())
        route = library.route(A, B)
        self.assertEqual((route["kind"], route["hub"]), ("split", "hub-v1"))
        self.assertEqual((route["encoder"]["role"], route["encoder"]["build"]), ("encoder", A))
        self.assertEqual((route["decoder"]["role"], route["decoder"]["build"]), ("decoder", B))
        self.assertEqual(route["measured"]["f1"], 0.8)
        self.assertEqual(len(library.offered()), 6)

    def test_pivot_hub_needs_no_part_at_the_pivot(self):
        library = Library(manifest("pivot"))
        self.assertIsNone(library.route(A, B)["encoder"])
        self.assertIsNone(library.route(B, A)["decoder"])
        both = library.route(B, C)
        self.assertEqual((both["encoder"]["build"], both["decoder"]["build"]), (B, C))

    def test_same_build_is_handed_straight_over(self):
        route = Library(manifest()).route(A, A)
        self.assertEqual((route["kind"], route["encoder"], route["decoder"]), ("self", None, None))

    def test_unknown_model_is_refused_by_name(self):
        other = key_of("org/model-z")
        with self.assertRaises(NotCovered) as caught:
            Library(manifest()).route(A, other, "org/model-a", "org/model-z")
        self.assertEqual(caught.exception.reason, "unknown_model")
        self.assertIn("no mapper for org/model-z", caught.exception.message)
        self.assertIn("org/model-a, org/model-b, org/model-c", caught.exception.message)
        with self.assertRaises(NotCovered) as caught:
            Library(manifest()).route(other, other, "org/model-z", "org/model-z")
        self.assertEqual(caught.exception.reason, "unknown_model")

    def test_another_build_of_a_covered_model_is_refused_and_says_which_build_is_covered(self):
        quantised = key_of("org/model-b", "awq-int4")
        with self.assertRaises(NotCovered) as caught:
            Library(manifest()).route(A, quantised, "org/model-a", "org/model-b")
        self.assertEqual(caught.exception.reason, "other_build")
        self.assertIn(f"this build of org/model-b ({quantised[:12]})", caught.exception.message)
        self.assertIn(f"org/model-b (bf16 weights, bf16 cache, build {B[:12]})", caught.exception.message)

    def test_a_name_that_is_not_a_model_id_is_never_echoed(self):
        other = key_of("org/model-z")
        hostile = "x" + chr(0x1b) + "[31m" + chr(0x202e) + "evil"
        with self.assertRaises(NotCovered) as caught:
            Library(manifest()).route(other, A, hostile, "org/model-a")
        self.assertIn("no mapper for this model.", caught.exception.message)
        self.assertNotIn("evil", caught.exception.message)
        for bad in ("abc", None, 7, A.upper()):
            with self.assertRaises(NotCovered) as caught:
                Library(manifest()).route(bad, A)
            self.assertEqual(caught.exception.reason, "bad_request")

    def test_missing_part_names_the_side(self):
        body = manifest()
        body["parts"] = [p for p in body["parts"] if not (p["role"] == "decoder" and p["build"] == B)]
        library = Library(body)
        with self.assertRaises(NotCovered) as caught:
            library.route(A, B)
        self.assertEqual(caught.exception.reason, "no_decoder")
        self.assertIn("no decoder for org/model-b", caught.exception.message)
        self.assertIn("cannot hand off to it", caught.exception.message)
        self.assertEqual(library.route(B, A)["encoder"]["build"], B)

    def test_one_failed_encoder_stops_every_route_from_that_model_and_no_other(self):
        body = manifest()
        for entry in body["parts"]:
            if entry["role"] == "encoder" and entry["build"] == B:
                entry["gate"] = "failed"
        library = Library(body)
        with self.assertRaises(NotCovered) as caught:
            library.route(B, C)
        self.assertEqual(caught.exception.reason, "encoder_failed")
        self.assertIn("failed its own test", caught.exception.message)
        self.assertEqual(sorted(library.offered()), sorted([(A, B), (A, C), (C, A), (C, B)]))
        self.assertEqual(Library(manifest()).through("encoder", B), sorted([(B, A), (B, C)]))

    def test_untested_part_is_not_used(self):
        body = manifest()
        body["parts"][0]["gate"] = "unmeasured"
        with self.assertRaises(NotCovered) as caught:
            Library(body).route(A, B)
        self.assertEqual(caught.exception.reason, "encoder_unmeasured")

    def test_unmeasured_route_is_refused_unless_asked_for(self):
        body = manifest()
        body["routes"] = [r for r in body["routes"] if (r["sender"], r["receiver"]) != (B, C)]
        library = Library(body)
        with self.assertRaises(NotCovered) as caught:
            library.route(B, C)
        self.assertEqual(caught.exception.reason, "route_unmeasured")
        self.assertIn("org/model-b to org/model-c", caught.exception.message)
        self.assertIsNone(library.route(B, C, allow_unmeasured=True)["measured"])

    def test_failed_route_is_refused_even_when_unmeasured_ones_are_allowed(self):
        body = manifest()
        for entry in body["routes"]:
            if (entry["sender"], entry["receiver"]) == (B, C):
                entry.update(status="failed", f1=0.21)
        with self.assertRaises(NotCovered) as caught:
            Library(body).route(B, C, allow_unmeasured=True)
        self.assertEqual(caught.exception.reason, "route_failed")
        self.assertIn("F1 0.210", caught.exception.message)


class ManifestTest(unittest.TestCase):
    def refused(self, body):
        with self.assertRaises(LibraryError):
            Library(body)

    def test_good_manifests_load(self):
        self.assertEqual(Library(manifest()).label, "context-ledger-mappers 0.1.0")
        self.assertEqual(Library(manifest("pivot")).pivot, A)

    def test_bad_manifests_are_refused(self):
        self.refused(manifest(schema=2))
        self.refused(manifest(extra=1))
        self.refused({k: v for k, v in manifest().items() if k != "routes"})
        self.refused(manifest(library="bad name"))
        body = manifest(); body["hub"]["kind"] = "star"; self.refused(body)
        body = manifest(); body["hub"]["pivot"] = A; self.refused(body)          # a split hub has no pivot
        body = manifest("pivot"); del body["hub"]["pivot"]; self.refused(body)
        body = manifest("pivot"); body["hub"]["pivot"] = key_of("org/none"); self.refused(body)
        body = manifest("pivot"); body["parts"].append(part("encoder", A)); self.refused(body)
        body = manifest(); body["builds"][A]["shape"] = [4, 2, 128]; self.refused(body)   # fewer layers than slots
        body = manifest(); body["builds"][A]["licence"] = "MIT" + chr(0x202e); self.refused(body)
        body = manifest(); body["builds"] = {A: body["builds"][A]}; self.refused(body)
        body = manifest(); body["parts"][0]["file"] = "../enc.safetensors"; self.refused(body)
        body = manifest(); body["parts"][0]["file"] = "sub/enc.safetensors"; self.refused(body)
        body = manifest(); body["parts"][0]["bytes"] = MAX_PART_BYTES + 1; self.refused(body)
        body = manifest(); body["parts"][0]["sha256"] = "00"; self.refused(body)
        body = manifest(); body["parts"][0]["build"] = key_of("org/none"); self.refused(body)
        body = manifest(); body["parts"].append(dict(body["parts"][0])); self.refused(body)
        body = manifest(); body["parts"][1]["file"] = body["parts"][0]["file"]; self.refused(body)
        body = manifest(); body["routes"][0]["status"] = "unmeasured"; self.refused(body)
        body = manifest(); body["routes"][0]["f1"] = 1.2; self.refused(body)
        body = manifest(); body["routes"][0]["receiver"] = body["routes"][0]["sender"]; self.refused(body)
        body = manifest(); body["routes"].append(dict(body["routes"][0])); self.refused(body)
        body = manifest(); body["canary"]["expect"] = " "; self.refused(body)

    def test_canary(self):
        canary = manifest()["canary"]
        self.assertTrue(canary_passes(canary, "It was painted  Green."))
        self.assertFalse(canary_passes(canary, "blue"))
        self.assertFalse(canary_passes(canary, None))


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class FetchTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.data = os.urandom(3000)
        self.part = part("encoder", A, data=self.data)
        self.calls = []

    def opener(self, data):
        def open_(url, timeout):
            self.calls.append(url)
            return Response(data)
        return open_

    def left_behind(self):
        return sorted(os.listdir(self.folder))

    def test_a_matching_file_is_kept_and_not_downloaded_twice(self):
        path = fetch(self.part, "https://example.invalid/lib/", self.folder, self.opener(self.data))
        self.assertEqual(self.calls, ["https://example.invalid/lib/" + self.part["file"]])
        with open(path, "rb") as handle:
            self.assertEqual(handle.read(), self.data)
        self.assertEqual(fetch(self.part, "https://example.invalid/lib", self.folder, self.opener(b"")), path)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.left_behind(), [self.part["file"]])

    def test_wrong_bytes_are_not_kept(self):
        for data in (self.data[:-1] + b"x" if self.data[-1:] != b"x" else self.data[:-1] + b"y", self.data[:-1],
                     self.data + b"more", b""):
            with self.assertRaises(LibraryError):
                fetch(self.part, "https://example.invalid/lib", self.folder, self.opener(data))
            self.assertEqual(self.left_behind(), [])

    def test_a_damaged_file_on_disk_is_replaced(self):
        target = os.path.join(self.folder, self.part["file"])
        with open(target, "wb") as handle:
            handle.write(b"tampered")
        with self.assertRaises(LibraryError):
            verify(target, self.part)
        fetch(self.part, "https://example.invalid/lib", self.folder, self.opener(self.data))
        self.assertEqual(verify(target, self.part), target)

    def test_same_size_wrong_content_fails_verify(self):
        target = os.path.join(self.folder, self.part["file"])
        with open(target, "wb") as handle:
            handle.write(bytes(len(self.data)))
        with self.assertRaises(LibraryError) as caught:
            verify(target, self.part)
        self.assertIn("SHA-256", str(caught.exception))
        with self.assertRaises(LibraryError):
            verify(os.path.join(self.folder, "absent"), self.part)

    def test_only_https(self):
        for url in ("http://example.invalid/lib", "file:///tmp/lib", "https://example.invalid/a b", None):
            with self.assertRaises(LibraryError):
                fetch(self.part, url, self.folder, self.opener(self.data))
        self.assertEqual(self.calls, [])


class HubCase(unittest.TestCase):
    """Random mappers and random caches: the facts tested are about the wiring."""
    SENDER, PIVOT, RECEIVER = (5, 3, 8), (4, 2, 16), (6, 2, 8)   # layers, KV heads, head dim

    def mapper(self, sender, receiver, embed, seed):
        from latent_transfer.mapper import Mapper
        torch.manual_seed(seed)
        mapper = Mapper(sender, receiver, receiver_embed_dim=embed, dim=32, heads=4, ffn=64, blocks=4).eval()
        with torch.no_grad():
            mapper.sigma.copy_(torch.rand_like(mapper.sigma) + 0.5)
            for block in mapper.blocks:
                block.sink.normal_()
        return mapper

    def cache(self, shape, tokens, seed, batch=2):
        torch.manual_seed(seed)
        layers, heads, dim = shape
        return ([torch.randn(batch, heads, tokens, dim) for _ in range(layers)],
                [torch.randn(batch, heads, tokens, dim) for _ in range(layers)])

    def alignment(self, sender_spans, receiver_spans, batch=2):
        from latent_transfer.align import causal_mask, sender_positions
        return (torch.tensor([sender_positions(sender_spans, receiver_spans)] * batch),
                torch.tensor([causal_mask(sender_spans, receiver_spans)] * batch))

    def setUp(self):
        # 18 characters: the sender splits them in 9 tokens, the receiver in 7.
        self.s_spans = [(2 * i, 2 * i + 2) for i in range(9)]
        self.r_spans = [(0, 3), (3, 5), (5, 8), (8, 11), (11, 13), (13, 16), (16, 18)]
        self.direct = self.mapper(self.SENDER, self.RECEIVER, 24, 0)
        self.keys, self.values = self.cache(self.SENDER, 9, 1)
        torch.manual_seed(2)
        self.embeds = torch.randn(2, 7, 24)
        self.mask = torch.ones(2, 7, dtype=torch.long)
        self.pos, self.allowed = self.alignment(self.s_spans, self.r_spans)


@unittest.skipUnless(HAVE_TORCH, "torch is needed for the split and the chain")
class SplitTest(HubCase):
    @no_grad
    def test_encoder_then_decoder_is_the_direct_mapper_exactly(self):
        from latent_hub.hub import split
        encoder, decoder = split(self.direct)
        hub = encoder(self.keys, self.values)
        self.assertEqual(tuple(hub.shape), (2, 4, 9, 32))
        want = self.direct(self.embeds, self.mask, self.keys, self.values, self.pos, self.allowed)
        got = decoder(self.embeds, self.mask, hub, self.pos, self.allowed)
        for a, b in zip(want[0] + want[1], got[0] + got[1]):
            self.assertTrue(torch.equal(a, b))

    @no_grad
    def test_part_sizes_add_up_to_the_mapper(self):
        from latent_hub.hub import decoder_state, split
        from latent_transfer.mapper import parameter_count
        encoder, _ = split(self.direct)
        decoder_size = sum(value.numel() for name, value in decoder_state(self.direct).items() if name != "sigma")
        self.assertEqual(parameter_count(encoder) + decoder_size, parameter_count(self.direct))
        self.assertEqual(parameter_count(encoder), plan.encoder_params(self.SENDER, dim=32, slots=4))
        self.assertEqual(decoder_size, plan.decoder_params(self.RECEIVER, 24, dim=32, ffn=64, slots=4))

    @no_grad
    def test_any_encoder_fits_any_decoder_of_the_same_hub(self):
        from latent_hub.hub import split
        other = self.mapper(self.PIVOT, self.SENDER, 12, 3)            # another model as sender
        encoder, _ = split(other)
        _, decoder = split(self.direct)
        keys, values = self.cache(self.PIVOT, 9, 4)
        out_keys, out_values = decoder(self.embeds, self.mask, encoder(keys, values), self.pos, self.allowed)
        self.assertEqual(len(out_keys), self.RECEIVER[0])
        self.assertEqual(tuple(out_values[0].shape), (2, 2, 7, 8))
        with self.assertRaises(ValueError):
            decoder(self.embeds, self.mask, torch.zeros(2, 3, 9, 32), self.pos, self.allowed)

    @no_grad
    def test_hub_state_at_a_token_holds_nothing_of_later_tokens(self):
        from latent_hub.hub import split
        encoder, decoder = split(self.direct)
        hub = encoder(self.keys, self.values)
        keys = [k.clone() for k in self.keys]
        for k in keys:
            k[:, :, 6:] += 5.0                          # change sender tokens 6, 7, 8
        changed = encoder(keys, self.values)
        self.assertTrue(torch.equal(hub[:, :, :6], changed[:, :, :6]))
        self.assertFalse(torch.equal(hub[:, :, 6:], changed[:, :, 6:]))
        # Sender token 6 ends at character 14; receiver tokens 0..4 end at 13 or earlier.
        before = decoder(self.embeds, self.mask, hub, self.pos, self.allowed)
        after = decoder(self.embeds, self.mask, changed, self.pos, self.allowed)
        for a, b in zip(before[0], after[0]):
            self.assertTrue(torch.equal(a[:, :, :5], b[:, :, :5]))
            self.assertFalse(torch.equal(a[:, :, 5:], b[:, :, 5:]))

    def test_one_step_on_a_route_moves_its_two_parts_and_nothing_else(self):
        from latent_hub.hub import split
        encoder, decoder = split(self.direct)
        bystander, _ = split(self.mapper(self.PIVOT, self.RECEIVER, 24, 5))
        keys, values = decoder(self.embeds, self.mask, encoder(self.keys, self.values), self.pos, self.allowed)
        sum(k.pow(2).mean() + v.pow(2).mean() for k, v in zip(keys, values)).backward()
        self.assertTrue(all(p.grad is not None and float(p.grad.abs().sum()) > 0 for p in encoder.parameters()))
        self.assertGreater(float(self.direct.inp.weight.grad.abs().sum()), 0)
        self.assertTrue(all(block.mem.weight.grad is None for block in self.direct.blocks))
        self.assertTrue(all(p.grad is None for p in bystander.parameters()))


@unittest.skipUnless(HAVE_TORCH, "torch is needed for the split and the chain")
class ChainTest(HubCase):
    def setUp(self):
        super().setUp()
        from types import SimpleNamespace
        # The pivot splits the same 18 characters in 6 tokens.
        self.p_spans = [(0, 3), (3, 6), (6, 9), (9, 12), (12, 15), (15, 18)]
        self.first = self.mapper(self.SENDER, self.PIVOT, 12, 6)
        self.second = self.mapper(self.PIVOT, self.RECEIVER, 24, 7)
        torch.manual_seed(8)
        self.pivot_embeds = torch.randn(2, 6, 12)
        pos, allowed = self.alignment(self.s_spans, self.p_spans)
        ids = torch.arange(12).view(2, 6)
        ones = lambda n: torch.ones(2, n, dtype=torch.long)
        self.to_pivot = SimpleNamespace(sender_pos=pos, cross_allowed=allowed, sender_mask=ones(9),
                                        receiver_ids=ids, receiver_mask=ones(6))
        pos, allowed = self.alignment(self.p_spans, self.r_spans)
        self.from_pivot = SimpleNamespace(sender_pos=pos, cross_allowed=allowed, sender_mask=ones(6),
                                          sender_ids=ids.clone(), receiver_mask=ones(7))

    def run_chain(self, keys=None, **changes):
        from latent_hub.hub import chain
        args = dict(first=self.first, second=self.second, pivot_embeds=self.pivot_embeds, receiver_embeds=self.embeds,
                    sender_keys=keys or self.keys, sender_values=self.values, to_pivot=self.to_pivot,
                    from_pivot=self.from_pivot)
        args.update(changes)
        return chain(**args)

    @no_grad
    def test_chain_is_the_second_mapper_on_the_firsts_output(self):
        pivot_keys, pivot_values, keys, values = self.run_chain()
        self.assertEqual((len(pivot_keys), tuple(pivot_keys[0].shape)), (4, (2, 2, 6, 16)))
        self.assertEqual((len(keys), tuple(keys[0].shape)), (6, (2, 2, 7, 8)))
        pos, allowed = self.from_pivot.sender_pos, self.from_pivot.cross_allowed
        want = self.second.scaled(*self.second(self.embeds, torch.ones(2, 7, dtype=torch.long), pivot_keys, pivot_values,
                                               pos, allowed))
        for a, b in zip(want[0] + want[1], keys + values):
            self.assertTrue(torch.equal(a, b))

    @no_grad
    def test_chain_keeps_the_causal_order_end_to_end(self):
        changed = [k.clone() for k in self.keys]
        for k in changed:
            k[:, :, 6:] += 5.0                          # sender tokens from character 12 on
        before, after = self.run_chain(), self.run_chain(keys=changed)
        # Receiver tokens 0..3 end at character 11 or earlier: nothing they read has changed.
        for a, b in zip(before[2], after[2]):
            self.assertTrue(torch.equal(a[:, :, :4], b[:, :, :4]))
            self.assertFalse(torch.equal(a[:, :, 5:], b[:, :, 5:]))

    def test_gradients_reach_both_mappers(self):
        _, _, keys, values = self.run_chain()
        sum(k.pow(2).mean() + v.pow(2).mean() for k, v in zip(keys, values)).backward()
        for mapper in (self.first, self.second):
            self.assertGreater(float(mapper.blocks[0].mem.weight.grad.abs().sum()), 0)

    def test_mismatched_pivot_tokens_and_mappers_are_refused(self):
        self.from_pivot.sender_ids[0, -1] += 1
        with self.assertRaises(ValueError) as caught:
            self.run_chain()
        self.assertIn("different pivot tokens", str(caught.exception))
        self.from_pivot.sender_ids = self.from_pivot.sender_ids[:, :5]
        with self.assertRaises(ValueError):
            self.run_chain()
        with self.assertRaises(ValueError) as caught:
            self.run_chain(second=self.direct)
        self.assertIn("do not share a pivot", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
