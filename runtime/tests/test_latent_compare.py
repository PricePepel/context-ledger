"""L2: the cross-model harness's pure parts (prompts, items, scoring, registry, report).

Standard library only, plus jinja2 for the checks that render real chat templates (they skip
without it). Nothing here loads a model: the torch engine is exercised by the GPU run.
"""
import glob
import os
import unicodedata
import unittest

try:
    import jinja2  # noqa: F401
    HAVE_JINJA = True
except ImportError:
    HAVE_JINJA = False

from latent_compare import items as item_sets
from latent_compare import models, prompts, report, run, stats

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
        cls.keys = ["qwen1.5", "qwen3", "phi3.5", "llama8", "mistral7"]
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

    def test_running_out_of_gpu_memory_stops_the_run(self):
        def oom():
            raise RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")
        with self.assertRaises(RuntimeError):
            run.guarded({}, "text", oom)

    def test_only_the_long_group_runs_at_the_small_context(self):
        self.assertEqual(run.limit_for({"group": "long_passage"}), run.LONG_CONTEXT)
        self.assertIsNone(run.limit_for({"group": "main"}))


if __name__ == "__main__":
    unittest.main()
