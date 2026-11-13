"""C12 / M2c: the latent team's turns come from each model's own chat template.

These tests need only jinja2: no torch, no transformers, no GPU, no network. The templates
are in chat_template_fixtures.py. The last class also checks real tokenizers, but only those
already in the local Hugging Face cache, and skips otherwise.
"""
import glob
import os
import unittest
from datetime import datetime

try:
    import jinja2  # noqa: F401
    HAVE_JINJA = True
except ImportError:
    HAVE_JINJA = False

from latent_team.chat_turns import CHATML, ChatTemplateError, chat_turns, derive_turns, first_turn, stop_ids

QWEN, SMOLLM, PHI = "Qwen/Qwen2.5-3B-Instruct", "HuggingFaceTB/SmolLM2-1.7B-Instruct", "microsoft/Phi-3.5-mini-instruct"
LLAMA, MISTRAL = "meta-llama/Llama-3.1-8B-Instruct", "mistralai/Mistral-7B-Instruct-v0.3"
GRANITE, OLMO = "ibm-granite/granite-3.1-8b-instruct", "allenai/OLMo-2-1124-7B-Instruct"

CHATML_LATER = ("<|im_end|>\n", "<|im_start|>user\n", "<|im_end|>\n<|im_start|>assistant\n")


def granite_first(prompt):
    date = datetime.now().strftime("%B %d, %Y")
    return ("<|start_of_role|>system<|end_of_role|>Knowledge Cutoff Date: April 2024.\nToday's Date: " + date +
            ".\nYou are Granite, developed by IBM. You are a helpful AI assistant.<|end_of_text|>\n"
            "<|start_of_role|>user<|end_of_role|>" + prompt +
            "<|end_of_text|>\n<|start_of_role|>assistant<|end_of_role|>")


# name: (first turn for "PLAN", (close, later prefix, later suffix))
EXPECTED = {
    QWEN: ("<|im_start|>system\nYou are Qwen, created by Alibaba Cloud. You are a helpful assistant.<|im_end|>\n"
           "<|im_start|>user\nPLAN<|im_end|>\n<|im_start|>assistant\n", CHATML_LATER),
    SMOLLM: ("<|im_start|>system\nYou are a helpful AI assistant named SmolLM, trained by Hugging Face<|im_end|>\n"
             "<|im_start|>user\nPLAN<|im_end|>\n<|im_start|>assistant\n", CHATML_LATER),
    PHI: ("<|user|>\nPLAN<|end|>\n<|assistant|>\n",
          # The ended conversation is "...<|end|>\n<|endoftext|>" and the next turn opens with
          # "<|user|>": the common prefix "<|end|>\n<|" is cut back to the whole token.
          ("<|end|>\n", "<|user|>\n", "<|end|>\n<|assistant|>\n")),
    LLAMA: ("<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\nCutting Knowledge Date: December 2023\n"
            "Today Date: 26 Jul 2024\n\n<|eot_id|><|start_header_id|>user<|end_header_id|>\n\nPLAN<|eot_id|>"
            "<|start_header_id|>assistant<|end_header_id|>\n\n",
            ("<|eot_id|>", "<|start_header_id|>user<|end_header_id|>\n\n",
             "<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n")),
    MISTRAL: ("<s>[INST] PLAN[/INST]", ("</s>", "[INST] ", "[/INST]")),
    GRANITE: (None, ("<|end_of_text|>\n", "<|start_of_role|>user<|end_of_role|>",
                     "<|end_of_text|>\n<|start_of_role|>assistant<|end_of_role|>")),
    OLMO: ("<|endoftext|><|user|>\nPLAN\n<|assistant|>\n", ("<|endoftext|>", "\n<|user|>\n", "\n<|assistant|>\n")),
}
# What the template writes before an assistant's content (Mistral: " " + content|trim).
LEAD = {MISTRAL: " "}
# Text that marks a system block, per family that injects one by default.
DEFAULT_SYSTEM = {QWEN: "You are Qwen", SMOLLM: "named SmolLM", LLAMA: "Cutting Knowledge Date",
                  GRANITE: "Knowledge Cutoff Date"}
# The bos token, per family whose template writes one (OLMo-2's is also its eos).
BOS = {LLAMA: "<|begin_of_text|>", MISTRAL: "<s>"}


def tokenizer(name):
    from tests.chat_template_fixtures import TemplateTokenizer
    return TemplateTokenizer(name)


