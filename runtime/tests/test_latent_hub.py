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
from latent_hub.library import (LibraryError, MAX_PART_BYTES, HttpsOnly, Library, NotCovered, build_key,
                                canary_passes, fetch, local_name, part_url, read_verified)

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


def build_of(model, quantisation="bf16", revision="rev1"):
    return {"model": model, "revision": revision, "weights": {"model.safetensors": digest(model + quantisation)},
            "quantisation": quantisation, "kvDtype": "bf16", "tokenizer": {"tokenizer.json": digest("tok" + model)},
            "shape": [28, 2, 128]}


def key_of(model, quantisation="bf16", revision="rev1"):
    build = build_of(model, quantisation, revision)
    return build_key(build["model"], build["revision"], build["weights"], build["quantisation"], build["kvDtype"],
                     build["tokenizer"], build["shape"])


A, B, C = key_of("org/model-a"), key_of("org/model-b"), key_of("org/model-c")


def part(role, build, gate="passed", data=None):
    data = data if data is not None else f"{role}-{build}".encode()
    return {"role": role, "build": build, "file": f"{role}-{build[:8]}.safetensors",
            "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "gate": gate, "card": "T1b"}


def manifest(kind="split", **changes):
    builds = {key: {**build_of(name), "licence": "Apache-2.0"}
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
        for call in (lambda: plan.parts(1, "split"), lambda: plan.parts(4, "star"), lambda: plan.parts(True, "split"),
                     lambda: plan.mappers_per_handoff("star"), lambda: plan.gpu_hours(1, "split", 3),
                     lambda: plan.gpu_hours(4, "star", 3), lambda: plan.encoder_params((4, 2, 128)),
                     lambda: plan.decoder_params((7, 2, 128), 64)):
            with self.assertRaises(ValueError):
                call()

    def test_a_refusal_does_not_echo_the_design(self):
        with self.assertRaises(ValueError) as caught:
            plan.parts(4, "evil" + chr(0x1b) + "[31m")
        self.assertNotIn("evil", str(caught.exception))

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

    def test_through_refuses_a_part_the_library_does_not_have(self):
        pivot = Library(manifest("pivot"))
        for role, key in (("encoder", A), ("decoder", A), ("encoder", key_of("org/none")), ("encoder", ["x"]), ("hub", B)):
            with self.assertRaises(LibraryError):
                pivot.through(role, key)
        self.assertEqual(pivot.through("decoder", C), sorted([(A, C), (B, C)]))

    def test_pivot_legs_are_routes_of_their_own(self):
        # Codex finding 6: with only the chained pairs measured, a hand-off that ends at the
        # pivot is one direct mapper and needs that mapper's own entry.
        body = manifest("pivot")
        body["routes"] = [r for r in body["routes"] if A not in (r["sender"], r["receiver"])]
        library = Library(body)
        self.assertEqual(sorted(library.offered()), sorted([(B, C), (C, B)]))
        with self.assertRaises(NotCovered) as caught:
            library.route(B, A)
        self.assertEqual(caught.exception.reason, "route_unmeasured")

    def test_what_the_library_hands_out_cannot_change_it(self):
        body = manifest()
        library = Library(body)
        body["parts"][0]["gate"] = "failed"
        body["routes"].clear()
        route = library.route(A, B)
        route["encoder"]["sha256"] = "0" * 64
        route["measured"]["status"] = "failed"
        library.builds[A]["model"] = "evil"
        library.hub["id"] = "other"
        again = library.route(A, B)
        self.assertEqual(again["encoder"]["sha256"], part("encoder", A)["sha256"])
        self.assertEqual((again["measured"]["status"], again["hub"]), ("passed", "hub-v1"))
        self.assertEqual(library.describe(A).split(" ")[0], "org/model-a")

    def test_keys_that_are_not_strings_are_refused_not_crashed_on(self):
        library = Library(manifest())
        for bad in (["x"], {"a": 1}, 3.5):
            for pair in ((bad, A), (A, bad), (bad, bad)):
                with self.assertRaises(NotCovered) as caught:
                    library.route(*pair)
                self.assertEqual(caught.exception.reason, "bad_request")

    def test_same_build_needs_no_part(self):
        body = manifest()
        body["parts"] = [p for p in body["parts"] if p["build"] != B]
        self.assertEqual(Library(body).route(B, B)["kind"], "self")

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
        self.refused(manifest(schema=1.0))
        self.refused(manifest(schema=True))
        self.refused({k: v for k, v in manifest().items() if k != "canary"})
        body = manifest(); body["hub"]["alignment"] = 3; self.refused(body)
        body = manifest("pivot"); body["hub"]["pivot"] = ["x"]; self.refused(body)
        body = manifest("pivot"); body["hub"]["pivot"] = None; self.refused(body)
        body = manifest(); body["parts"][0]["build"] = ["x"]; self.refused(body)
        body = manifest(); body["routes"][0]["sender"] = {"a": 1}; self.refused(body)
        body = manifest(); body["routes"][0]["f1"] = True; self.refused(body)
        body = manifest(); body["parts"][1]["file"] = body["parts"][0]["file"].upper(); self.refused(body)
        # A build whose key is not the digest of its own files and settings.
        body = manifest(); body["builds"][A]["quantisation"] = "awq-int4"; self.refused(body)
        body = manifest(); body["builds"][A]["weights"] = {"model.safetensors": digest("other")}; self.refused(body)
        body = manifest(); del body["builds"][A]["tokenizer"]; self.refused(body)
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
    BASE = "https://example.invalid/lib"

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

    def stored(self):
        return os.path.join(self.folder, local_name(self.part))

    def test_a_matching_file_is_kept_and_not_downloaded_twice(self):
        path = fetch(self.part, self.BASE + "/", self.folder, self.opener(self.data))
        self.assertEqual(self.calls, [self.BASE + "/" + self.part["file"]])
        self.assertEqual(path, self.stored())
        self.assertEqual(read_verified(self.folder, self.part), self.data)
        self.assertEqual(fetch(self.part, self.BASE, self.folder, self.opener(b"")), path)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.left_behind(), [self.part["sha256"] + ".part"])

    def test_wrong_bytes_are_not_kept(self):
        flipped = bytes([self.data[0] ^ 1]) + self.data[1:]
        for data in (flipped, self.data[:-1], self.data + b"more", b""):
            with self.assertRaises(LibraryError):
                fetch(self.part, self.BASE, self.folder, self.opener(data))
            self.assertEqual(self.left_behind(), [])

    def test_a_damaged_file_on_disk_is_refused_and_then_replaced(self):
        for damaged in (b"tampered", bytes(len(self.data))):      # wrong size; right size, wrong content
            with open(self.stored(), "wb") as handle:
                handle.write(damaged)
            with self.assertRaises(LibraryError):
                read_verified(self.folder, self.part)
        fetch(self.part, self.BASE, self.folder, self.opener(self.data))
        self.assertEqual(read_verified(self.folder, self.part), self.data)

    def test_the_bytes_that_were_checked_are_the_bytes_that_load(self):
        # Codex finding 1: a path that passed a check can hold other bytes by the time a
        # loader opens it. read_verified returns the checked bytes, so a swap changes nothing.
        fetch(self.part, self.BASE, self.folder, self.opener(self.data))
        loaded = read_verified(self.folder, self.part)
        with open(self.stored(), "wb") as handle:
            handle.write(bytes(len(self.data)))
        self.assertEqual(hashlib.sha256(loaded).hexdigest(), self.part["sha256"])
        with self.assertRaises(LibraryError):
            read_verified(self.folder, self.part)

    def test_missing_file_and_a_folder_in_its_place(self):
        with self.assertRaises(LibraryError):
            read_verified(self.folder, self.part)
        os.mkdir(self.stored())
        with self.assertRaises(LibraryError):
            read_verified(self.folder, self.part)

    def test_no_manifest_text_reaches_the_file_system(self):
        # Codex finding 2: a raw part record with a path for a name is refused before any file call.
        for name in ("../escape", "sub/enc", "CON" + chr(92) + "x", "", "a" * 200, None):
            bad = dict(self.part, file=name)
            for call in (lambda: fetch(bad, self.BASE, self.folder, self.opener(self.data)),
                         lambda: read_verified(self.folder, bad), lambda: local_name(bad)):
                with self.assertRaises(LibraryError):
                    call()
        for change in (dict(sha256="../../x"), dict(bytes=MAX_PART_BYTES + 1), dict(bytes=True), dict(extra=1)):
            with self.assertRaises(LibraryError):
                fetch(dict(self.part, **change), self.BASE, self.folder, self.opener(self.data))
        self.assertEqual((self.calls, self.left_behind()), ([], []))
        # Reserved device names are harmless: the stored name is the digest, never the manifest's.
        fetch(dict(self.part, file="NUL"), self.BASE, self.folder, self.opener(self.data))
        self.assertEqual(self.left_behind(), [self.part["sha256"] + ".part"])

    def test_only_https_addresses(self):
        for url in ("http://example.invalid/lib", "file:///tmp/lib", "https://example.invalid/a b", None,
                    "https://example.invalid/lib?x=1", "https://example.invalid/lib#frag",
                    "https://user:pw@example.invalid/lib", "https:///lib", "ftp://example.invalid/lib",
                    "https://example.invalid/lib" + chr(0x202e)):
            with self.assertRaises(LibraryError):
                fetch(self.part, url, self.folder, self.opener(self.data))
        self.assertEqual(self.calls, [])
        self.assertEqual(part_url("https://example.invalid", self.part), "https://example.invalid/" + self.part["file"])

    def test_a_redirect_away_from_https_is_refused(self):
        # Codex finding 3: urllib follows a redirect to http unless told not to.
        import urllib.error
        import urllib.request
        handler, request = HttpsOnly(), urllib.request.Request(self.BASE + "/x")
        for target in ("http://example.invalid/x", "ftp://example.invalid/x", "file:///etc/passwd"):
            with self.assertRaises(urllib.error.HTTPError):
                handler.redirect_request(request, None, 302, "Found", {}, target)
        follow = handler.redirect_request(request, None, 302, "Found", {}, "https://mirror.invalid/x")
        self.assertEqual(follow.full_url, "https://mirror.invalid/x")


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
        from latent_hub.hub import split
        from latent_transfer.mapper import parameter_count
        encoder, decoder = split(self.direct)
        decoder_size = parameter_count(decoder)       # the live module, which holds no encoder weights
        self.assertFalse(any(".mem." in name for name in decoder.state_dict()))
        self.assertEqual(parameter_count(encoder) + decoder_size, parameter_count(self.direct))
        self.assertEqual(parameter_count(encoder), plan.encoder_params(self.SENDER, dim=32, slots=4))
        self.assertEqual(decoder_size, plan.decoder_params(self.RECEIVER, 24, dim=32, ffn=64, slots=4))

    @no_grad
    def test_split_stands_alone_and_keeps_the_mappers_type(self):
        # Codex finding 7: the decoder was the live mapper, and the encoder was always float32.
        from latent_hub.hub import split
        mapper = self.mapper(self.SENDER, self.RECEIVER, 24, 0).double()
        encoder, decoder = split(mapper)
        self.assertEqual({p.dtype for p in encoder.parameters()}, {torch.float64})
        keys, values = [k.double() for k in self.keys], [v.double() for v in self.values]
        want = mapper.scaled(*mapper(self.embeds.double(), self.mask, keys, values, self.pos, self.allowed))
        for parameter in mapper.parameters():
            parameter.zero_()                          # the parts must not notice
        mapper.sigma.zero_()
        got = decoder.scaled(*decoder(self.embeds.double(), self.mask, encoder(keys, values), self.pos, self.allowed))
        for a, b in zip(want[0] + want[1], got[0] + got[1]):
            self.assertTrue(torch.equal(a, b))
        self.assertGreater(float(want[0][0].abs().sum()), 0)

    @no_grad
    def test_a_row_of_one_is_not_spread_over_the_batch(self):
        from latent_hub.hub import split
        encoder, decoder = split(self.direct)
        hub = encoder(self.keys, self.values)
        for args in ((self.embeds, self.mask, hub, self.pos[:1], self.allowed),
                     (self.embeds, self.mask, hub, self.pos, self.allowed[:1]),
                     (self.embeds, self.mask, hub[:1], self.pos, self.allowed),
                     (self.embeds, self.mask[:1], hub, self.pos, self.allowed)):
            with self.assertRaises(ValueError):
                decoder(*args)

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
        self.assertGreater(float(decoder.mapper.inp.weight.grad.abs().sum()), 0)
        self.assertTrue(all(p.grad is None for p in self.direct.parameters()))
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
                    from_pivot=self.from_pivot, legs=({"pivot": A, "alignment": 2}, {"pivot": A, "alignment": 2}))
        args.update(changes)
        return chain(**args)

    @no_grad
    def test_chain_is_the_second_mapper_on_the_firsts_output(self):
        pivot_keys, pivot_values, keys, values = self.run_chain()
        self.assertEqual((len(pivot_keys), tuple(pivot_keys[0].shape)), (4, (2, 2, 6, 16)))
        self.assertEqual((len(keys), tuple(keys[0].shape)), (6, (2, 2, 7, 8)))
        # The first leg computed on its own, not taken from the chain's return value.
        ones = torch.ones(2, 6, dtype=torch.long)
        raw = self.first(self.pivot_embeds, ones, self.keys, self.values, self.to_pivot.sender_pos,
                         self.to_pivot.cross_allowed)
        alone = self.first.scaled(*raw)
        for a, b in zip(alone[0] + alone[1], pivot_keys + pivot_values):
            self.assertTrue(torch.equal(a, b))
        self.assertFalse(torch.equal(pivot_keys[0], raw[0][0]), "the hub state is at the pivot's scale")
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

    def test_legs_trained_for_another_pivot_build_or_alignment_rule_are_refused(self):
        # Codex finding 8: the same shapes and token ids do not prove the same pivot.
        with self.assertRaises(ValueError) as caught:
            self.run_chain(legs=({"pivot": A, "alignment": 2}, {"pivot": B, "alignment": 2}))
        self.assertIn("do not share a pivot", str(caught.exception))
        with self.assertRaises(ValueError) as caught:
            self.run_chain(legs=({"pivot": A, "alignment": 1}, {"pivot": A, "alignment": 2}))
        self.assertIn("alignment rules", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
