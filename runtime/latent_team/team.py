"""M2c: a latent agent team on one open model (LatentMAS, arXiv 2511.20639, reimplemented).

Subagents (planner, critic, refiner) never write text. Each one reads its prompt on
top of the working memory left by the agents before it, then takes `m` latent steps:
the last-layer hidden state h is mapped back into the input-embedding space,

    e = h W_a * (mean ||W_in,x|| / ||h||),   W_a = (W_out^T W_out + lambda I)^-1 W_out^T W_in,

and fed in as the next input. Everything an agent read and thought stays in the KV
cache, and that cache is the next agent's working memory. The solver (the
orchestrator) is the only agent that decodes text.

Batches are left padded. Position ids come from the running attention mask
(cumsum - 1), so padding inside the accumulated memory never shifts positions.
"""
import time
from dataclasses import dataclass, field

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, DynamicCache

ROLES = ("planner", "critic", "refiner")

# Our own wording of the paper's role instructions.
LATENT_PROMPTS = {
    "planner": ("You are the Planner. Design a short step-by-step plan for solving the question below. "
                "Do not give the final answer.\n\nQuestion: {question}"),
    "critic": ("You are the Critic. You have the Planner's plan as latent working memory. Check it against the "
               "question and point out mistakes or missing steps.\n\nQuestion: {question}"),
    "refiner": ("You are the Refiner. You have a plan and its critique as latent working memory. Produce a "
                "corrected, complete plan.\n\nQuestion: {question}"),
    "solver": ("You are the Solver. You have the team's plan as latent working memory; it may contain mistakes, "
               "so check it. Solve the question step by step and end with: The answer is <number>.\n\n"
               "Question: {question}"),
}
TEXT_PROMPTS = {
    "planner": LATENT_PROMPTS["planner"],
    "critic": ("You are the Critic. Check the Planner's plan against the question and point out mistakes or "
               "missing steps.\n\nQuestion: {question}\n\nPlan:\n{planner}"),
    "refiner": ("You are the Refiner. Produce a corrected, complete plan from the plan and its critique.\n\n"
                "Question: {question}\n\nPlan:\n{planner}\n\nCritique:\n{critic}"),
    "solver": ("You are the Solver. Here is the team's plan; it may contain mistakes, so check it. Solve the "
               "question step by step and end with: The answer is <number>.\n\nQuestion: {question}\n\n"
               "Plan:\n{refiner}"),
}
SINGLE_PROMPT = ("Solve the question step by step and end with: The answer is <number>.\n\nQuestion: {question}")


@dataclass
class Receipt:
    system: str
    latent_steps: int = 0                 # per subagent
    generated_tokens: list = field(default_factory=list)  # per question, text tokens only
    latent_vectors: int = 0               # per question, latent steps across subagents
    seconds: float = 0.0                  # wall time for the batch

    def as_dict(self):
        return {"system": self.system, "latentSteps": self.latent_steps, "generatedTokens": self.generated_tokens,
                "latentVectors": self.latent_vectors, "seconds": round(self.seconds, 3)}


def alignment(model, ridge=1e-4):
    """W_a and the target norm. Solved once per model, in fp32."""
    w_in = model.get_input_embeddings().weight.detach().float()
    w_out = model.get_output_embeddings().weight.detach().float()
    dim = w_in.shape[1]
    gram = w_out.T @ w_out + ridge * torch.eye(dim, device=w_out.device)
    w_a = torch.linalg.solve(gram, w_out.T @ w_in)
    target = w_in.norm(dim=1).mean()
    return w_a, target


def align(hidden, w_a, target):
    """Map last-layer hidden states [B, d] to input embeddings with the paper's rescaling."""
    h = hidden.float()
    e = h @ w_a
    return e * (target / h.norm(dim=-1, keepdim=True).clamp(min=1e-6))