@unittest.skipUnless(HAVE_JINJA, "jinja2 is needed to render chat templates")
class DerivedTurnsTest(unittest.TestCase):
    def test_each_family_gets_its_first_turn_later_turn_and_close(self):
        for name, (first, (close, prefix, suffix)) in EXPECTED.items():
            with self.subTest(name):
                tok = tokenizer(name)
                turns = derive_turns(tok, name)
                self.assertEqual(first_turn(tok, "PLAN"), first or granite_first("PLAN"))
                self.assertEqual(turns.close, close)
                self.assertEqual(turns.later("SOLVE"), prefix + "SOLVE" + suffix)

    def test_later_turns_carry_no_bos_and_no_system_block(self):
        for name in EXPECTED:
            with self.subTest(name):
                tok = tokenizer(name)
                later = derive_turns(tok, name).later("SOLVE")
                self.assertNotIn("system", later)
                if name in BOS:
                    self.assertTrue(first_turn(tok, "PLAN").startswith(BOS[name]))
                    self.assertNotIn(BOS[name], later)
                if name in DEFAULT_SYSTEM:
                    self.assertIn(DEFAULT_SYSTEM[name], first_turn(tok, "PLAN"), "the first agent keeps it")

    def test_the_team_stream_reads_as_the_models_own_conversation(self):
        """First turn, an agent's turn, its close and the next turn: the template's two-turn text."""
        for name in EXPECTED:
            with self.subTest(name):
                tok = tokenizer(name)
                turns = derive_turns(tok, name)
                stream = first_turn(tok, "PLAN") + LEAD.get(name, "") + "THOUGHTS" + turns.close + turns.later("SOLVE")
                reference = tok.apply_chat_template(
                    [{"role": "user", "content": "PLAN"}, {"role": "assistant", "content": "THOUGHTS"},
                     {"role": "user", "content": "SOLVE"}], add_generation_prompt=True)
                self.assertEqual(stream, reference)
                # Three subagents and the solver: one system block at most, at the start.
                team = first_turn(tok, "P") + "".join(turns.close + turns.later(p) for p in ("C", "R", "S"))
                self.assertLessEqual(team.count("system"), 1)

    def test_chatml_derivation_gives_todays_hard_coded_strings_byte_for_byte(self):
        self.assertEqual((CHATML.close, CHATML.later_prefix, CHATML.later_suffix), CHATML_LATER)
        self.assertEqual(CHATML.later("hi"), "<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n")
        for name in (QWEN, SMOLLM):
            with self.subTest(name):
                tok = tokenizer(name)
                derived = derive_turns(tok, name)
                self.assertEqual((derived.close, derived.later_prefix, derived.later_suffix),
                                 (CHATML.close, CHATML.later_prefix, CHATML.later_suffix))
                self.assertIs(chat_turns(tok, name), CHATML, "ChatML keeps the measured strings")
        for name in (PHI, LLAMA, MISTRAL, GRANITE, OLMO):
            self.assertFalse(chat_turns(tokenizer(name), name).chatml, name)

    def test_regression_a8808ad_a_later_turn_never_repeats_the_default_system_block(self):
        """Before the fix a later turn was the template's own one-message rendering, which for
        Llama 3.1 and Granite 3.x opens with a default system block: inside the working memory
        that reads as a system prompt in an assistant reply."""
        for name in (LLAMA, GRANITE):
            with self.subTest(name):
                tok = tokenizer(name)
                old = first_turn(tok, "SOLVE")  # what a later turn was before the fix
                self.assertIn(DEFAULT_SYSTEM[name], old)
                later = chat_turns(tok, name).later("SOLVE")
                self.assertNotIn(DEFAULT_SYSTEM[name], later)
                self.assertNotIn("system", later)
                self.assertNotEqual(later, old)
                self.assertTrue(old.endswith(later), "the later turn is the one-message turn minus its preamble")

    def test_stop_ids_come_from_the_tokenizer_the_generation_config_and_the_close(self):
        class Generation:
            def __init__(self, eos):
                self.eos_token_id = eos

        cases = {
            QWEN: (None, {2}), PHI: (None, {3, 6}), LLAMA: (Generation([1, 4, 5]), {1, 4, 5}),
            MISTRAL: (Generation(2), {2}), GRANITE: (None, {0}), OLMO: (None, {0}),
        }
        for name, (generation, expected) in cases.items():
            with self.subTest(name):
                tok = tokenizer(name)
                self.assertEqual(stop_ids(tok, generation, chat_turns(tok, name).close), expected)
        # Phi-3.5 ends a turn with <|end|> (id 6), which is not its eos token.
        self.assertIn(tokenizer(PHI).vocab["<|end|>"], stop_ids(tokenizer(PHI), None, "<|end|>\n"))


