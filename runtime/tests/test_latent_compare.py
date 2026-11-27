"""L2: the cross-model harness's pure parts (prompts, items, scoring, registry, report).

Standard library only, plus jinja2 for the checks that render real chat templates (they skip
without it). Nothing here loads a model: the torch engine is exercised by the GPU run.
"""
import glob
import http.server
import json
import os
import re
import tempfile
import threading
import unicodedata
import unittest
from unittest import mock

try:
    import jinja2  # noqa: F401
    HAVE_JINJA = True
except ImportError:
    HAVE_JINJA = False

from latent_compare import items as item_sets
from latent_compare import models, prompting, prompts, report, run, stats, vllm_engine

from .chat_template_fixtures import FAMILIES, TemplateTokenizer


def squad_rows(count=3200, titles=40):
    """Synthetic rows shaped like SQuAD's: several titles, an answer that is in its passage."""
    rows = []
    for index in range(count):
        answer = f"code{index:05d}"
        rows.append({"id": f"row{index}", "title": f"Title {index % titles}",
                     "context": f"Passage {index} of title {index % titles} says the code is {answer}. " + "pad " * 40,
                     "question": f"What is the code in passage {index}?", "answers": [answer]})
    return rows


class PromptTest(unittest.TestCase):
    def test_user_content_holds_the_passage_then_the_question(self):
        text = prompts.user_content("P.", " Who? ")
        self.assertEqual(text, "Read this passage.\n\nP.\n\nQuestion: Who?\nAnswer with a few words from the passage.")
        self.assertIn(prompts.ABSTAIN_REPLY, prompts.user_content("P.", "Who?", abstain=True))
        self.assertNotIn("passage", prompts.closed_content("Who?").lower())

    def test_split_puts_the_passage_at_the_end_of_the_prefix(self):
        rendered = f"<s>[INST] Read.\n\n{prompts.SENTINEL}\n\nQuestion: Q[/INST]"
        prefix, suffix = prompts.split_rendered(rendered, "The passage.")
        self.assertEqual(prefix, "<s>[INST] Read.\n\nThe passage.")
        self.assertEqual(suffix, "\n\nQuestion: Q[/INST]")

    def test_split_works_for_an_empty_passage_and_one_that_repeats_the_instruction(self):
        rendered = f"A {prompts.SENTINEL} B"
        self.assertEqual(prompts.split_rendered(rendered, ""), ("A ", " B"))
        self.assertEqual(prompts.split_rendered(rendered, "A  B Question:"), ("A A  B Question:", " B"))

    def test_split_refuses_a_template_that_lost_or_repeated_the_passage(self):
        for rendered in ("no passage here", f"{prompts.SENTINEL} and {prompts.SENTINEL}"):
            with self.assertRaises(ValueError):
                prompts.split_rendered(rendered, "P")

    def test_prefix_tokens_stop_before_a_token_that_crosses_the_boundary(self):
        offsets = [(0, 0), (0, 4), (4, 9), (9, 12), (12, 20)]
        self.assertEqual(prompts.prefix_token_count(offsets, 9), 3)
        # A token covering characters 9..12 straddles a boundary at 10: it is question text.
        self.assertEqual(prompts.prefix_token_count(offsets, 10), 3)
        self.assertEqual(prompts.prefix_token_count(offsets, 0), 1)
        self.assertEqual(prompts.prefix_token_count(offsets, 99), 5)
        self.assertEqual(prompts.prefix_token_count([], 5), 0)

    def test_fit_keeps_the_head_and_says_when_it_cut(self):
        self.assertEqual(prompts.fit_tokens(100, 50, 2048, 24), (100, False))
        self.assertEqual(prompts.fit_tokens(3000, 50, 2048, 24), (1974, True))
        self.assertEqual(prompts.fit_tokens(10, 2040, 2048, 24), (0, True))
        self.assertEqual(prompts.fit_tokens(0, 50, 2048, 24), (0, False))

    def test_cut_passage_ends_on_a_token_edge(self):
        passage, offsets = "one two three", [(0, 3), (3, 7), (7, 13)]
        self.assertEqual(prompts.cut_passage(passage, offsets, 2), "one two")
        self.assertEqual(prompts.cut_passage(passage, offsets, 3), passage)
        self.assertEqual(prompts.cut_passage(passage, offsets, 0), "")

    def test_system_role_is_detected_from_what_the_template_does(self):
        def carries(messages):
            return "".join(m["content"] for m in messages)

        def drops(messages):
            return "".join(m["content"] for m in messages if m["role"] != "system")

        def raises(messages):
            raise RuntimeError("Only user and assistant roles are supported")

        self.assertTrue(prompts.supports_system(carries))
        self.assertFalse(prompts.supports_system(drops))
        self.assertFalse(prompts.supports_system(raises))

    def test_without_a_system_role_the_instruction_opens_the_user_turn(self):
        self.assertEqual(prompts.chat_messages("U"), [{"role": "user", "content": "U"}])
        self.assertEqual(prompts.chat_messages("U", "S", True),
                         [{"role": "system", "content": "S"}, {"role": "user", "content": "U"}])
        self.assertEqual(prompts.chat_messages("U", "S", False), [{"role": "user", "content": "S\n\nU"}])


@unittest.skipUnless(HAVE_JINJA, "jinja2 is not installed")
class RealTemplateTest(unittest.TestCase):
    """The split holds on every target family's real chat template."""

    def render(self, name, messages):
        return TemplateTokenizer(name).apply_chat_template(messages, tokenize=False, add_generation_prompt=True)

    def test_every_family_renders_the_passage_once_and_splits_after_it(self):
        passage = "Zarina moved 412 boxes.\nSecond line é."
        for name in FAMILIES:
            with self.subTest(name):
                for system_ok in (True, False):
                    messages = prompts.chat_messages(prompts.user_content(prompts.SENTINEL, "How many boxes?"),
                                                     prompts.SYSTEM_TEXT, system_ok)
                    prefix, suffix = prompts.split_rendered(self.render(name, messages), passage)
                    self.assertTrue(prefix.endswith("Read this passage.\n\n" + passage))
                    self.assertTrue(suffix.startswith("\n\nQuestion: How many boxes?"))
                    self.assertIn(prompts.SYSTEM_TEXT, prefix)

    def test_every_family_here_carries_a_system_message(self):
        for name in FAMILIES:
            with self.subTest(name):
                self.assertTrue(prompts.supports_system(lambda m, name=name: self.render(name, m)))

    def test_a_template_that_refuses_the_system_role_is_folded(self):
        refusing = ("{% for message in messages %}{% if message['role'] == 'system' %}"
                    "{{ raise_exception('System role not supported') }}{% endif %}"
                    "<start_of_turn>{{ message['role'] }}\n{{ message['content'] }}<end_of_turn>\n{% endfor %}"
                    "{% if add_generation_prompt %}<start_of_turn>model\n{% endif %}")
        tokenizer = TemplateTokenizer("refusing", refusing, specials=["<start_of_turn>", "<end_of_turn>"])

        def render(messages):
            return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)

        self.assertFalse(prompts.supports_system(render))
        messages = prompts.chat_messages(prompts.user_content(prompts.SENTINEL, "Q?"), prompts.SYSTEM_TEXT, False)
        prefix, _ = prompts.split_rendered(render(messages), "P")
        self.assertTrue(prefix.startswith("<start_of_turn>user\n" + prompts.SYSTEM_TEXT + "\n\nRead this passage."))


class StatsTest(unittest.TestCase):
    def test_exact_match_uses_squad_normalization(self):
        self.assertEqual(stats.exact("The Eiffel Tower.", ["eiffel tower"]), 1.0)
        self.assertEqual(stats.exact("the tower in Paris", ["eiffel tower", "Paris"]), 0.0)
        self.assertEqual(stats.exact("", ["x"]), 0.0)

    def test_hit_finds_an_answer_inside_unspaced_text(self):
        self.assertEqual(stats.hit("搬运一共用了37辆卡车", ["37"]), 1.0)
        self.assertEqual(stats.hit("It weighed 748 kg", ["748 Kilogramm", "748"]), 1.0)
        self.assertEqual(stats.hit("no number", ["37"]), 0.0)
        self.assertEqual(stats.hit("anything", []), 0.0)
        self.assertEqual(stats.hit("anything", ["", "."]), 0.0)

    def test_an_unanswerable_item_is_right_only_when_the_model_abstains(self):
        item = {"answers": [], "answerable": False}
        self.assertEqual(stats.score("Not in passage.", item)["f1"], 1.0)
        self.assertEqual(stats.score("Paris", item)["f1"], 0.0)
        answerable = {"answers": ["Paris"], "answerable": True}
        scored = stats.score("Paris", answerable)
        self.assertEqual((scored["f1"], scored["em"], scored["hit"], scored["abstained"]), (1.0, 1.0, 1.0, 0.0))
        self.assertEqual(stats.score("not in passage", answerable)["f1"], 0.0)

    def test_a_reply_that_answers_and_then_says_the_phrase_is_not_an_abstention(self):
        # Codex review: a substring test gave these full credit on an unanswerable item.
        for reply in ("The answer is Paris, not in passage", "It is not in passages", "Paris. Not in passage."):
            self.assertEqual(stats.abstained(reply), 0.0, reply)
        for reply in ("not in passage", "Not in passage.", "  NOT IN PASSAGE!  "):
            self.assertEqual(stats.abstained(reply), 1.0, reply)

    def test_paired_interval_keeps_pairs_together(self):
        # b is a + 0.5 on every item, so the difference has no spread at all.
        a = [0.0, 1.0] * 20
        b = [value + 0.5 for value in a]
        self.assertEqual(stats.paired_interval(b, a, rounds=200), (0.5, 0.5))
        low, high = stats.mean_interval(a, rounds=500)
        self.assertLess(low, 0.5)
        self.assertGreater(high, 0.5)
        with self.assertRaises(ValueError):
            stats.paired_interval([1.0], [1.0, 0.0])

    def test_compare_reports_the_difference_and_is_repeatable(self):
        a, b = [1.0, 1.0, 0.0, 1.0] * 10, [0.0, 1.0, 0.0, 0.0] * 10
        first, second = stats.compare(a, b, rounds=300), stats.compare(a, b, rounds=300)
        self.assertEqual(first, second)
        self.assertEqual(first["diff"], 0.5)
        self.assertGreater(first["low"], 0)
        self.assertEqual(first["n"], 40)
        self.assertIsNone(stats.compare([], []))

    def test_kv_bytes_counts_keys_and_values(self):
        # Phi-3.5-mini: 32 layers, 32 KV heads, head dim 96, two bytes a value.
        self.assertEqual(stats.kv_bytes(32, 32, 96, 1), 393216)
        self.assertEqual(stats.kv_bytes(28, 2, 128, 100), 28 * 2 * 2 * 128 * 100 * 2)


