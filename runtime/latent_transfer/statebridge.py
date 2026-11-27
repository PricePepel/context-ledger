"""Training-free alignment of sender states to a receiver's input embeddings (card L4).

Written from the equations of StateBridge (arXiv 2608.13317, Sec. 3.3), not from its code:

    centre and whiten both sides     S_w = (S - mu_S) Sigma_S^-1/2,  R_w likewise
    rotate                           Q = U V^T  from  S_w^T R_w = U D V^T
    put the receiver's scale back    S~ = S_w Q Sigma_R^1/2 + mu_R
    norm calibration                 s^ = s~ * (mean vocabulary norm / |s~|)
    vocabulary anchoring             s- = (1 - alpha) s^ + alpha * nearest vocabulary row

The paper fits the first three steps on one message (64 rows) against that message's own
token embeddings, with sender and receiver being the same model. `per_message_map` is that
fit. Between two models the same closed form is fitted once per pair from second moments
(`Moments`, `fit_map`), on vocabulary anchors or on real states; when the two widths differ
Q is semi-orthogonal (orthonormal columns or rows).

Everything here is linear algebra in float64 plus three small model helpers. Nothing is trained.
"""
from dataclasses import dataclass

import torch

PREFIX_TOKENS = 64   # K in the paper
ALPHA = 0.3          # anchoring coefficient
RIDGE = 1e-3         # lambda


class Moments:
    """Running sums for a fit of rows x [n, dx] to rows y [n, dy]."""

    def __init__(self, dim_x, dim_y, device="cpu"):
        kind = {"dtype": torch.float64, "device": device}
        self.count = 0
        self.sum_x, self.sum_y = torch.zeros(dim_x, **kind), torch.zeros(dim_y, **kind)
        self.xtx, self.yty = torch.zeros(dim_x, dim_x, **kind), torch.zeros(dim_y, dim_y, **kind)
        self.xty = torch.zeros(dim_x, dim_y, **kind)

    def add(self, x, y):
        if x.shape[0] != y.shape[0]:
            raise ValueError("x and y need the same number of rows")
        x, y = x.to(self.sum_x), y.to(self.sum_y)
        self.count += x.shape[0]
        self.sum_x += x.sum(0)
        self.sum_y += y.sum(0)
        self.xtx += x.T @ x
        self.yty += y.T @ y
        self.xty += x.T @ y
        return self


@dataclass
class AlignMap:
    """states -> (states - mean_x) @ transform + mean_y, with transform = Sigma_x^-1/2 Q Sigma_y^1/2."""
    mean_x: torch.Tensor
    transform: torch.Tensor
    mean_y: torch.Tensor
    rotation: torch.Tensor   # Q, kept for the tests
    whiten_x: torch.Tensor   # Sigma_x^-1/2
    whiten_y: torch.Tensor   # Sigma_y^-1/2

    def apply(self, states):
        return (states.to(self.transform) - self.mean_x) @ self.transform + self.mean_y


def _sym_power(values, vectors, power):
    return (vectors * values.pow(power)) @ vectors.T


def fit_map(moments, ridge=RIDGE, relative=True):
    """Whitened orthogonal Procrustes from second moments (Eq. 3 to 7).

    relative=True scales the ridge by each side's mean eigenvalue, for fits on a whole
    vocabulary whose eigenvalues are far below the paper's absolute 1e-3. relative=False
    is the paper's own setting.
    """
    if moments.count < 2:
        raise ValueError("A fit needs at least two rows.")
    n = moments.count
    mean_x, mean_y = moments.sum_x / n, moments.sum_y / n
    cov_x = moments.xtx / n - torch.outer(mean_x, mean_x)
    cov_y = moments.yty / n - torch.outer(mean_y, mean_y)
    cov_xy = moments.xty / n - torch.outer(mean_x, mean_y)
    values_x, vectors_x = torch.linalg.eigh((cov_x + cov_x.T) / 2)
    values_y, vectors_y = torch.linalg.eigh((cov_y + cov_y.T) / 2)
    values_x, values_y = values_x.clamp_min(0), values_y.clamp_min(0)
    ridge_x = ridge * (values_x.mean() if relative else 1.0)
    ridge_y = ridge * (values_y.mean() if relative else 1.0)
    whiten_x = _sym_power(values_x + ridge_x, vectors_x, -0.5)
    whiten_y = _sym_power(values_y + ridge_y, vectors_y, -0.5)
    colour_y = _sym_power(values_y + ridge_y, vectors_y, 0.5)
    # S_w^T R_w / n. The optimum of Eq. 6 is U V^T; no determinant constraint is added.
    left, _, right = torch.linalg.svd(whiten_x @ cov_xy @ whiten_y, full_matrices=False)
    rotation = left @ right
    return AlignMap(mean_x, whiten_x @ rotation @ colour_y, mean_y, rotation, whiten_x, whiten_y)


