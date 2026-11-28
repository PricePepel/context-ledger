"""T4 layer streaming: the analysis (standard library) and the streamer's name split (torch).

The streamer itself runs only in the WSL venv; its checks skip without torch.
"""
import unittest

from layer_stream import analysis

try:
    import torch  # noqa: F401
    HAVE_TORCH = True
except ImportError:
    HAVE_TORCH = False


def receive(rows):
    return {"results": {item: {arm: {"f1": value} for arm, value in arms.items()} for item, arms in rows.items()}}


class QualityTest(unittest.TestCase):
    def setUp(self):
        small = {f"main-{i:03}": {"text": 0.5, "t2t:qwen7": 0.2} for i in range(40)}
        small["long-000"] = {"text": 0.0}
        small["main-000"]["t2t:qwen7"] = {"error": "boom"}
        self.receives = {"qwen1.5": {"results": {
            item: {arm: (value if isinstance(value, dict) else {"f1": value}) for arm, value in arms.items()}
            for item, arms in small.items()}},
            "qwen7": receive({f"main-{i:03}": {"text": 0.9} for i in range(40)})}

    def test_q1_passes_when_a_bigger_reader_reads_better_and_q2_fails_on_worse_summaries(self):
        result = analysis.quality(self.receives)
        self.assertEqual(result["items"], 40)       # edge-group items are left out
        self.assertTrue(result["q1Pass"])
        self.assertAlmostEqual(result["q1"]["qwen7"]["diff"], 0.4)
        self.assertFalse(result["q2Pass"])
        self.assertEqual(result["q2"]["qwen7"]["n"], 39)   # the errored summary is not scored as 0

    def test_a_tie_does_not_pass(self):
        self.receives["qwen7"] = receive({f"main-{i:03}": {"text": 0.5} for i in range(40)})
        self.assertFalse(analysis.quality(self.receives)["q1Pass"])


class ExactnessTest(unittest.TestCase):
    def rows(self, **change):
        base = {"id": "main-000", "argmax": [1, 2, 3], "whole": [5], "split": [5], "moved": [5],
                "kvSerializedBytes": 10, "prefixTokens": 4}
        return {"items": [{**base, **change}]}

    def test_identical_runs_pass_s1_and_s3(self):
        result = analysis.exactness(self.rows(), self.rows())
        self.assertTrue(result["s1Pass"])
        self.assertTrue(result["s3Pass"])

    def test_one_different_position_fails_s1(self):
        self.assertFalse(analysis.exactness(self.rows(), self.rows(argmax=[1, 2, 4]))["s1Pass"])

    def test_a_cache_that_changes_when_moved_fails_s3(self):
        self.assertFalse(analysis.exactness(self.rows(), self.rows(moved=[6]))["s3Pass"])

    def test_different_items_are_refused(self):
        with self.assertRaises(ValueError):
            analysis.exactness(self.rows(), self.rows(id="main-001"))


class VerdictTest(unittest.TestCase):
    def test_the_rule_table(self):
        self.assertTrue(analysis.verdict(False, True, True, True, True).startswith("do not build: the read-once"))
        self.assertTrue(analysis.verdict(True, True, True, False, True).startswith("do not build: on this task"))
        self.assertTrue(analysis.verdict(True, True, True, True, True).startswith("build"))
        self.assertTrue(analysis.verdict(True, True, True, True, False).startswith("do not build yet"))

    def test_s2_uses_the_2048_token_row(self):
        timing = {"lengths": {"2048": {"secondsPer1kTokens": 5.0}}}
        self.assertTrue(analysis.s2(timing)["pass"])
        timing["lengths"]["2048"]["secondsPer1kTokens"] = 5.01
        self.assertFalse(analysis.s2(timing)["pass"])


class MapperCostTest(unittest.TestCase):
    def test_each_step_adds_the_streamed_prefill_of_its_batch(self):
        streamed = {"streamedGiBPerPass": 7.0,
                    "lengths": {"512": {"prefillSeconds": 1.0}, "1024": {"prefillSeconds": 2.0}}}
        cost = analysis.mapper_cost({}, streamed)
        stage1, stage2 = cost["stages"]
        self.assertEqual(stage1["measuredAt"], 1024)    # batch 4 x 256 tokens
        self.assertEqual(stage2["measuredAt"], 512)     # batch 2 x 256 tokens
        self.assertAlmostEqual(stage1["hours"], round(15000 * 2.567 / 3600, 2))
        self.assertAlmostEqual(cost["m2bsHours"], round((15000 * 0.567 + 20000 * 0.539) / 3600, 2))


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class SplitTest(unittest.TestCase):
    def test_layers_below_the_resident_count_stay_and_the_rest_stream(self):
        from layer_stream import stream
        names = ["model.embed_tokens.weight", "model.layers.0.mlp.up_proj.weight", "model.layers.1.mlp.up_proj.weight",
                 "model.layers.10.self_attn.q_proj.weight", "model.norm.weight", "lm_head.weight"]
        resident, streamed = stream.split_names(names, 11, 1)
        self.assertEqual(sorted(streamed), [1, 10])
        self.assertIn("model.layers.0.mlp.up_proj.weight", resident)
        self.assertIn("lm_head.weight", resident)
        self.assertEqual(stream.layer_of("model.layers.10.self_attn.q_proj.weight"), 10)
        self.assertIsNone(stream.layer_of("model.layers_extra.weight"))
        with self.assertRaises(ValueError):
            stream.split_names(names, 11, 12)


if __name__ == "__main__":
    unittest.main()