class ModelsTest(unittest.TestCase):
    def test_registry_names_what_the_report_prints(self):
        self.assertGreaterEqual(len(models.MODELS), 5)
        for key, spec in models.MODELS.items():
            with self.subTest(key):
                for field in ("id", "family", "params", "weights", "licence", "tokenizer", "template"):
                    self.assertTrue(spec[field])
        self.assertEqual(len({spec["id"] for spec in models.MODELS.values()}), len(models.MODELS))

    def test_only_a_listed_pair_has_a_mapper(self):
        self.assertEqual(models.latent_status("phi3.5", "qwen1.5"), "mapper")
        self.assertEqual(models.latent_status("qwen1.5", "phi3.5"), "none")
        self.assertEqual(models.latent_status("qwen3", "qwen3"), "self")
        self.assertEqual(models.latent_status("qwen7", "qwen7"), "self_refused")   # behind vLLM
        self.assertEqual((models.backend("qwen7"), models.backend("llama8"), models.backend("phi3.5")),
                         ("vllm", "vllm", "torch"))
        cross = [(s, r) for s in models.MODELS for r in models.MODELS if s != r]
        self.assertEqual(sum(models.latent_status(s, r) == "none" for s, r in cross), len(cross) - len(models.MAPPERS))
        for sender, receiver in models.MAPPERS:
            self.assertIn(sender, models.MODELS)
            self.assertIn(receiver, models.MODELS)

    def test_keys_parses_a_subset_and_refuses_unknown_or_repeated_names(self):
        self.assertEqual(models.keys(), list(models.MODELS))
        self.assertEqual(models.keys("phi3.5, qwen1.5"), ["phi3.5", "qwen1.5"])
        for bad in ("gpt4", "qwen3,qwen3"):
            with self.assertRaises(ValueError):
                models.keys(bad)

    def test_shape_comes_from_the_config(self):
        qwen = {"num_hidden_layers": 28, "num_attention_heads": 12, "num_key_value_heads": 2, "hidden_size": 1536,
                "max_position_embeddings": 32768}
        self.assertEqual(models.shape_of(qwen), {"layers": 28, "kvHeads": 2, "headDim": 128, "hidden": 1536,
                                                 "context": 32768})
        phi = {"num_hidden_layers": 32, "num_attention_heads": 32, "hidden_size": 3072}
        self.assertEqual(models.shape_of(phi)["kvHeads"], 32)
        self.assertEqual(models.shape_of(phi)["headDim"], 96)


class ItemsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.groups = item_sets.build(squad_rows(), lambda passage: "passage 7 " not in passage.lower())

    def test_every_named_group_is_built(self):
        self.assertEqual(tuple(self.groups), item_sets.GROUPS)
        sizes = {name: len(rows) for name, rows in self.groups.items()}
        self.assertEqual(sizes, {"main": 200, "long_passage": 20, "tiny_passage": 10, "non_english_emoji": 12,
                                 "unanswerable": 40, "no_system_role": 40})
        ids = [item["id"] for rows in self.groups.values() for item in rows]
        self.assertEqual(len(ids), len(set(ids)))

    def test_the_main_set_is_seeded_and_skips_passages_that_do_not_fit(self):
        again = item_sets.build(squad_rows(), lambda passage: "passage 7 " not in passage.lower())
        self.assertEqual(self.groups["main"], again["main"])
        self.assertFalse(any("Passage 7 " in item["passage"] for item in self.groups["main"]))
        other = item_sets.build(squad_rows(), lambda passage: True, seed=1)
        self.assertNotEqual([i["squadId"] for i in self.groups["main"]], [i["squadId"] for i in other["main"]])
        with self.assertRaises(ValueError):
            item_sets.main_items(squad_rows(50), lambda passage: True)

    def test_no_edge_item_repeats_a_main_question(self):
        main = {item["squadId"] for item in self.groups["main"]}
        for group in ("long_passage", "unanswerable"):
            self.assertFalse(main & {item["squadId"] for item in self.groups[group]})

    def test_long_passages_are_long_and_hold_the_answer_first_or_last(self):
        for index, item in enumerate(self.groups["long_passage"]):
            self.assertGreaterEqual(len(item["passage"]), item_sets.LONG_CHARS)
            paragraphs = item["passage"].split("\n\n")
            self.assertEqual(len(paragraphs), len(set(paragraphs)))
            place = paragraphs[0] if item["answerAt"] == "head" else paragraphs[-1]
            self.assertEqual(item["answerAt"], "head" if index % 2 == 0 else "tail")
            self.assertIn(item["answers"][0], place)
            self.assertEqual(sum(item["answers"][0] in paragraph for paragraph in paragraphs), 1)

    def test_tiny_passages_are_one_word_or_empty(self):
        tiny = self.groups["tiny_passage"]
        self.assertEqual([item["kind"] for item in tiny].count("empty"), 4)
        for item in tiny:
            if item["kind"] == "empty":
                self.assertEqual((item["passage"], item["answers"], item["answerable"]), ("", [], False))
            else:
                self.assertEqual(item["answers"], [item["passage"]])
                self.assertNotIn(" ", item["passage"])
            self.assertTrue(item_sets.uses_abstain(item))

    def test_non_english_items_hold_their_answer_and_real_edge_characters(self):
        rows = self.groups["non_english_emoji"]
        for item in rows:
            self.assertEqual(stats.hit(item["passage"], item["answers"]), 1.0, item["id"])
            self.assertFalse(item_sets.uses_abstain(item))
        text = "".join(item["passage"] for item in rows)
        self.assertGreaterEqual(len({item["language"] for item in rows}), 9)
        self.assertIn(chr(0x200D), text)            # a joined emoji sequence
        self.assertTrue(any(ord(ch) > 0xFFFF for ch in text))   # beyond the basic plane
        self.assertTrue(any(unicodedata.bidirectional(ch) == "AL" for ch in text))  # right-to-left script
        self.assertGreater(len(text.encode("utf-8")), len(text) * 1.5)

    def test_unanswerable_questions_get_a_passage_without_their_answer(self):
        rows = self.groups["unanswerable"]
        lookup = {row["id"]: row for row in squad_rows()}
        unanswerable = [item for item in rows if not item["answerable"]]
        self.assertEqual(len(unanswerable), 20)
        for item in unanswerable:
            source = lookup[item["squadId"]]
            self.assertEqual(item["answers"], [])
            self.assertNotIn(source["answers"][0], item["passage"])
            self.assertNotEqual(item["passage"], source["context"].strip())
        for item in rows[20:]:
            self.assertIn(item["answers"][0], item["passage"])

    def test_system_items_are_main_items_with_their_own_ids(self):
        for item, main in zip(self.groups["no_system_role"], self.groups["main"]):
            self.assertEqual((item["mainId"], item["passage"], item["question"]),
                             (main["id"], main["passage"], main["question"]))
            self.assertEqual(item["group"], "no_system_role")

    def test_sources_hold_no_hidden_characters(self):
        folder = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "latent_compare")
        files = glob.glob(os.path.join(folder, "*.py")) + [os.path.abspath(__file__)]
        self.assertGreater(len(files), 5)
        for name in files:
            with open(name, encoding="utf-8") as handle:
                hidden = [hex(ord(ch)) for ch in handle.read()
                          if unicodedata.category(ch) in ("Cc", "Cf") and ch not in "\t\n\r"]
            self.assertEqual(hidden, [], name)


def answer(text, item, ms=100.0, size=500, **extra):
    return {"answer": text, "ms": ms, "newTokens": 2, "bytes": size, **stats.score(text, item),
            "promptTokens": 120, "passageTokens": 90, "keptTokens": 90, "truncated": False, **extra}


def fake_receive(groups, key, others, wrong_every=4, system_ok=True):
    """A receive file where text is right, summaries are wrong on every 4th item, and the
    handed-over cache answers exactly as text does."""
    results = {}
    for group, rows in groups.items():
        for index, item in enumerate(rows):
            right = item["answers"][0] if item["answers"] else prompts.ABSTAIN_REPLY
            cache = {"prefixTokens": 100, "prefillMs": 40.0, "saveMs": 5.0, "loadMs": 6.0, "answerMs": 60.0}
            long = {"truncated": True, "keptTokens": 1900, "passageTokens": 3000, "promptTokens": 2010} \
                if group == "long_passage" else {}
            record = {"text": answer(right, item, **long), "self_cache": answer(right, item, 111.0, 4000000, **cache, **long)}
            if group == "main":
                record["closed"] = answer("unknown", item, 50.0, 0)
            if group != "no_system_role":
                for sender in (others if group == "main" else [key]):
                    record[f"t2t:{sender}"] = answer("unknown" if index % wrong_every == 0 else right, item, 900.0, 200,
                                                    receiverMs=90.0)
            results[item["id"]] = record
    shape = {"layers": 28, "kvHeads": 2, "headDim": 128, "hidden": 1536, "context": 32768}
    return {"model": {**models.MODELS[key], "key": key, **shape, "systemRole": system_ok, "cacheDtype": "bfloat16",
                      "gpuGiB": 3.1}, "results": results}


def fake_latent(groups):
    results = {}
    for group in run.LATENT_GROUPS:
        for index, item in enumerate(groups[group]):
            right = item["answers"][0] if item["answers"] else "nothing"
            mapped = {"senderTokens": 150, "receiverTokens": 140, "alignMs": 4.0, "senderMs": 80.0, "mapperMs": 50.0,
                      "mappedBytes": 4014080}
            record = {"text_m2b": answer(right, item), "swat": answer(right, item, 400.0, 58982400, **mapped)}
            if group == "main":
                record["mismatched"] = answer("unknown", item, 400.0, 58982400, **mapped)
                record["zeroed"] = answer("", item, 400.0, 58982400, **mapped)
                record["t2t_m2b"] = answer("unknown" if index % 2 else right, item, 3000.0, 200, receiverMs=90.0)
            results[item["id"]] = record
    return {"sender": "phi3.5", "receiver": "qwen1.5", "checkpoint": "abc123", "shapes": {}, "results": results}


class ReportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.groups = item_sets.build(squad_rows(), lambda passage: True)
        cls.keys = ["qwen1.5", "qwen3", "phi3.5", "granite2", "mistral7"]
        cls.receive = {key: fake_receive(cls.groups, key, cls.keys, system_ok=key != "mistral7") for key in cls.keys}
        cls.summaries = {key: {"summaries": {item["id"]: {"summary": "s", "ms": 800.0, "bytes": 200, "newTokens": 50}
                                             for item in cls.groups["main"]}} for key in cls.keys}
        cls.latent = {("phi3.5", "qwen1.5"): fake_latent(cls.groups)}
        cls.summary = report.build_summary(cls.groups, cls.receive, cls.summaries, cls.latent, rounds=300)

    def test_only_the_mapper_pair_and_the_diagonal_are_measured(self):
        table = self.summary["latentTable"]
        cells = [(s, r, table[s][r]["status"]) for s in self.keys for r in self.keys]
        self.assertEqual(sum(status == "self" for _, _, status in cells), 5)
        self.assertEqual([(s, r) for s, r, status in cells if status == "mapper"], [("phi3.5", "qwen1.5")])
        self.assertEqual(sum(status == "none" for _, _, status in cells), 19)
        markdown = report.render_markdown(self.summary)
        self.assertEqual(markdown.count(report.NO_MAPPER), 19)
        self.assertIn("**1.000** (mapper)", markdown)

    def test_a_mapper_whose_checkpoint_is_missing_is_named_not_hidden(self):
        summary = report.build_summary(self.groups, self.receive, self.summaries,
                                       {("phi3.5", "qwen1.5"): {"skipped": "The mapper checkpoint is not here."}}, rounds=300)
        self.assertEqual(summary["latentTable"]["phi3.5"]["qwen1.5"]["status"], "mapper_not_run")
        self.assertFalse(summary["checks"]["mapperHolds"]["passed"])
        self.assertIn("mapper not run", report.render_markdown(summary))
        without = report.build_summary(self.groups, self.receive, self.summaries, {}, rounds=300)
        self.assertEqual(without["latentTable"]["phi3.5"]["qwen1.5"]["status"], "mapper_not_run")
        self.assertFalse(without["checks"]["mapperHolds"]["passed"])
        self.assertTrue(without["checks"]["mapperHolds"]["applicable"])
        # Codex review, round 6: a subset with no mapper pair printed "Fail" for a check that does not apply.
        subset = {key: self.receive[key] for key in self.receive if key != "phi3.5"}
        alone = report.build_summary(self.groups, subset, self.summaries, {}, rounds=300)
        self.assertEqual(alone["checks"]["mapperHolds"]["applicable"], False)
        self.assertIn("| mapperHolds | Not applicable |", report.render_markdown(alone))

    def test_main_aggregates_and_paired_differences(self):
        row = self.summary["main"]["receivers"]["qwen3"]
        self.assertEqual((row["text"]["f1"], row["text"]["em"], row["closed"]["f1"]), (1.0, 1.0, 0.0))
        self.assertEqual(row["self_cache"]["sameAnswer"], 1.0)
        self.assertEqual(row["self_cache"]["vsText"]["f1"], {"diff": 0.0, "low": 0.0, "high": 0.0, "n": 200})
        self.assertEqual(row["self_cache"]["bytes"], 4000000)
        cell = self.summary["main"]["t2t"]["phi3.5"]["qwen3"]
        self.assertEqual(cell["f1"], 0.75)
        self.assertEqual(cell["vsText"]["f1"]["diff"], -0.25)
        self.assertLess(cell["vsText"]["f1"]["high"], 0)
        self.assertEqual((cell["ms"], cell["receiverMs"], cell["bytes"]), (900.0, 90.0, 200))
        self.assertEqual(self.summary["main"]["senders"]["phi3.5"], {"n": 200, "ms": 800.0, "bytes": 200, "newTokens": 50.0})

    def test_mapper_pair_intervals_and_checks(self):
        pair = self.summary["latent"]["phi3.5>qwen1.5"]
        self.assertEqual(pair["arms"]["swat"]["f1"], 1.0)
        self.assertEqual(pair["arms"]["swat"]["mappedBytes"], 4014080)
        self.assertGreater(pair["intervals"]["swat-mismatched"]["f1"]["low"], 0)
        self.assertGreater(pair["intervals"]["swat-harness_t2t"]["f1"]["low"], 0)
        self.assertEqual(pair["intervals"]["swat-harness_text"]["f1"]["diff"], 0.0)
        self.assertEqual(pair["edge"]["tiny_passage"]["swat"]["n"], 6)   # answerable items only
        checks = self.summary["checks"]
        self.assertTrue(all(check["passed"] for check in checks.values()), checks)
        self.assertEqual(checks["coverage"]["models"], 5)

    def test_edge_groups_are_split_the_way_the_eval_reads_them(self):
        edge = self.summary["edge"]["mistral7"]
        self.assertEqual(edge["long_passage"]["head"]["text"]["n"], 10)
        self.assertEqual(edge["long_passage"]["tail"]["t2t"]["n"], 10)
        self.assertEqual((edge["long_passage"]["truncatedShare"], edge["long_passage"]["maxPromptTokens"]), (1.0, 2010))
        self.assertEqual(edge["tiny_passage"]["empty"]["text"], edge["tiny_passage"]["empty"]["text"] | {"n": 4, "f1": 1.0})
        self.assertEqual(edge["unanswerable"]["unanswerable"]["text"]["f1"], 1.0)
        self.assertEqual(edge["unanswerable"]["controlAbstained"]["text"], 0.0)
        self.assertFalse(edge["no_system_role"]["systemRole"])
        self.assertEqual(edge["no_system_role"]["vsPlain"]["n"], 40)
        self.assertIn("no (instruction opens the user turn)", report.render_markdown(self.summary))

    def test_an_arm_that_failed_is_counted_and_fails_the_edge_check(self):
        receive = {key: fake_receive(self.groups, key, self.keys) for key in self.keys}
        broken = self.groups["non_english_emoji"][3]["id"]
        receive["qwen3"]["results"][broken]["self_cache"] = {"error": "RuntimeError: boom"}
        summary = report.build_summary(self.groups, receive, self.summaries, self.latent, rounds=300)
        self.assertEqual(summary["edge"]["qwen3"]["non_english_emoji"]["errors"], 1)
        self.assertEqual(summary["edge"]["qwen3"]["non_english_emoji"]["self_cache"]["n"], 11)
        self.assertFalse(summary["checks"]["edgeCases"]["passed"])
        self.assertEqual(summary["checks"]["edgeCases"]["errors"]["qwen3"], 1)

    def test_a_cache_that_changes_answers_fails_the_faithful_check(self):
        receive = {key: fake_receive(self.groups, key, self.keys) for key in self.keys}
        for item in self.groups["main"][:30]:
            receive["phi3.5"]["results"][item["id"]]["self_cache"] = answer("unknown", item, 111.0, 4000000,
                                                                            prefixTokens=100, prefillMs=40.0, saveMs=5.0,
                                                                            loadMs=6.0, answerMs=60.0)
        checks = report.build_summary(self.groups, receive, self.summaries, self.latent, rounds=300)["checks"]
        self.assertFalse(checks["handoffFaithful"]["passed"])
        self.assertEqual([key for key, good in checks["handoffFaithful"]["models"].items() if not good], ["phi3.5"])

    def test_fewer_than_five_models_fails_coverage(self):
        few = {key: self.receive[key] for key in self.keys[:4]}
        self.assertFalse(report.build_summary(self.groups, few, self.summaries, self.latent, rounds=300)["checks"]["coverage"]["passed"])

    def test_the_summary_holds_no_passage_or_answer_text(self):
        import json
        dumped = json.dumps(self.summary)
        self.assertNotIn("says the code is", dumped)
        self.assertNotIn("code00012", dumped)


class RunTest(unittest.TestCase):
    def test_an_arm_that_raises_becomes_a_record(self):
        record = {}
        run.guarded(record, "text", lambda: {"answer": "ok"})

        def fail():
            raise ValueError("A document produced no tokens on one side.")
        run.guarded(record, "swat", fail)
        self.assertEqual(record["text"], {"answer": "ok"})
        self.assertEqual(record["swat"], {"error": "ValueError: A document produced no tokens on one side."})

    def test_running_out_of_gpu_memory_is_a_record_and_the_gpu_is_cleaned(self):
        cleaned = []

        def oom():
            raise RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")
        record = {}
        run.guarded(record, "text", oom, lambda: cleaned.append(True))
        run.guarded(record, "closed", lambda: {"answer": "ok"}, lambda: cleaned.append(True))
        self.assertTrue(record["text"]["error"].startswith("RuntimeError: CUDA out of memory"))
        self.assertEqual(cleaned, [True])

    def test_the_mismatched_control_never_gets_the_right_passage_back(self):
        # Codex review: SQuAD asks several questions of one paragraph, so index + 1 could
        # hand the control the correct passage.
        rows = [{"passage": "A"}, {"passage": "A "}, {"passage": "B"}, {"passage": "A"}]
        self.assertEqual([run.mismatch_index(rows, i) for i in range(4)], [2, 2, 3, 2])
        with self.assertRaises(ValueError):
            run.mismatch_index([{"passage": "A"}, {"passage": "A"}], 0)

    def test_only_the_long_group_runs_at_the_small_context(self):
        self.assertEqual(run.limit_for({"group": "long_passage"}), run.LONG_CONTEXT)
        self.assertIsNone(run.limit_for({"group": "main"}))


