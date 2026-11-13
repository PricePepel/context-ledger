"""Chat templates of the target families, and a tokenizer that renders them like transformers.

Each template is the model's tokenizer_config.json chat_template, shortened where marked:
branches for tools, documents and controls are left out because the latent team never
passes them. Everything a plain user/assistant conversation reaches is kept as written.

TemplateTokenizer needs only jinja2 (no torch, no transformers, no network). It renders the
way transformers.utils.chat_template_utils does: a sandboxed environment with trim_blocks
and lstrip_blocks, the loopcontrols extension, raise_exception, strftime_now and tojson, and
the special tokens passed as variables. It tokenizes by splitting out special tokens; every
other character is one token, so a split that cuts a special token in two shows up.
"""
import json
import re
from datetime import datetime

QWEN25 = r"""{%- if messages[0]['role'] == 'system' %}
    {{- '<|im_start|>system\n' + messages[0]['content'] + '<|im_end|>\n' }}
{%- else %}
    {{- '<|im_start|>system\nYou are Qwen, created by Alibaba Cloud. You are a helpful assistant.<|im_end|>\n' }}
{%- endif %}
{%- for message in messages %}
    {%- if (message.role == "user") or (message.role == "system" and not loop.first) or (message.role == "assistant" and not message.tool_calls) %}
        {{- '<|im_start|>' + message.role + '\n' + message.content + '<|im_end|>' + '\n' }}
    {%- endif %}
{%- endfor %}
{%- if add_generation_prompt %}
    {{- '<|im_start|>assistant\n' }}
{%- endif %}
"""  # Qwen2.5-*-Instruct; the tools branch and tool-call messages are left out.

SMOLLM2 = (
    "{% for message in messages %}{% if loop.first and messages[0]['role'] != 'system' %}"
    "{{ '<|im_start|>system\nYou are a helpful AI assistant named SmolLM, trained by Hugging Face<|im_end|>\n' }}"
    "{% endif %}{{'<|im_start|>' + message['role'] + '\n' + message['content'] + '<|im_end|>' + '\n'}}"
    "{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\n' }}{% endif %}"
)  # SmolLM2-*-Instruct, complete (its newlines are real newlines inside the Jinja strings).

PHI35 = (
    "{% for message in messages %}{% if message['role'] == 'system' and message['content'] %}"
    "{{'<|system|>\n' + message['content'] + '<|end|>\n'}}{% elif message['role'] == 'user' %}"
    "{{'<|user|>\n' + message['content'] + '<|end|>\n'}}{% elif message['role'] == 'assistant' %}"
    "{{'<|assistant|>\n' + message['content'] + '<|end|>\n'}}{% endif %}{% endfor %}"
    "{% if add_generation_prompt %}{{ '<|assistant|>\n' }}{% else %}{{ eos_token }}{% endif %}"
)  # Phi-3.5-mini-instruct, complete.

LLAMA31 = r"""{{- bos_token }}
{%- if custom_tools is defined %}
    {%- set tools = custom_tools %}
{%- endif %}
{%- if not tools_in_user_message is defined %}
    {%- set tools_in_user_message = true %}
{%- endif %}
{%- if not date_string is defined %}
    {%- set date_string = "26 Jul 2024" %}
{%- endif %}
{%- if not tools is defined %}
    {%- set tools = none %}
{%- endif %}

{#- This block extracts the system message, so we can slot it into the right place. #}
{%- if messages[0]['role'] == 'system' %}
    {%- set system_message = messages[0]['content']|trim %}
    {%- set messages = messages[1:] %}
{%- else %}
    {%- set system_message = "" %}
{%- endif %}

{#- System message + builtin tools #}
{{- "<|start_header_id|>system<|end_header_id|>\n\n" }}
{%- if builtin_tools is defined or tools is not none %}
    {{- "Environment: ipython\n" }}
{%- endif %}
{{- "Cutting Knowledge Date: December 2023\n" }}
{{- "Today Date: " + date_string + "\n\n" }}
{{- system_message }}
{{- "<|eot_id|>" }}

{%- for message in messages %}
    {%- if not (message.role == 'ipython' or message.role == 'tool' or 'tool_calls' in message) %}
        {{- '<|start_header_id|>' + message['role'] + '<|end_header_id|>\n\n'+ message['content'] | trim + '<|eot_id|>' }}
    {%- endif %}
{%- endfor %}
{%- if add_generation_prompt %}
    {{- '<|start_header_id|>assistant<|end_header_id|>\n\n' }}
{%- endif %}
"""  # Llama-3.1-8B-Instruct; tool definitions, tool calls and tool results are left out.

