"""Measure one trained mapper with latent_compare's latent phase, unchanged.

    python -m latent_pairs.evaluate --pair qwen3:qwen1.5 --checkpoint ~/l5-mappers/qwen3__qwen1.5/best.pt \
        --out ~/l5-mappers/compare

latent_compare measures the pairs in its MAPPERS table and checks the checkpoint's id
against the registered one. A mapper that has just been trained is not in the table yet, so
this registers it for the length of the process (with the id read from the checkpoint) and
calls the same phase. The run folder must already hold the item sets and, for the summary
arm, the sender's summaries.
"""
import argparse
import os
import sys

from latent_compare import run as harness
from latent_compare.models import MAPPERS, MODELS

CARD = "L5"


def register(sender, receiver, checkpoint, checkpoint_id, card=CARD):
    """Put a pair's mapper into latent_compare's table for this process. Returns the entry."""
    if sender not in MODELS or receiver not in MODELS or sender == receiver:
        raise ValueError(f"{sender}:{receiver} is not a pair of two different registered models.")
    MAPPERS[(sender, receiver)] = {"checkpoint": checkpoint, "card": card, "id": checkpoint_id}
    return MAPPERS[(sender, receiver)]


def checkpoint_id(path):
    import torch
    return torch.load(path, map_location="cpu", weights_only=True)["id"]


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--pair", required=True, help="sender:receiver, latent_compare model keys")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--out", required=True, help="latent_compare run folder")
    parser.add_argument("--force", action="store_true", help="kept for older callers; a measurement is always made afresh")
    args = parser.parse_args()
    sender, _, receiver = args.pair.partition(":")
    out, checkpoint = os.path.expanduser(args.out), os.path.expanduser(args.checkpoint)
    if not os.path.exists(os.path.join(out, "items.json")):
        parser.error(f"{out} has no items.json: measure into a latent_compare run folder, so the items are L2's")
    kept = dict(MAPPERS)
    try:
        entry = register(sender, receiver, checkpoint, checkpoint_id(checkpoint))
        name = f"{sender}>{receiver}"
        groups = harness.phase_items(out)
        # Always afresh: a checkpoint's id names its pair, settings and dev score, not its
        # weights, so a saved result with the same id may be another set of weights' (Codex
        # review, rounds 1 and 2).
        reason = harness.phase_latent(out, sender, receiver, groups, True)
        harness.note(out, name, reason)
        if reason:
            print(f"latent {sender}->{receiver} not run: {reason}", flush=True)
            sys.exit(1)
        saved = harness.load(os.path.join(out, "latent", f"{sender}__{receiver}.json"))
        if saved.get("checkpoint") != entry["id"]:
            print(f"latent {sender}->{receiver}: the result file is from checkpoint {saved.get('checkpoint')}", flush=True)
            sys.exit(1)
    finally:
        # The table goes back to what it was, also for a caller in the same process.
        MAPPERS.clear()
        MAPPERS.update(kept)


if __name__ == "__main__":
    main()