class FakeEngine:
    """Stands in for the torch engine: it "reads" the code out of whatever passage it is given."""

    loads = []
    hands_over_cache = True

    def __init__(self, key):
        self.key = key
        FakeEngine.loads.append(key)

    def prepare(self, passage, question, abstain=False, system=None, limit=None):
        return {"ids": [passage, question], "prefixTokens": 5, "promptTokens": 9, "passageTokens": 4, "keptTokens": 4,
                "truncated": False, "passageBytes": len(passage.encode("utf-8")), "prepareMs": 1.0}

    def closed_ids(self, question):
        return ["", question]

    def timed(self, ids, max_new_tokens=24):
        found = re.search(r"code\d{5}", ids[0])
        return {"answer": found.group(0) if found else "unknown", "ms": 10.0, "newTokens": 2}

    def answer_from_cache(self, prepared):
        return {**self.timed(prepared["ids"]), "bytes": 4000, "prefixTokens": 5, "prefillMs": 4.0, "saveMs": 1.0,
                "loadMs": 1.0, "answerMs": 4.0}

    def summarize(self, passage, limit=None, max_new_tokens=96):
        found = re.search(r"code\d{5}", passage)
        text = f"{self.key} says {found.group(0) if found else 'nothing'}"
        return {"summary": text, "ms": 100.0, "newTokens": 5, "bytes": len(text), "passageTokens": 4, "keptTokens": 4,
                "truncated": False}

    def describe(self):
        return {**models.MODELS[self.key], "key": self.key, "layers": 2, "kvHeads": 2, "headDim": 8, "hidden": 16,
                "context": 4096, "systemRole": True, "cacheDtype": "bfloat16", "gpuGiB": 0.1}

    def recover(self):
        pass

    def close(self):
        pass