def per_message_map(states, reference, ridge=RIDGE):
    """The paper's fit: one message's states against its own token embeddings."""
    moments = Moments(states.shape[1], reference.shape[1], device=states.device)
    return fit_map(moments.add(states, reference), ridge=ridge, relative=False)


def norm_calibrate(vectors, target_norm):
    """Eq. 8: every row gets the mean norm of the vocabulary embeddings."""
    return vectors * (target_norm / vectors.norm(dim=-1, keepdim=True).clamp_min(1e-6))


def mean_vocab_norm(vocab):
    return float(vocab.float().norm(dim=-1).mean())


def nearest_vocab(vectors, vocab, chunk=16384):
    """The id of the vocabulary row with the highest cosine to each vector (Eq. 9, left).

    The vocabulary is read in chunks and normalised on the way, so no second copy of a
    150k-row embedding matrix is kept.
    """
    unit = torch.nn.functional.normalize(vectors.float(), dim=-1)
    best = torch.full((vectors.shape[0],), -2.0, device=vectors.device)
    best_id = torch.zeros(vectors.shape[0], dtype=torch.long, device=vectors.device)
    for start in range(0, vocab.shape[0], chunk):
        rows = torch.nn.functional.normalize(vocab[start:start + chunk].to(unit), dim=-1)
        score, index = (unit @ rows.T).max(dim=-1)
        better = score > best
        best = torch.where(better, score, best)
        best_id = torch.where(better, index + start, best_id)
    return best_id


def anchor_to_vocab(vectors, vocab, alpha=ALPHA):
    """Eq. 9: move each row a share alpha of the way to its nearest vocabulary row."""
    ids = nearest_vocab(vectors, vocab)
    if alpha == 0:
        return vectors, ids
    return (1 - alpha) * vectors + alpha * vocab[ids].to(vectors), ids


def bridge(states, align_map, vocab, target_norm, alpha=ALPHA):
    """Sender states [K, d_sender] to a receiver prefix [K, d_receiver] and the anchored ids."""
    aligned = align_map.apply(states)
    return anchor_to_vocab(norm_calibrate(aligned, target_norm), vocab, alpha)


def retrieval_accuracy(align_map, rows, target_ids, vocab):
    """Share of mapped rows whose nearest receiver row is the expected one (before calibration,
    which does not change a cosine)."""
    if rows.shape[0] == 0:
        return 0.0
    found = nearest_vocab(align_map.apply(rows), vocab)
    return float((found.cpu() == torch.as_tensor(target_ids)).float().mean())


# Model helpers --------------------------------------------------------------

@torch.no_grad()
def reading_states(model, input_ids):
    """Final-layer states [T, d] and logits [T, V] of a model reading input_ids [1, T].

    The last entry of hidden_states is taken after the final norm, so the output embedding
    reads it directly; `test_statebridge` checks that on a tiny model.
    """
    out = model(input_ids=input_ids, attention_mask=torch.ones_like(input_ids), output_hidden_states=True)
    return out.hidden_states[-1][0], out.logits[0]


@torch.no_grad()
def generate_with_states(model, input_ids, max_new_tokens, stop_ids, pad_id=0):
    """Greedy generation that also returns the state each new token was read from.

    Returns (token ids, states [T, d]). states[i] is the final-layer state at the step that
    produced token i. A trailing stop token and its state are dropped.
    """
    out = model.generate(input_ids, attention_mask=torch.ones_like(input_ids), max_new_tokens=max_new_tokens,
                         do_sample=False, pad_token_id=pad_id, output_hidden_states=True,
                         return_dict_in_generate=True)
    tokens = out.sequences[0, input_ids.shape[1]:].tolist()
    states = torch.stack([step[-1][0, -1] for step in out.hidden_states])[:len(tokens)]
    while tokens and tokens[-1] in stop_ids:
        tokens.pop()
    return tokens, states[:len(tokens)]


@torch.no_grad()
def answer_from_embeds(model, embeds, max_new_tokens, eos_ids, pad_id=0):
    """Greedy answer of a receiver given input embeddings [T, d]; returns the new token ids."""
    embeds = embeds[None].to(model.get_input_embeddings().weight)
    mask = torch.ones(embeds.shape[:2], dtype=torch.long, device=embeds.device)
    # Plain greedy, like M2b-S's own decoding loop: a model's generation defaults (Qwen ships a
    # repetition penalty of 1.1) must not change the answer.
    out = model.generate(inputs_embeds=embeds, attention_mask=mask, max_new_tokens=max_new_tokens,
                         do_sample=False, repetition_penalty=1.0, eos_token_id=sorted(eos_ids),
                         pad_token_id=pad_id)
    return out[0].tolist()