class LatentTeam:
    def __init__(self, model_name="Qwen/Qwen2.5-3B-Instruct", device="cuda", dtype=torch.bfloat16, model=None,
                 tokenizer=None):
        self.model_name = model_name
        self.device = device
        self.tokenizer = tokenizer or AutoTokenizer.from_pretrained(model_name)
        self.tokenizer.padding_side = "left"
        if self.tokenizer.pad_token_id is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        self.model = model or AutoModelForCausalLM.from_pretrained(model_name, dtype=dtype).to(device)
        self.model.eval()
        self.w_a, self.target = alignment(self.model)
        self.eos = {self.tokenizer.eos_token_id}
        for token in ("<|im_end|>", "<|endoftext|>", "<|eot_id|>"):
            token_id = self.tokenizer.convert_tokens_to_ids(token)
            if isinstance(token_id, int) and token_id >= 0 and token_id != self.tokenizer.unk_token_id:
                self.eos.add(token_id)

    # ------------------------------------------------------------------ helpers
    def render(self, prompts):
        """Chat-format each prompt and tokenize the batch, left padded."""
        texts = [self.tokenizer.apply_chat_template([{"role": "user", "content": p}], tokenize=False,
                                                     add_generation_prompt=True) for p in prompts]
        encoded = self.tokenizer(texts, return_tensors="pt", padding=True, add_special_tokens=False)
        return encoded["input_ids"].to(self.device), encoded["attention_mask"].to(self.device)

    @staticmethod
    def positions(full_mask, new_tokens):
        """Position ids of the last new_tokens columns, counting only real tokens before them."""
        return (full_mask.cumsum(-1) - 1).clamp(min=0)[:, -new_tokens:]

    def forward(self, memory, memory_mask, ids=None, mask=None, embeds=None):
        new = ids if ids is not None else embeds
        if mask is None:
            mask = torch.ones(new.shape[:2], dtype=torch.long, device=self.device)
        full = mask if memory_mask is None else torch.cat([memory_mask, mask], dim=1)
        out = self.model(input_ids=ids, inputs_embeds=embeds, attention_mask=full, past_key_values=memory,
                         position_ids=self.positions(full, new.shape[1]), use_cache=True, output_hidden_states=True)
        return out, full

    def think(self, memory, memory_mask, prompts, steps):
        """One subagent: read its prompt on top of the memory, then take `steps` latent steps."""
        ids, mask = self.render(prompts)
        out, full = self.forward(memory, memory_mask, ids=ids, mask=mask)
        memory = out.past_key_values
        hidden = out.hidden_states[-1][:, -1]
        for _ in range(steps):
            embeds = align(hidden, self.w_a, self.target).to(self.model.dtype)[:, None, :]
            out, full = self.forward(memory, full, embeds=embeds)
            memory = out.past_key_values
            hidden = out.hidden_states[-1][:, -1]
        return memory, full

    def decode(self, memory, memory_mask, prompts, max_new_tokens):
        """Greedy text decoding of a batch on top of the memory. Returns (texts, token counts)."""
        ids, mask = self.render(prompts)
        out, full = self.forward(memory, memory_mask, ids=ids, mask=mask)
        memory = out.past_key_values
        batch = ids.shape[0]
        done = torch.zeros(batch, dtype=torch.bool, device=self.device)
        tokens = [[] for _ in range(batch)]
        next_ids = out.logits[:, -1].argmax(-1)
        eos = torch.tensor(sorted(self.eos), device=self.device)
        for _ in range(max_new_tokens):
            done |= torch.isin(next_ids, eos)
            if bool(done.all()):
                break
            for row in range(batch):
                if not done[row]:
                    tokens[row].append(int(next_ids[row]))
            fill = torch.full_like(next_ids, int(eos[0]))
            step = torch.where(done, fill, next_ids)[:, None]
            out, full = self.forward(memory, full, ids=step)
            memory = out.past_key_values
            next_ids = out.logits[:, -1].argmax(-1)
        texts = [self.tokenizer.decode(t, skip_special_tokens=True).strip() for t in tokens]
        return texts, [len(t) for t in tokens]

    def generate(self, prompts, max_new_tokens):
        return self.decode(None, None, prompts, max_new_tokens)

    # ------------------------------------------------------------------ systems
    @torch.no_grad()
    def latent_mas(self, questions, steps=40, max_new_tokens=512):
        start = time.perf_counter()
        memory, mask = DynamicCache(), None
        for role in ROLES:
            memory, mask = self.think(memory, mask, [LATENT_PROMPTS[role].format(question=q) for q in questions], steps)
        answers, counts = self.decode(memory, mask, [LATENT_PROMPTS["solver"].format(question=q) for q in questions],
                                      max_new_tokens)
        self._sync()
        receipt = Receipt("latent_mas", steps, counts, steps * len(ROLES), time.perf_counter() - start)
        return answers, receipt

    @torch.no_grad()
    def text_mas(self, questions, max_agent_tokens=256, max_new_tokens=512):
        start = time.perf_counter()
        notes = [{} for _ in questions]
        totals = [0] * len(questions)
        for role in ROLES:
            prompts = [TEXT_PROMPTS[role].format(question=q, **n) for q, n in zip(questions, notes)]
            texts, counts = self.generate(prompts, max_agent_tokens)
            for n, text, row in zip(notes, texts, range(len(questions))):
                n[role] = text
                totals[row] += counts[row]
        answers, counts = self.generate([TEXT_PROMPTS["solver"].format(question=q, **n) for q, n in zip(questions, notes)],
                                        max_new_tokens)
        self._sync()
        totals = [a + b for a, b in zip(totals, counts)]
        return answers, Receipt("text_mas", 0, totals, 0, time.perf_counter() - start)

    @torch.no_grad()
    def single(self, questions, max_new_tokens=512):
        start = time.perf_counter()
        answers, counts = self.generate([SINGLE_PROMPT.format(question=q) for q in questions], max_new_tokens)
        self._sync()
        return answers, Receipt("single", 0, counts, 0, time.perf_counter() - start)

    def _sync(self):
        if str(self.device).startswith("cuda"):
            torch.cuda.synchronize()