class PhaseTest(unittest.TestCase):
    """The phases with a fake engine: what is saved, what is reused and what is refused."""

    @classmethod
    def setUpClass(cls):
        cls.groups = item_sets.build(squad_rows(), lambda passage: True)

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.out = self.folder.name
        run.save(run.path(self.out, "items.json"), self.groups)
        FakeEngine.loads.clear()

    def tearDown(self):
        self.folder.cleanup()

    def summaries(self, key, groups=None):
        run.phase_summaries(self.out, key, groups or self.groups, engine_factory=FakeEngine)

    def receive(self, key, senders, groups=None, force=False):
        run.phase_receive(self.out, key, groups or self.groups, senders, force, engine_factory=FakeEngine)

    def read(self, folder, key):
        return run.load(os.path.join(self.out, folder, f"{key}.json"))

    def run_all(self, keys, fail=None):
        """`all` with the fake engine; the (phase, model, force) of each call it made."""
        calls = []

        def summaries(out, key, groups, force):
            calls.append(("summaries", key, force))
            return run.phase_summaries(out, key, groups, force, engine_factory=FakeEngine)

        def receive(out, key, groups, senders, force):
            calls.append(("receive", key, force))
            if key == fail:
                raise RuntimeError("the server did not start")
            return run.phase_receive(out, key, groups, senders, force, engine_factory=FakeEngine)

        summary = run.run_all(self.out, keys, self.groups, summaries=summaries, receive=receive, pairs=[])
        return calls, summary

    def test_a_sender_whose_summaries_were_written_again_is_read_again(self):
        # Codex review, round 5: receivers and the mapper pair kept answers to a sender's
        # previous summaries after a retry wrote them anew.
        for key in ("qwen1.5", "phi3.5"):
            self.summaries(key)
        self.receive("qwen1.5", ["qwen1.5", "phi3.5"])
        saved = self.read("receive", "qwen1.5")
        self.assertEqual(sorted(saved["summaryStamps"]), ["phi3.5", "qwen1.5"])
        FakeEngine.loads.clear()
        self.receive("qwen1.5", ["qwen1.5", "phi3.5"])
        self.assertEqual(FakeEngine.loads, [])                              # nothing changed: reused

        target = os.path.join(self.out, "summaries", "phi3.5.json")
        data = run.load(target)
        record = data["summaries"][self.groups["main"][0]["id"]]
        record["ms"] = record.get("ms", 0) + 1                              # written again: a timing differs
        run.save(target, data)
        self.receive("qwen1.5", ["qwen1.5", "phi3.5"])
        self.assertEqual(FakeEngine.loads, ["qwen1.5"])                     # the receiver ran again
        self.assertNotEqual(self.read("receive", "qwen1.5")["summaryStamps"]["phi3.5"], saved["summaryStamps"]["phi3.5"])

        # A receive file from before stamps were recorded is not thrown away.
        legacy = self.read("receive", "qwen1.5")
        del legacy["summaryStamps"]
        run.save(os.path.join(self.out, "receive", "qwen1.5.json"), legacy)
        FakeEngine.loads.clear()
        self.receive("qwen1.5", ["qwen1.5", "phi3.5"])
        self.assertEqual(FakeEngine.loads, [])

        spec = models.MAPPERS[("phi3.5", "qwen1.5")]
        result = {"checkpoint": spec["id"], "senderSummaries": True, "summaryStamp": "aaaa"}
        self.assertTrue(run.latent_current(result, spec, True, "aaaa"))
        self.assertFalse(run.latent_current(result, spec, True, "bbbb"))    # the summaries changed
        self.assertTrue(run.latent_current({**result, "summaryStamp": None}, spec, True, "bbbb"))
        self.assertTrue(run.latent_current(result, spec, False))

    def test_a_report_on_a_subset_leaves_out_a_mapper_pair_outside_it(self):
        # Codex review, round 5: an old mapper file with an error failed the edge check of a
        # report whose models did not include the pair.
        for key in ("qwen1.5", "qwen3"):
            self.summaries(key)
        for key in ("qwen1.5", "qwen3"):
            self.receive(key, ["qwen1.5", "qwen3"])
        latent = fake_latent(self.groups)
        latent["results"][self.groups["long_passage"][0]["id"]]["swat"] = {"error": "ValueError: no tokens"}
        spec = models.MAPPERS[("phi3.5", "qwen1.5")]
        run.save(run.path(self.out, "latent", "phi3.5__qwen1.5.json"),
                 {**latent, "itemsId": run.fingerprint(self.groups), "checkpoint": spec["id"]})
        _, _, pairs, _ = run.collect(self.out, self.groups, ["qwen1.5", "qwen3"])
        self.assertEqual(pairs, {})
        _, _, pairs, _ = run.collect(self.out, self.groups, ["qwen1.5", "qwen3", "phi3.5"])
        self.assertEqual(list(pairs), [("phi3.5", "qwen1.5")])

    def test_a_plain_kill_unwinds_the_run_so_a_server_is_stopped(self):
        # Codex review, round 5: SIGTERM ended Python without running `finally`, and the vLLM
        # server, in its own session, kept the port and the GPU.
        before = run.signal.getsignal(run.signal.SIGTERM)
        try:
            stop = run.stop_on_sigterm()
            self.assertIs(run.signal.getsignal(run.signal.SIGTERM), stop)
            closed = []
            with self.assertRaises(SystemExit) as raised:
                try:
                    stop(run.signal.SIGTERM, None)
                finally:
                    closed.append("engine")
            self.assertEqual((raised.exception.code, closed), (128 + run.signal.SIGTERM, ["engine"]))
        finally:
            run.signal.signal(run.signal.SIGTERM, before)

    def test_a_report_leaves_out_answers_to_summaries_that_were_written_again(self):
        # Codex review, round 6: `summaries --force` then `report` paired the new summaries'
        # timings with receivers' answers to the old ones.
        keys = ["phi3.5", "qwen1.5"]
        for key in keys:
            self.summaries(key)
        for key in keys:
            self.receive(key, keys)
        spec = models.MAPPERS[("phi3.5", "qwen1.5")]
        stamp = self.read("receive", "qwen1.5")["summaryStamps"]["phi3.5"]
        run.save(run.path(self.out, "latent", "phi3.5__qwen1.5.json"),
                 {**fake_latent(self.groups), "itemsId": run.fingerprint(self.groups), "checkpoint": spec["id"],
                  "senderSummaries": True, "summaryStamp": stamp})
        receive, _, latent, notes = run.collect(self.out, self.groups, keys)
        self.assertEqual((sorted(receive), notes), (keys, {}))
        self.assertNotIn("skipped", latent[("phi3.5", "qwen1.5")])

        target = os.path.join(self.out, "summaries", "phi3.5.json")
        data = run.load(target)
        record = data["summaries"][self.groups["main"][0]["id"]]
        record["ms"] = record.get("ms", 0) + 1
        run.save(target, data)                                              # summaries --force
        receive, _, latent, notes = run.collect(self.out, self.groups, keys)
        self.assertEqual(receive, {})                                       # both read phi3.5's old summaries
        self.assertEqual(sorted(notes), keys)
        self.assertIn("receive --model qwen1.5", notes["qwen1.5"])
        self.assertIn("latent --pair phi3.5:qwen1.5", latent[("phi3.5", "qwen1.5")]["skipped"])
        self.assertEqual(run.load_notes(self.out), {})                      # named in the report, not saved

        for key in keys:
            self.receive(key, keys)                                         # run again: current
        receive, _, _, notes = run.collect(self.out, self.groups, keys)
        self.assertEqual((sorted(receive), notes), (keys, {}))

    def test_a_single_phase_command_does_not_bring_a_failed_model_back(self):
        # Codex review, round 7: `summaries --model X` answered from its cache, cleared X's
        # failure note, and the report counted X's older receive file again.
        keys = ["qwen1.5", "qwen3"]
        self.run_all(keys)
        run.note(self.out, "qwen3", "RuntimeError: the forced rerun failed")
        FakeEngine.loads.clear()
        run.run_one(self.out, "summaries", "qwen3", self.groups, keys,
                    summaries=lambda out, key, groups, force: run.phase_summaries(out, key, groups, force,
                                                                                  engine_factory=FakeEngine))
        self.assertEqual(FakeEngine.loads, ["qwen3"])                      # run again, not read from the cache
        self.assertIn("qwen3", run.load_notes(self.out))                    # and still noted
        receive, _, _, notes = run.collect(self.out, self.groups, keys)
        self.assertNotIn("qwen3", receive)
        run.run_one(self.out, "receive", "qwen3", self.groups, keys,
                    receive=lambda out, key, groups, senders, force: run.phase_receive(
                        out, key, groups, senders, force, engine_factory=FakeEngine))
        self.assertEqual(FakeEngine.loads, ["qwen3", "qwen3"])
        self.assertEqual(run.load_notes(self.out), {})
        run.run_one(self.out, "receive", "qwen1.5", self.groups, keys,     # qwen3's summaries are new
                    receive=lambda out, key, groups, senders, force: run.phase_receive(
                        out, key, groups, senders, force, engine_factory=FakeEngine))
        receive, _, _, notes = run.collect(self.out, self.groups, keys)
        self.assertEqual((sorted(receive), notes), (keys, {}))

    def test_a_failed_single_phase_is_noted_and_takes_its_mapper_pair_with_it(self):
        # Codex review, round 8: a failed `summaries --force` left no note, and a dropped model's
        # older mapper file could still pass the mapper check.
        keys = ["phi3.5", "qwen1.5"]
        self.run_all(keys)
        spec = models.MAPPERS[("phi3.5", "qwen1.5")]
        run.save(run.path(self.out, "latent", "phi3.5__qwen1.5.json"),
                 {**fake_latent(self.groups), "itemsId": run.fingerprint(self.groups), "checkpoint": spec["id"]})

        def broken(out, key, groups, force):
            raise OSError("the checkpoint did not load")

        with self.assertRaises(OSError):
            run.run_one(self.out, "summaries", "phi3.5", self.groups, keys, force=True, summaries=broken)
        self.assertIn("OSError", run.load_notes(self.out)["phi3.5"])
        receive, _, latent, notes = run.collect(self.out, self.groups, keys)
        self.assertEqual(sorted(receive), ["qwen1.5"])
        self.assertIn("phi3.5 has no current result", latent[("phi3.5", "qwen1.5")]["skipped"])
        summary = run.phase_report(self.out, keys)
        mapper = summary["checks"]["mapperHolds"]
        self.assertEqual((mapper["applicable"], mapper["passed"]), (True, False))

    def test_a_report_after_rewritten_summaries_still_expects_the_mapper_pair(self):
        # Codex review, round 8: with both receivers stale the mapper check must fail, not vanish.
        keys = ["phi3.5", "qwen1.5"]
        self.run_all(keys)
        target = os.path.join(self.out, "summaries", "phi3.5.json")
        data = run.load(target)
        record = data["summaries"][self.groups["main"][0]["id"]]
        record["ms"] = record.get("ms", 0) + 1
        run.save(target, data)
        summary = run.phase_report(self.out, keys)
        self.assertEqual(sorted(summary["dropped"]), keys)
        mapper = summary["checks"]["mapperHolds"]
        self.assertEqual((mapper["applicable"], mapper["passed"]), (True, False))
        self.assertFalse(summary["checks"]["coverage"]["passed"])

    def test_all_runs_a_model_again_after_its_last_attempt_failed(self):
        # Codex review, round 4: a failed forced rerun left the old receive file and a note; the
        # next `all` cleared the note after the cached summaries and reused the old file.
        keys = ["qwen1.5", "qwen3"]
        calls, summary = self.run_all(keys)
        self.assertEqual(sorted(summary["main"]["receivers"]), keys)
        self.assertFalse(any(force for _, _, force in calls))

        run.note(self.out, "qwen3", "RuntimeError: the forced rerun failed")
        calls, summary = self.run_all(keys, fail="qwen3")              # it fails again
        self.assertIn(("summaries", "qwen3", True), calls)
        self.assertIn(("receive", "qwen3", True), calls)
        self.assertIn(("receive", "qwen1.5", False), calls)
        self.assertEqual(sorted(summary["main"]["receivers"]), ["qwen1.5"])   # the old file does not stand in
        self.assertIn("qwen3", summary["dropped"])
        self.assertIn("qwen3", run.load_notes(self.out))

        calls, summary = self.run_all(keys)                            # and then succeeds
        self.assertIn(("receive", "qwen3", True), calls)
        self.assertEqual(sorted(summary["main"]["receivers"]), keys)
        self.assertEqual(run.load_notes(self.out), {})

    def test_a_receiver_holds_every_arm_for_every_item(self):
        for key in ("qwen1.5", "phi3.5"):
            self.summaries(key)
        self.receive("qwen1.5", ["qwen1.5", "phi3.5"])
        data = self.read("receive", "qwen1.5")
        self.assertEqual(data["itemsId"], run.fingerprint(self.groups))
        self.assertEqual(data["senders"], ["phi3.5", "qwen1.5"])
        main = self.groups["main"][7]
        record = data["results"][main["id"]]
        self.assertEqual(set(record), {"text", "self_cache", "closed", "t2t:qwen1.5", "t2t:phi3.5"})
        self.assertEqual(record["text"]["answer"], main["answers"][0])
        self.assertEqual((record["text"]["f1"], record["closed"]["f1"]), (1.0, 0.0))
        # Time end to end: preparing the prompt counts, and t2t adds the sender's summary time.
        self.assertEqual(record["text"]["ms"], 11.0)
        self.assertEqual((record["t2t:phi3.5"]["receiverMs"], record["t2t:phi3.5"]["ms"]), (11.0, 111.0))
        self.assertEqual(record["t2t:phi3.5"]["bytes"], len("phi3.5 says " + main["answers"][0]))
        self.assertEqual(record["text"]["bytes"], len(main["passage"].encode("utf-8")))
        edge = data["results"][self.groups["non_english_emoji"][0]["id"]]
        self.assertEqual(set(edge), {"text", "self_cache", "t2t:qwen1.5"})   # only its own summary
        self.assertEqual(set(data["results"][self.groups["no_system_role"][0]["id"]]), {"text", "self_cache"})
        self.assertEqual(len(data["results"]), sum(len(rows) for rows in self.groups.values()))

    def test_an_engine_is_closed_when_a_phase_fails(self):
        # Codex review, round 3: a failure after the model (or a vLLM server) was up left it running.
        closed = []

        class Breaking(FakeEngine):
            def summarize(self, passage, limit=None, max_new_tokens=96):
                raise KeyboardInterrupt()

            def prepare(self, *args, **kwargs):
                raise OSError("warm-up timed out")

            def close(self):
                closed.append(self.key)

        with self.assertRaises(KeyboardInterrupt):
            run.phase_summaries(self.out, "qwen3", self.groups, engine_factory=Breaking)
        with self.assertRaises(OSError):
            run.phase_receive(self.out, "qwen3", self.groups, ["qwen3"], engine_factory=Breaking)
        self.assertEqual(closed, ["qwen3", "qwen3"])
        self.assertFalse(os.path.exists(os.path.join(self.out, "receive", "qwen3.json")))

    def test_a_finished_phase_is_not_run_again(self):
        self.summaries("qwen1.5")
        self.receive("qwen1.5", ["qwen1.5"])
        FakeEngine.loads.clear()
        self.summaries("qwen1.5")
        self.receive("qwen1.5", ["qwen1.5"])
        self.assertEqual(FakeEngine.loads, [])

    def test_a_receiver_is_run_again_when_a_new_sender_has_summaries(self):
        # Codex review: an existing file kept a receiver from ever getting a later sender's arm.
        self.summaries("qwen1.5")
        self.receive("qwen1.5", ["qwen1.5", "phi3.5"])
        first = self.read("receive", "qwen1.5")
        self.assertNotIn("t2t:phi3.5", first["results"]["main-000"])
        self.summaries("phi3.5")
        self.receive("qwen1.5", ["qwen1.5", "phi3.5"])
        self.assertIn("t2t:phi3.5", self.read("receive", "qwen1.5")["results"]["main-000"])

    def test_files_from_another_item_set_are_refused_not_paired(self):
        # Codex review: items.json rebuilt with another seed kept ids such as main-000, and the
        # old answers were paired with the new questions.
        self.summaries("qwen1.5")
        self.receive("qwen1.5", ["qwen1.5"])
        other = item_sets.build(squad_rows(), lambda passage: True, seed=1)
        self.assertNotEqual(run.fingerprint(other), run.fingerprint(self.groups))
        with self.assertRaises(run.StaleFile):
            self.summaries("qwen1.5", other)
        with self.assertRaises(run.StaleFile):
            self.receive("phi3.5", ["qwen1.5"], other)       # its sender's summaries are stale
        run.save(run.path(self.out, "items.json"), other)
        with self.assertRaises(run.StaleFile):
            run.phase_report(self.out, ["qwen1.5"])
        run.phase_summaries(self.out, "qwen1.5", other, force=True, engine_factory=FakeEngine)
        self.receive("qwen1.5", ["qwen1.5"], other, force=True)
        self.assertEqual(self.read("receive", "qwen1.5")["itemsId"], run.fingerprint(other))

    def test_a_file_without_a_fingerprint_is_stale(self):
        run.save(run.path(self.out, "summaries", "qwen3.json"), {"model": {}, "summaries": {}})
        with self.assertRaises(run.StaleFile):
            self.summaries("qwen3")

    def test_a_failed_summary_becomes_a_failed_arm_not_a_missing_one(self):
        self.summaries("qwen1.5")
        data = self.read("summaries", "qwen1.5")
        data["summaries"]["main-003"] = {"error": "RuntimeError: boom"}
        run.save(os.path.join(self.out, "summaries", "qwen1.5.json"), data)
        self.receive("qwen1.5", ["qwen1.5"])
        record = self.read("receive", "qwen1.5")["results"]["main-003"]
        self.assertIn("The sender's summary failed", record["t2t:qwen1.5"]["error"])
        self.assertEqual(record["text"]["f1"], 1.0)

    def test_the_report_reads_the_phase_files_and_names_what_did_not_run(self):
        keys = ["qwen1.5", "qwen3", "phi3.5", "granite2", "mistral7"]
        for key in keys:
            self.summaries(key)
        for key in keys:
            self.receive(key, keys)
        run.note(self.out, "qwen7", "OSError: the checkpoint did not load")
        run.note(self.out, "phi3.5>qwen1.5", "The mapper checkpoint ~/m2b-scale/run1/best.pt is not on this machine.")
        report.ROUNDS["n"] = 200
        receive, summaries, latent, notes = run.collect(self.out, self.groups, keys + ["qwen7"])
        summary = report.build_summary(self.groups, receive, summaries, latent, rounds=200,
                                       dropped={"qwen7": notes["qwen7"]})
        self.assertEqual(list(summary["main"]["receivers"]), keys)
        self.assertEqual(summary["main"]["t2t"]["phi3.5"]["qwen3"]["f1"], 1.0)
        self.assertTrue(summary["checks"]["coverage"]["passed"])
        self.assertEqual(summary["checks"]["coverage"]["dropped"], ["qwen7"])
        self.assertTrue(summary["checks"]["handoffFaithful"]["passed"])
        self.assertFalse(summary["checks"]["mapperHolds"]["passed"])
        markdown = report.render_markdown(summary)
        self.assertIn("mapper not run", markdown)
        self.assertIn("`qwen7` (dropped in this run)", markdown)
        self.assertIn("Llama-3.2-3B", markdown)
        run.note(self.out, "qwen7", None)
        self.assertNotIn("qwen7", run.load_notes(self.out))

    def test_all_goes_on_when_one_model_fails_to_load(self):
        def failing(key):
            if key == "qwen3":
                raise OSError("the checkpoint did not load")
            return FakeEngine(key)

        self.assertFalse(run.attempt(self.out, "qwen3", lambda: run.phase_summaries(self.out, "qwen3", self.groups,
                                                                                    engine_factory=failing)))
        self.assertTrue(run.attempt(self.out, "phi3.5", lambda: run.phase_summaries(self.out, "phi3.5", self.groups,
                                                                                    engine_factory=failing)))
        self.assertEqual(run.load_notes(self.out), {"qwen3": "OSError: the checkpoint did not load"})
        with self.assertRaises(run.StaleFile):
            run.attempt(self.out, "x", lambda: run.existing(self.write_stale(), "new"))

    def write_stale(self):
        target = run.path(self.out, "summaries", "stale.json")
        run.save(target, {"itemsId": "old"})
        return target