MISTRAL03 = r"""{%- if messages[0]["role"] == "system" %}
    {%- set system_message = messages[0]["content"] %}
    {%- set loop_messages = messages[1:] %}
{%- else %}
    {%- set loop_messages = messages %}
{%- endif %}
{%- if not tools is defined %}
    {%- set tools = none %}
{%- endif %}
{%- set user_messages = loop_messages | selectattr("role", "equalto", "user") | list %}

{#- This block checks for alternating user/assistant messages, skipping tool calling messages #}
{%- set ns = namespace() %}
{%- set ns.index = 0 %}
{%- for message in loop_messages %}
    {%- if not (message.role == "tool" or message.role == "tool_results" or (message.tool_calls is defined and message.tool_calls is not none)) %}
        {%- if (message["role"] == "user") != (ns.index % 2 == 0) %}
            {{- raise_exception("After the optional system message, conversation roles must alternate user/assistant/user/assistant/...") }}
        {%- endif %}
        {%- set ns.index = ns.index + 1 %}
    {%- endif %}
{%- endfor %}

{{- bos_token }}
{%- for message in loop_messages %}
    {%- if message["role"] == "user" %}
        {%- if loop.last and system_message is defined %}
            {{- "[INST] " + system_message + "\n\n" + message["content"] + "[/INST]" }}
        {%- else %}
            {{- "[INST] " + message["content"] + "[/INST]" }}
        {%- endif %}
    {%- elif message["role"] == "assistant" %}
        {{- " " + message["content"]|trim + eos_token}}
    {%- else %}
        {{- raise_exception("Only user and assistant roles are supported, with the exception of an initial optional system message!") }}
    {%- endif %}
{%- endfor %}
"""  # Mistral-7B-Instruct-v0.3; [AVAILABLE_TOOLS], [TOOL_CALLS] and [TOOL_RESULTS] are left out.

GRANITE31 = r"""{%- if messages[0]['role'] == 'system' %}
    {%- set system_message = messages[0]['content'] %}
    {%- set loop_messages = messages[1:] %}
{%- else %}
    {%- set system_message = "Knowledge Cutoff Date: April 2024.\nToday's Date: " + strftime_now('%B %d, %Y') + ".\nYou are Granite, developed by IBM." %}
    {%- if tools and documents %}
        {%- set system_message = system_message + " You are a helpful AI assistant with access to the following tools." %}
    {%- elif tools %}
        {%- set system_message = system_message + " You are a helpful AI assistant with access to the following tools." %}
    {%- elif documents %}
        {%- set system_message = system_message + " Write the response to the user's input by strictly aligning with the facts in the provided documents." %}
    {%- else %}
        {%- set system_message = system_message + " You are a helpful AI assistant." %}
    {%- endif %}
    {%- set loop_messages = messages %}
{%- endif %}
{{- '<|start_of_role|>system<|end_of_role|>' + system_message + '<|end_of_text|>\n' }}
{%- for message in loop_messages %}
    {{- '<|start_of_role|>' + message['role'] + '<|end_of_role|>' + message['content'] + '<|end_of_text|>\n' }}
    {%- if loop.last and add_generation_prompt %}
        {{- '<|start_of_role|>assistant' }}
        {{- '<|end_of_role|>' }}
    {%- endif %}
{%- endfor %}"""  # granite-3.1-8b-instruct; the tool list, document list and controls are left out.

OLMO2 = (
    "{{ bos_token }}{% for message in messages %}{% if message['role'] == 'system' %}"
    "{{ '<|system|>\n' + message['content'] + '\n' }}{% elif message['role'] == 'user' %}"
    "{{ '<|user|>\n' + message['content'] + '\n' }}{% elif message['role'] == 'assistant' %}"
    "{% if not loop.last %}{{ '<|assistant|>\n'  + message['content'] + eos_token + '\n' }}"
    "{% else %}{{ '<|assistant|>\n'  + message['content'] + eos_token }}{% endif %}{% endif %}"
    "{% if loop.last and add_generation_prompt %}{{ '<|assistant|>\n' }}{% endif %}{% endfor %}"
)  # OLMo-2-1124-7B-Instruct, complete.

