"""Counts and sizes for a mapper library. Standard library only.

A direct library trains one mapper per ordered pair. A split hub trains one encoder and
one decoder per model. A pivot hub trains one mapper into the pivot model's cache and one
out of it for every other model, and a hand-off runs two of them. The parameter counts
follow latent_transfer.mapper.Mapper term by term, so a shape change there shows up in
the tests here.
"""
DESIGNS = ("direct", "split", "pivot")
# The mapper every pair is trained with (L5's recipe, ADR-19): width, FFN width, blocks.
DIM, FFN, SLOTS = 384, 1536, 8


def layer_groups(num_layers, slots):
    """The same split as latent_transfer.mapper.layer_groups, which needs torch to import.
    A test holds the two together."""
    return [list(range(b * num_layers // slots, (b + 1) * num_layers // slots)) for b in range(slots)]


def parts(models, design):
    """Trained files for a library of `models` models."""
    if models < 2:
        raise ValueError("A library needs at least two models.")
    if design not in DESIGNS:
        raise ValueError(f"Unknown design: {design}. Known: {', '.join(DESIGNS)}.")
    return {"direct": models * (models - 1), "split": 2 * models, "pivot": 2 * (models - 1)}[design]


def parts_for_one_more(models, design):
    """Files to train when one model joins a library that has `models` models."""
    return parts(models + 1, design) - parts(models, design)


def mappers_per_handoff(design, through_pivot=True):
    """Mapper passes one hand-off runs. A pivot hub runs two unless one end is the pivot."""
    if design not in DESIGNS:
        raise ValueError(f"Unknown design: {design}. Known: {', '.join(DESIGNS)}.")
    return 2 if design == "pivot" and through_pivot else 1


def cache_width(shape):
    """Numbers per token in a model's whole cache: keys and values of every layer and head."""
    layers, heads, head_dim = shape
    return 2 * layers * heads * head_dim


def encoder_params(shape, dim=DIM, slots=SLOTS):
    """One linear map per slot from that slot's layers to the hub width (Block.mem)."""
    _, heads, head_dim = shape
    return sum(2 * len(group) * heads * head_dim * dim for group in layer_groups(shape[0], slots))


def decoder_params(shape, embed_dim, dim=DIM, ffn=FFN, slots=SLOTS):
    """Everything else of a Mapper: the query projection, the blocks and the output heads."""
    _, heads, head_dim = shape
    attention = 4 * dim * dim                        # q, k, v, o without bias
    feed_forward = dim * ffn + ffn + ffn * dim + dim
    norms = 4 * 2 * dim                              # ln1, ln2, ln3, ln_out
    block = 2 * attention + feed_forward + norms + dim   # + the sink slot
    heads_out = sum(2 * len(group) * heads * head_dim * dim for group in layer_groups(shape[0], slots))
    return embed_dim * dim + slots * block + heads_out


def direct_params(sender_shape, receiver_shape, receiver_embed_dim, dim=DIM, ffn=FFN, slots=SLOTS):
    """A direct mapper is the sender's encoder plus the receiver's decoder."""
    return encoder_params(sender_shape, dim, slots) + decoder_params(receiver_shape, receiver_embed_dim, dim, ffn, slots)


def megabytes(params, bytes_per_value=2):
    """File size of a part stored as 16-bit floats (the mapper runs in bf16)."""
    return params * bytes_per_value / 1e6


def hub_bytes_per_token(dim=DIM, slots=SLOTS, bytes_per_value=2):
    """Size of the split hub's state for one sender token."""
    return dim * slots * bytes_per_value


def gpu_hours(models, design, hours_per_mapper):
    """Training time when every part costs what one direct mapper costs. For the split hub
    this is an assumption (one encoder and one decoder per step, as many steps per part as
    a direct mapper gets), stated in docs/mapper-hub.md and not measured."""
    units = {"direct": models * (models - 1), "split": models, "pivot": 2 * (models - 1)}[design]
    return units * hours_per_mapper