class WordTokenizer:
    """A tokenizer double: one token per character, with offsets and a ChatML-like template."""

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):
        text = "".join(f"<{m['role']}>{m['content']}</{m['role']}>" for m in messages)
        return text + ("<assistant>" if add_generation_prompt else "")

    def __call__(self, text, add_special_tokens=False, return_offsets_mapping=False):
        encoded = {"input_ids": [ord(ch) for ch in text]}
        if return_offsets_mapping:
            encoded["offset_mapping"] = [(i, i + 1) for i in range(len(text))]
        return encoded


class FakeVllm(http.server.BaseHTTPRequestHandler):
    """Answers /v1/completions with the digits of the prompt, and records each request."""

    requests = []

    def do_GET(self):
        self.do_POST()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length)) if length else {}
        FakeVllm.requests.append((self.path, body))
        prompt = "".join(chr(token) for token in body.get("prompt", []))
        if self.path.endswith("/models"):
            reply = json.dumps({"data": [{"id": "some/other-model"}]}).encode()
        else:
            reply = json.dumps({"choices": [{"text": " " + "".join(ch for ch in prompt if ch.isdigit()) + " \u00e9",
                                             "finish_reason": "stop"}],
                                "usage": {"completion_tokens": 4}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

    def log_message(self, *args):
        pass


class VllmEngineTest(unittest.TestCase):
    """The vLLM backend: same prompt ids as the torch engine, no cache hand-over."""

    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeVllm)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        config = {"num_hidden_layers": 28, "num_attention_heads": 28, "num_key_value_heads": 4, "hidden_size": 3584,
                  "max_position_embeddings": 32768}
        cls.engine = vllm_engine.VllmEngine("qwen7", tokenizer=WordTokenizer(), config=config,
                                            base_url=f"http://127.0.0.1:{cls.server.server_address[1]}/v1")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        FakeVllm.requests.clear()

    def test_the_prompt_goes_out_as_the_prepared_token_ids(self):
        prepared = self.engine.prepare("The code is 412.", "What is the code?")
        result = self.engine.timed(prepared["ids"])
        path, body = FakeVllm.requests[0]
        self.assertEqual(path, "/v1/completions")
        self.assertEqual(body["prompt"], prepared["ids"])
        self.assertEqual((body["temperature"], body["max_tokens"], body["add_special_tokens"]), (0, 24, False))
        self.assertEqual(body["repetition_penalty"], 1.0)     # the checkpoint's 1.05 must not apply
        self.assertEqual(body["model"], "Qwen/Qwen2.5-7B-Instruct-AWQ")
        # The reply's count includes the end-of-turn token; the torch engine's does not.
        self.assertEqual((result["answer"], result["newTokens"]), ("412 \u00e9", 3))
        self.assertGreater(result["ms"], 0)

    def test_the_prefix_ends_with_the_passage_and_the_rest_is_the_question(self):
        # Codex review: a tokenizer round trip that checks the exact prefix and suffix ids.
        passage = "The code is 412."
        prepared = self.engine.prepare(passage, "What is the code?", system=prompts.SYSTEM_TEXT)
        text = "".join(chr(token) for token in prepared["ids"])
        prefix, suffix = text[:prepared["prefixTokens"]], text[prepared["prefixTokens"]:]
        self.assertTrue(prefix.endswith("Read this passage.\n\n" + passage))
        self.assertTrue(suffix.startswith("\n\nQuestion: What is the code?"))
        self.assertTrue(suffix.endswith("<assistant>"))
        self.assertIn(prompts.SYSTEM_TEXT, prefix)
        self.assertEqual((prepared["promptTokens"], prepared["passageTokens"], prepared["truncated"]),
                         (len(text), len(passage), False))
        self.assertEqual(prepared["passageBytes"], len(passage))

    def test_a_long_passage_is_cut_at_the_head_and_the_record_says_so(self):
        passage = "A" * 500 + " the code is 77. " + "B" * 4000
        prepared = self.engine.prepare(passage, "What is the code?", limit=2048)
        text = "".join(chr(token) for token in prepared["ids"])
        self.assertTrue(prepared["truncated"])
        self.assertEqual(prepared["passageTokens"], len(passage))
        self.assertLessEqual(prepared["promptTokens"] + prompting.ANSWER_TOKENS, 2048)
        self.assertGreater(prepared["promptTokens"], 1900)            # the context is used, not wasted
        self.assertEqual(text.count("B"), prepared["keptTokens"] - 517)
        self.assertIn("the code is 77.", text)
        self.assertIn("Question: What is the code?", text)             # the question is never cut
        with self.assertRaises(ValueError):
            self.engine.prepare("x", "Q" * 3000, limit=2048)

    def test_an_empty_passage_still_has_a_prefix_and_a_question(self):
        prepared = self.engine.prepare("", "Which city?", abstain=True)
        text = "".join(chr(token) for token in prepared["ids"])
        self.assertEqual((prepared["passageTokens"], prepared["passageBytes"]), (0, 0))
        self.assertTrue(text[:prepared["prefixTokens"]].endswith("Read this passage.\n\n"))
        self.assertIn(prompts.ABSTAIN_REPLY, text[prepared["prefixTokens"]:])

    def test_a_summary_is_timed_and_measured_in_utf8_bytes(self):
        record = self.engine.summarize("Boxes: 412 \u00e9.")
        self.assertEqual((record["summary"], record["bytes"], record["truncated"]), ("40412 \u00e9", 8, False))
        self.assertEqual(FakeVllm.requests[0][1]["max_tokens"], 96)

    def test_the_cache_arm_is_a_named_refusal_not_an_error(self):
        self.assertFalse(self.engine.hands_over_cache)
        with self.assertRaises(NotImplementedError):
            self.engine.answer_from_cache({})
        description = self.engine.describe()
        self.assertEqual((description["backend"], description["kvHeads"], description["headDim"]), ("vllm", 4, 128))
        command = vllm_engine.serve_command("/venv/bin/vllm", "some/model")
        self.assertIn("127.0.0.1", command)
        self.assertNotIn("--kv-cache-dtype", command)      # FP8 KV breaks the AWQ checkpoints here
        self.assertIn("--disable-prefix-caching", command)

    def test_token_counts_leave_out_the_end_of_turn_token_only_when_there_was_one(self):
        def reply(reason, count):
            return {"choices": [{"text": "x", "finish_reason": reason}], "usage": {"completion_tokens": count}}
        self.assertEqual(vllm_engine.new_tokens(reply("stop", 1)), 0)      # an empty answer
        self.assertEqual(vllm_engine.new_tokens(reply("stop", 5)), 4)
        self.assertEqual(vllm_engine.new_tokens(reply("length", 24)), 24)

    def test_a_server_already_on_the_port_is_never_taken_for_ours(self):
        # Codex review, round 3: readiness accepted any server that answered /v1/models.
        base = self.engine.base_url
        self.assertEqual(vllm_engine.served_models(base), ["some/other-model"])
        self.assertIsNone(vllm_engine.served_models("http://127.0.0.1:9/v1", timeout=1))
        port, vllm_engine.PORT = vllm_engine.PORT, self.server.server_address[1]
        try:
            with self.assertRaises(RuntimeError) as raised:
                vllm_engine.VllmEngine("qwen7", tokenizer=WordTokenizer(), config=self.engine_config())
            self.assertIn("already served", str(raised.exception))
        finally:
            vllm_engine.PORT = port

    def engine_config(self):
        return {"num_hidden_layers": 28, "num_attention_heads": 28, "num_key_value_heads": 4, "hidden_size": 3584}

    def test_closing_reaps_a_server_whose_leader_already_exited(self):
        class Gone:
            pid, waited = 2 ** 22 + 12345, 0

            def wait(self, timeout=None):
                Gone.waited += 1

        engine = vllm_engine.VllmEngine("qwen7", tokenizer=WordTokenizer(), config=self.engine_config(),
                                        base_url=self.engine.base_url)
        engine.process = Gone()
        engine.close()                     # no ProcessLookupError, and the child is waited for
        self.assertEqual((engine.process, Gone.waited), (None, 2))
        engine.close()                     # closing twice is harmless

    def signals_of(self, process):
        """Close an engine holding `process`; the signals sent to it or to its group, in order."""
        sent = []
        process.send_signal = sent.append
        engine = vllm_engine.VllmEngine("qwen7", tokenizer=WordTokenizer(), config=self.engine_config(),
                                        base_url=self.engine.base_url)
        engine.process = process
        if hasattr(os, "killpg"):
            with mock.patch.object(os, "killpg", side_effect=lambda pid, sign: sent.append(sign)):
                engine.close()
        else:
            engine.close()
        return sent

    def test_closing_kills_the_group_even_when_the_leader_exits_at_once(self):
        # Codex review, round 4: the leader's exit ended the loop, so a worker of its group
        # that ignored SIGTERM kept the GPU and was never sent SIGKILL.
        class Leader:
            pid = 2 ** 22 + 54321

            def wait(self, timeout=None):
                return 0

        sent = self.signals_of(Leader())
        self.assertEqual(sent, [vllm_engine.signal.SIGTERM,
                                getattr(vllm_engine.signal, "SIGKILL", vllm_engine.signal.SIGTERM)])

    def test_a_server_with_the_same_checkpoint_from_another_run_is_not_ours(self):
        # Codex review, round 4: two runs start together, both see a free port, one server
        # binds; the other run found its checkpoint's id listed and scored that server's replies.
        class Child:
            pid = 2 ** 22 + 777

            def poll(self):
                return None                # still loading: it never bound the port

            def wait(self, timeout=None):
                return 0

            def send_signal(self, sign):
                pass

        checkpoint = models.MODELS["qwen7"]["id"]
        answers = iter([None, [checkpoint]])     # the port is free, then another run's server answers
        commands = []

        def popen(command, **options):
            commands.append(command)
            return Child()

        with tempfile.TemporaryDirectory() as home, \
                mock.patch.dict(os.environ, {"HOME": home, "USERPROFILE": home}), \
                mock.patch.object(vllm_engine, "served_models", side_effect=lambda base, timeout=5: next(answers)), \
                mock.patch.object(vllm_engine.subprocess, "Popen", side_effect=popen), \
                mock.patch.object(vllm_engine.os, "killpg", create=True):
            with self.assertRaises(RuntimeError) as raised:
                vllm_engine.VllmEngine("qwen7", tokenizer=WordTokenizer(), config=self.engine_config())
        self.assertIn("not ours", str(raised.exception))
        name = commands[0][commands[0].index("--served-model-name") + 1]
        self.assertTrue(name.startswith("l2-qwen7-") and name != checkpoint)
        other = vllm_engine.serve_command("vllm", checkpoint, served="l2-qwen7-" + "0" * 16)
        self.assertNotEqual(name, other[-1])                          # a new name every run

    def test_an_attached_server_is_asked_for_the_checkpoint_and_a_started_one_for_its_run_name(self):
        self.assertEqual(self.engine.served, models.MODELS["qwen7"]["id"])
        self.assertNotIn("--served-model-name", vllm_engine.serve_command("vllm", "some/model"))

    def test_the_log_is_closed_after_the_signals_not_before(self):
        # Codex review, round 7: an interruption while the log was being closed, before any
        # signal had gone out, left the server running.
        order = []

        class Log:
            def close(self):
                order.append("log closed")

        class Leader:
            pid = 2 ** 22 + 4242

            def wait(self, timeout=None):
                return 0

        process = Leader()
        process.send_signal = lambda sign: order.append("signal")
        engine = vllm_engine.VllmEngine("qwen7", tokenizer=WordTokenizer(), config=self.engine_config(),
                                        base_url=self.engine.base_url)
        engine.process, engine.log = process, Log()
        if hasattr(os, "killpg"):
            with mock.patch.object(os, "killpg", side_effect=lambda pid, sign: order.append("signal")):
                engine.close()
        else:
            engine.close()
        self.assertEqual(order, ["signal", "signal", "log closed"])

    def test_an_interrupted_close_still_kills_the_group(self):
        # Codex review, round 6: SIGTERM landing while close() waited raised out of the wait,
        # and the group was never sent SIGKILL.
        class Slow:
            pid = 2 ** 22 + 999

            def wait(self, timeout=None):
                raise SystemExit(143)

        process, sent = Slow(), []
        process.send_signal = sent.append
        engine = vllm_engine.VllmEngine("qwen7", tokenizer=WordTokenizer(), config=self.engine_config(),
                                        base_url=self.engine.base_url)
        engine.process = process
        with self.assertRaises(SystemExit):
            if hasattr(os, "killpg"):
                with mock.patch.object(os, "killpg", side_effect=lambda pid, sign: sent.append(sign)):
                    engine.close()
            else:
                engine.close()
        self.assertEqual(sent, [vllm_engine.signal.SIGTERM,
                                getattr(vllm_engine.signal, "SIGKILL", vllm_engine.signal.SIGTERM)])

    def test_a_vllm_receiver_records_the_refusal_and_stays_complete(self):
        groups = item_sets.build(squad_rows(), lambda passage: True)
        keys = ["qwen1.5", "qwen3", "phi3.5", "granite2", "qwen7"]
        with tempfile.TemporaryDirectory() as out:
            run.save(run.path(out, "items.json"), groups)

            def factory(key):
                engine = FakeEngine(key)
                engine.hands_over_cache = key != "qwen7"
                return engine

            for key in keys:
                run.phase_summaries(out, key, groups, engine_factory=factory)
            for key in keys:
                run.phase_receive(out, key, groups, keys, engine_factory=factory)
            record = run.load(os.path.join(out, "receive", "qwen7.json"))["results"]["main-000"]
            self.assertEqual(record["self_cache"], {"refused": vllm_engine.CACHE_REFUSAL})
            receive, summaries, latent, _ = run.collect(out, groups, keys)
            summary = report.build_summary(groups, receive, summaries, latent, rounds=200)
        cache = summary["main"]["receivers"]["qwen7"]["self_cache"]
        self.assertEqual((cache["n"], cache["errors"], cache["refused"], cache["missing"]), (0, 0, 200, 0))
        self.assertNotIn("qwen7", summary["checks"]["handoffFaithful"]["models"])
        self.assertTrue(summary["checks"]["handoffFaithful"]["passed"])
        self.assertEqual(summary["checks"]["coverage"]["complete"], 5)
        edge = summary["checks"]["edgeCases"]
        self.assertEqual((set(edge["errors"].values()), set(edge["missing"].values())), ({0}, {0}))
        # The mapper pair was not run in this folder, so its records are what the edge check lacks.
        self.assertEqual(edge["latent"], {"phi3.5>qwen1.5": 200})
        self.assertEqual(summary["latentTable"]["qwen7"]["qwen7"], {"status": "self_refused"})
        markdown = report.render_markdown(summary)
        self.assertEqual(markdown.count("not possible through vLLM"), 2)   # its main row and its diagonal cell


class LatentResumeTest(unittest.TestCase):
    """Codex review, round 2: a saved mapper result and a failed reload."""

    spec = models.MAPPERS[("phi3.5", "qwen1.5")]

    def test_what_the_mapper_path_keeps_is_the_earlier_of_the_two_ends(self):
        document = "abcdefghij" * 10
        sender = [(i, i + 1) for i in range(100)]          # 100 one-character tokens
        receiver = [(i, i + 2) for i in range(0, 100, 2)]  # 50 two-character tokens
        self.assertEqual(run.mapper_cut(document, sender, receiver, cap=384),
                         {"docTokens": 50, "truncated": False, "keptBytes": 100})
        # The sender reaches the cap first: the receiver's text is cut back to the sender's end.
        self.assertEqual(run.mapper_cut(document, sender, receiver, cap=30),
                         {"docTokens": 50, "truncated": True, "keptBytes": 30})
        self.assertEqual(run.mapper_cut(document, sender, receiver, cap=60),
                         {"docTokens": 50, "truncated": True, "keptBytes": 60})
        self.assertEqual(run.mapper_cut("", [], [])["keptBytes"], 0)
        # Codex review, round 3: the sender ends at character 3, the receiver's tokens end at 2
        # and 4. The receiver keeps through character 2 only, and bytes are UTF-8 bytes.
        self.assertEqual(run.mapper_cut("\u00e9bcd", [(0, 3)], [(0, 2), (2, 4)], cap=1)["keptBytes"], 3)
        self.assertEqual(run.mapper_cut("abcd", [(0, 1)], [(0, 2), (2, 4)], cap=5)["keptBytes"], 0)

    def test_a_saved_result_is_reused_only_for_the_registered_checkpoint(self):
        good = {"checkpoint": self.spec["id"], "senderSummaries": True}
        self.assertTrue(run.latent_current(good, self.spec, True))
        self.assertFalse(run.latent_current({**good, "checkpoint": "0000"}, self.spec, True))

    def test_a_result_made_before_the_summaries_existed_is_run_again(self):
        early = {"checkpoint": self.spec["id"], "senderSummaries": False}
        self.assertFalse(run.latent_current(early, self.spec, True))
        self.assertTrue(run.latent_current(early, self.spec, False))     # still none: nothing to add

    def test_the_report_prefers_a_recorded_failure_to_an_older_file(self):
        groups = item_sets.build(squad_rows(), lambda passage: True)
        keys = ["qwen1.5", "phi3.5"]
        with tempfile.TemporaryDirectory() as out:
            run.save(run.path(out, "items.json"), groups)
            for key in keys:
                run.phase_summaries(out, key, groups, engine_factory=FakeEngine)
                run.phase_receive(out, key, groups, keys, engine_factory=FakeEngine)
            saved = {**fake_latent(groups), "itemsId": run.fingerprint(groups), "checkpoint": self.spec["id"]}
            run.save(run.path(out, "latent", "phi3.5__qwen1.5.json"), saved)
            receive, _, latent, _ = run.collect(out, groups, keys)
            self.assertEqual((sorted(receive), "skipped" in latent[("phi3.5", "qwen1.5")]), (sorted(keys), False))
            # A later forced run fails to load phi3.5 and refuses the mapper checkpoint.
            run.note(out, "phi3.5", "OSError: the checkpoint did not load")
            run.note(out, "phi3.5>qwen1.5", "The checkpoint is 0000, not the registered one.")
            receive, summaries, latent, _ = run.collect(out, groups, keys)
            self.assertEqual((sorted(receive), sorted(summaries)), (["qwen1.5"], ["qwen1.5"]))
            self.assertEqual(latent[("phi3.5", "qwen1.5")], {"skipped": "The checkpoint is 0000, not the registered one."})
            report.ROUNDS["n"] = 200
            summary = run.phase_report(out, keys)
            self.assertEqual(summary["dropped"], {"phi3.5": "OSError: the checkpoint did not load"})
            # A saved result from another checkpoint is not shown as the registered mapper's.
            run.note(out, "phi3.5>qwen1.5", None)
            run.save(run.path(out, "latent", "phi3.5__qwen1.5.json"), {**saved, "checkpoint": "0000"})
            self.assertIn("0000", run.collect(out, groups, keys)[2][("phi3.5", "qwen1.5")]["skipped"])
            # Round 3: a recorded failure wins even when the older file is from another item set.
            run.note(out, "phi3.5>qwen1.5", "The mapper checkpoint is not on this machine.")
            run.save(run.path(out, "latent", "phi3.5__qwen1.5.json"), {**saved, "itemsId": "another"})
            self.assertEqual(run.collect(out, groups, keys)[2][("phi3.5", "qwen1.5")],
                             {"skipped": "The mapper checkpoint is not on this machine."})


class CheckTest(unittest.TestCase):
    """Codex review: the four checks passed or failed on the wrong evidence."""

    @classmethod
    def setUpClass(cls):
        cls.groups = item_sets.build(squad_rows(), lambda passage: True)
        cls.keys = ["qwen1.5", "qwen3", "phi3.5", "granite2", "mistral7"]
        cls.summaries = {}

    def build(self, receive=None, latent=None):
        receive = receive or {key: fake_receive(self.groups, key, self.keys) for key in self.keys}
        latent = {("phi3.5", "qwen1.5"): fake_latent(self.groups)} if latent is None else latent
        return report.build_summary(self.groups, receive, self.summaries, latent, rounds=200)

    def test_one_matching_item_out_of_two_hundred_is_not_a_faithful_hand_off(self):
        receive = {key: fake_receive(self.groups, key, self.keys) for key in self.keys}
        for item in self.groups["main"][1:]:
            del receive["qwen3"]["results"][item["id"]]["self_cache"]
        checks = self.build(receive)["checks"]
        self.assertFalse(checks["handoffFaithful"]["models"]["qwen3"])
        self.assertFalse(checks["handoffFaithful"]["passed"])

    def test_a_model_with_a_missing_sender_arm_is_not_complete(self):
        receive = {key: fake_receive(self.groups, key, self.keys) for key in self.keys}
        for record in receive["mistral7"]["results"].values():
            record.pop("t2t:phi3.5", None)
        checks = self.build(receive)["checks"]
        self.assertEqual((checks["coverage"]["complete"], checks["coverage"]["passed"]), (4, False))
        self.assertEqual(checks["edgeCases"]["missing"]["mistral7"], 200)
        self.assertFalse(checks["edgeCases"]["passed"])

    def test_an_edge_item_with_no_record_fails_the_edge_check(self):
        receive = {key: fake_receive(self.groups, key, self.keys) for key in self.keys}
        del receive["granite2"]["results"][self.groups["tiny_passage"][8]["id"]]
        summary = self.build(receive)
        self.assertEqual(summary["edge"]["granite2"]["tiny_passage"]["missing"], 3)
        self.assertFalse(summary["checks"]["edgeCases"]["passed"])
        self.assertFalse(summary["checks"]["coverage"]["passed"])

    def test_a_failed_latent_edge_item_fails_the_edge_check(self):
        latent = fake_latent(self.groups)
        latent["results"][self.groups["long_passage"][0]["id"]]["swat"] = {"error": "ValueError: no tokens"}
        checks = self.build(latent={("phi3.5", "qwen1.5"): latent})["checks"]
        self.assertEqual(checks["edgeCases"]["latent"], {"phi3.5>qwen1.5": 1})
        self.assertFalse(checks["edgeCases"]["passed"])

    def test_a_refusal_outside_the_vllm_cache_arm_is_missing_work(self):
        # Codex review, round 3: any refused record was excused, whatever the arm or the backend.
        receive = {key: fake_receive(self.groups, key, self.keys) for key in self.keys}
        for record in receive["qwen3"]["results"].values():          # a torch model
            record["self_cache"] = {"refused": "unexpected"}
        checks = self.build(receive)["checks"]
        self.assertFalse(checks["handoffFaithful"]["models"]["qwen3"])
        self.assertEqual(checks["coverage"]["complete"], 4)
        self.assertGreaterEqual(checks["edgeCases"]["errors"]["qwen3"] + checks["edgeCases"]["missing"]["qwen3"], 200)
        self.assertFalse(checks["edgeCases"]["passed"])

    def served_run(self):
        keys = self.keys + ["qwen7"]
        receive = {key: fake_receive(self.groups, key, keys) for key in keys}
        for record in receive["qwen7"]["results"].values():
            record["self_cache"] = {"refused": vllm_engine.CACHE_REFUSAL}
        return receive

    def test_only_the_named_cache_refusal_of_a_vllm_model_is_excused(self):
        # Codex review, round 4: every refusal of a vLLM receiver was excused in the edge groups,
        # and any reason was accepted in its cache arm.
        checks = self.build(self.served_run())["checks"]
        self.assertEqual((checks["coverage"]["complete"], checks["edgeCases"]["passed"]), (6, True))

        receive = self.served_run()
        receive["qwen7"]["results"][self.groups["long_passage"][0]["id"]]["text"] = {"refused": "unexpected"}
        summary = self.build(receive)
        self.assertEqual(summary["edge"]["qwen7"]["long_passage"]["errors"], 1)
        self.assertEqual(summary["checks"]["coverage"]["complete"], 5)
        self.assertFalse(summary["checks"]["edgeCases"]["passed"])

        receive = self.served_run()
        receive["qwen7"]["results"]["main-003"]["self_cache"] = {"refused": "out of memory"}
        summary = self.build(receive)
        cache = summary["main"]["receivers"]["qwen7"]["self_cache"]
        self.assertEqual((cache["refused"], cache["errors"]), (199, 1))
        self.assertEqual(summary["checks"]["coverage"]["complete"], 5)
        self.assertFalse(summary["checks"]["edgeCases"]["passed"])

    def test_a_model_with_a_failed_arm_is_not_complete(self):
        # Codex review, round 2: five receivers with one failed `closed` arm still passed coverage.
        receive = {key: fake_receive(self.groups, key, self.keys) for key in self.keys}
        receive["qwen3"]["results"]["main-004"]["closed"] = {"error": "RuntimeError: boom"}
        checks = self.build(receive)["checks"]
        self.assertEqual((checks["coverage"]["complete"], checks["coverage"]["passed"]), (4, False))

    def test_a_missing_mapper_main_record_fails_the_edge_check(self):
        # Codex review, round 2: only errors were summed for the mapper's main arms.
        for arm in ("text_m2b", "t2t_m2b"):
            latent = fake_latent(self.groups)
            del latent["results"]["main-009"][arm]
            checks = self.build(latent={("phi3.5", "qwen1.5"): latent})["checks"]
            self.assertEqual(checks["edgeCases"]["latent"], {"phi3.5>qwen1.5": 1}, arm)
            self.assertFalse(checks["edgeCases"]["passed"])

    def test_a_mapper_pair_that_was_asked_for_and_has_no_result_fails_both_checks(self):
        # Codex review, round 7: with phi3.5 dropped the mapper check read "Not applicable", and
        # a pair whose saved result was skipped left the edge check passing with no records.
        keys = [key for key in self.keys if key != "phi3.5"]
        receive = {key: fake_receive(self.groups, key, keys) for key in keys}
        summary = report.build_summary(self.groups, receive, self.summaries, {}, rounds=200,
                                       dropped={"phi3.5": "OSError: the checkpoint did not load"})
        mapper = summary["checks"]["mapperHolds"]
        self.assertEqual((mapper["applicable"], mapper["passed"]), (True, False))
        self.assertIn("| mapperHolds | Fail |", report.render_markdown(summary))

        skipped = self.build(latent={("phi3.5", "qwen1.5"): {"skipped": "Its summary arm read older summaries."}})
        self.assertEqual(skipped["checks"]["edgeCases"]["latent"], {"phi3.5>qwen1.5": len(self.groups["main"])})
        self.assertFalse(skipped["checks"]["edgeCases"]["passed"])
        self.assertFalse(skipped["checks"]["mapperHolds"]["passed"])
        self.assertTrue(self.build()["checks"]["edgeCases"]["passed"])

    def test_the_mapper_check_needs_every_main_item(self):
        latent = fake_latent(self.groups)
        for item in self.groups["main"][20:]:
            del latent["results"][item["id"]]["mismatched"]
        summary = self.build(latent={("phi3.5", "qwen1.5"): latent})
        self.assertGreater(summary["latent"]["phi3.5>qwen1.5"]["intervals"]["swat-mismatched"]["f1"]["low"], 0)
        self.assertFalse(summary["checks"]["mapperHolds"]["passed"])

    def test_the_mapper_check_is_the_three_comparisons_of_the_definition(self):
        # The harness-format summary arm is reported beside them and is not a fourth condition.
        receive = {key: fake_receive(self.groups, key, self.keys, wrong_every=10 ** 6) for key in self.keys}
        summary = self.build(receive)
        self.assertEqual(summary["latent"]["phi3.5>qwen1.5"]["intervals"]["swat-harness_t2t"]["f1"]["low"], 0.0)
        self.assertTrue(summary["checks"]["mapperHolds"]["passed"])

    def test_a_mapper_cell_where_every_item_failed_is_not_shown_as_measured(self):
        latent = fake_latent(self.groups)
        for record in latent["results"].values():
            record["swat"] = {"error": "RuntimeError: boom"}
        summary = self.build(latent={("phi3.5", "qwen1.5"): latent})
        self.assertEqual(summary["latentTable"]["phi3.5"]["qwen1.5"], {"status": "mapper_failed"})
        self.assertIn("mapper ran, every item failed", report.render_markdown(summary))
        self.assertFalse(summary["checks"]["mapperHolds"]["passed"])

    def test_the_mapper_table_shows_the_reference_and_what_was_cut(self):
        latent = fake_latent(self.groups)
        for item in self.groups["main"][:3] + self.groups["long_passage"]:
            latent["results"][item["id"]]["swat"]["truncated"] = True
        summary = self.build(latent={("phi3.5", "qwen1.5"): latent})
        pair = summary["latent"]["phi3.5>qwen1.5"]
        self.assertEqual((pair["clippedMain"], pair["edge"]["long_passage"]["clipped"]), (3, 20))
        self.assertEqual(pair["arms"]["zeroed"]["mappedBytes"], 4014080)
        markdown = report.render_markdown(summary)
        self.assertIn("M2b-S measured `swat` F1 0.872 on 300 items", markdown)
        self.assertIn("3 of 200 main items were cut", markdown)


if __name__ == "__main__":
    unittest.main()