# name: (template, bos, eos, unk, special tokens in vocabulary order)
FAMILIES = {
    "Qwen/Qwen2.5-3B-Instruct": (QWEN25, None, "<|im_end|>", None,
                                 ["<|endoftext|>", "<|im_start|>", "<|im_end|>"]),
    "HuggingFaceTB/SmolLM2-1.7B-Instruct": (SMOLLM2, "<|im_start|>", "<|im_end|>", "<|endoftext|>",
                                            ["<|endoftext|>", "<|im_start|>", "<|im_end|>"]),
    "microsoft/Phi-3.5-mini-instruct": (PHI35, "<s>", "<|endoftext|>", "<unk>",
                                        ["<unk>", "<s>", "</s>", "<|endoftext|>", "<|assistant|>", "<|system|>",
                                         "<|end|>", "<|user|>"]),
    "meta-llama/Llama-3.1-8B-Instruct": (LLAMA31, "<|begin_of_text|>", "<|eot_id|>", None,
                                         ["<|begin_of_text|>", "<|end_of_text|>", "<|start_header_id|>",
                                          "<|end_header_id|>", "<|eom_id|>", "<|eot_id|>", "<|python_tag|>"]),
    "mistralai/Mistral-7B-Instruct-v0.3": (MISTRAL03, "<s>", "</s>", "<unk>",
                                           ["<unk>", "<s>", "</s>", "[INST]", "[/INST]", "[TOOL_CALLS]",
                                            "[AVAILABLE_TOOLS]", "[/AVAILABLE_TOOLS]", "[TOOL_RESULTS]",
                                            "[/TOOL_RESULTS]"]),
    "ibm-granite/granite-3.1-8b-instruct": (GRANITE31, "<|end_of_text|>", "<|end_of_text|>", "<|end_of_text|>",
                                            ["<|end_of_text|>", "<fim_prefix>", "<|start_of_role|>",
                                             "<|end_of_role|>", "<|tool_call|>"]),
    "allenai/OLMo-2-1124-7B-Instruct": (OLMO2, "<|endoftext|>", "<|endoftext|>", None,
                                        ["<|endoftext|>", "<|pad|>"]),
}


def _environment():
    import jinja2
    import jinja2.ext
    from jinja2.sandbox import ImmutableSandboxedEnvironment

    def raise_exception(message):
        raise jinja2.exceptions.TemplateError(message)

    def tojson(x, ensure_ascii=False, indent=None, separators=None, sort_keys=False):
        return json.dumps(x, ensure_ascii=ensure_ascii, indent=indent, separators=separators, sort_keys=sort_keys)

    def strftime_now(format):
        return datetime.now().strftime(format)

    env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True, extensions=[jinja2.ext.loopcontrols])
    env.filters["tojson"] = tojson
    env.globals["raise_exception"] = raise_exception
    env.globals["strftime_now"] = strftime_now
    return env


class TemplateTokenizer:
    """A tokenizer with a real chat template and a vocabulary of special tokens only."""

    def __init__(self, name, template=None, bos=None, eos=None, unk=None, specials=None):
        if template is None and name in FAMILIES:
            template, bos, eos, unk, specials = FAMILIES[name]
        self.name = name
        self.chat_template = template
        self.bos_token, self.eos_token, self.unk_token = bos, eos, unk
        self.pad_token = None
        self.vocab = {token: index for index, token in enumerate(specials or [])}
        self.padding_side = "right"
        self._split = re.compile("(" + "|".join(re.escape(t) for t in sorted(self.vocab, key=len, reverse=True)) + ")"
                                 if self.vocab else "(?!)")

    # The attributes chat_turns reads.
    @property
    def all_special_tokens(self):
        return list(self.vocab)

    def get_added_vocab(self):
        return dict(self.vocab)

    @property
    def eos_token_id(self):
        return self.vocab.get(self.eos_token)

    @property
    def unk_token_id(self):
        return self.vocab.get(self.unk_token)

    def convert_tokens_to_ids(self, token):
        return self.vocab.get(token, self.unk_token_id)

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False, **kwargs):
        if self.chat_template is None:
            raise ValueError("Cannot use chat template functions because tokenizer.chat_template is not set and no "
                             "template argument was passed!")
        template = _environment().from_string(self.chat_template)
        variables = {"bos_token": self.bos_token, "eos_token": self.eos_token, "unk_token": self.unk_token}
        return template.render(messages=messages, tools=None, documents=None,
                               add_generation_prompt=add_generation_prompt,
                               **{k: v for k, v in variables.items() if v is not None}, **kwargs)

    def encode(self, text):
        ids = []
        for piece in self._split.split(text):
            if piece in self.vocab:
                ids.append(self.vocab[piece])
            else:
                ids.extend(1000 + ord(ch) for ch in piece)
        return ids

    def __call__(self, texts, add_special_tokens=False, **kwargs):
        rows = [self.encode(t) for t in texts]
        return {"input_ids": rows, "attention_mask": [[1] * len(r) for r in rows]}