@unittest.skipUnless(HAVE_JINJA, "jinja2 is needed to render chat templates")
class UnusableTemplateTest(unittest.TestCase):
    def tok(self, template, specials=("<eos>",)):
        from tests.chat_template_fixtures import TemplateTokenizer
        return TemplateTokenizer("org/odd", template=template, eos="<eos>", specials=list(specials))

    def assertRefused(self, tok, words):
        with self.assertRaises(ChatTemplateError) as caught:
            chat_turns(tok, "org/odd")
        self.assertIn("org/odd", str(caught.exception))
        self.assertIn(words, str(caught.exception))

    def test_no_chat_template(self):
        self.assertRefused(self.tok(None), "rendering a user turn failed")

    def test_a_template_that_refuses_to_end_with_an_assistant_turn(self):
        self.assertRefused(self.tok(
            "{% if messages[-1]['role'] == 'assistant' %}{{ raise_exception('The last message must be from the user') }}"
            "{% endif %}{% for m in messages %}<{{ m['role'] }}>{{ m['content'] }}<eos>{% endfor %}"
            "{% if add_generation_prompt %}<assistant>{% endif %}"), "ends with an assistant turn")

    def test_a_template_that_drops_the_content(self):
        self.assertRefused(self.tok("{% for m in messages %}<{{ m['role'] }}>{% endfor %}"), "exactly once")

    def test_a_template_whose_later_assistant_turn_opens_differently(self):
        self.assertRefused(self.tok(
            "{% for m in messages %}<{{ m['role'] }}>{{ m['content'] }}<eos>{% endfor %}"
            "{% if add_generation_prompt %}{% if messages|length == 1 %}<first>{% else %}<later>{% endif %}{% endif %}"),
            "opens the assistant differently")

    def test_a_template_that_never_closes_an_assistant_turn(self):
        self.assertRefused(self.tok(
            "{% for m in messages %}{% if m['role'] == 'user' %}<eos>U:{% endif %}{{ m['content'] }}{% endfor %}"
            "{% if add_generation_prompt %}A:{% endif %}"), "no text closes an assistant turn")

    def test_a_close_that_cuts_a_special_token_the_tokenizer_does_not_list(self):
        from tests.chat_template_fixtures import TemplateTokenizer

        class Unlisted(TemplateTokenizer):  # splits <|user|> as one token but does not say so
            all_special_tokens = []

            def get_added_vocab(self):
                return {}

        tok = Unlisted(PHI)  # its eos <|endoftext|> is still known, <|user|> is not
        with self.assertRaises(ChatTemplateError) as caught:
            derive_turns(tok, PHI)
        self.assertIn("token boundary", str(caught.exception))


def cached_tokenizer(name):
    """A tokenizer from the local Hugging Face cache only, or None. Never downloads."""
    try:
        from transformers import AutoTokenizer, PreTrainedTokenizerFast
    except ImportError:
        return None
    try:
        return AutoTokenizer.from_pretrained(name, local_files_only=True)
    except Exception:
        pass
    hub = os.path.expanduser(os.environ.get("HF_HUB_CACHE", "~/.cache/huggingface/hub"))
    for folder in glob.glob(os.path.join(hub, "models--" + name.replace("/", "--"), "snapshots", "*")):
        if os.path.exists(os.path.join(folder, "tokenizer.json")):
            try:
                return PreTrainedTokenizerFast.from_pretrained(folder, local_files_only=True)
            except Exception:
                return None
    return None


@unittest.skipUnless(HAVE_JINJA, "jinja2 is needed to render chat templates")
class CachedTokenizerTest(unittest.TestCase):
    """The fixtures and the renderer agree with real tokenizers, where those are cached."""
    REAL = {"Qwen/Qwen2.5-0.5B-Instruct": QWEN, "Qwen/Qwen2.5-3B-Instruct": QWEN,
            "HuggingFaceTB/SmolLM2-360M-Instruct": SMOLLM,
            "RedHatAI/Meta-Llama-3.1-8B-Instruct-quantized.w4a16": LLAMA,
            "RedHatAI/Mistral-7B-Instruct-v0.3-quantized.w4a16": MISTRAL}

    def test_real_tokenizers_derive_the_fixture_turns(self):
        checked = 0
        for real, fixture in self.REAL.items():
            tok = cached_tokenizer(real)
            if tok is None:
                continue
            with self.subTest(real):
                checked += 1
                fake = tokenizer(fixture)
                self.assertEqual(first_turn(tok, "PLAN"), first_turn(fake, "PLAN"))
                self.assertEqual(derive_turns(tok, real), derive_turns(fake, fixture))
                close = chat_turns(tok, real).close
                ids = stop_ids(tok, None, close)
                self.assertIn(tok.convert_tokens_to_ids(EXPECTED[fixture][1][0].strip()), ids)
        if not checked:
            self.skipTest("no target tokenizer in the local Hugging Face cache")


if __name__ == "__main__":
    unittest.main()
