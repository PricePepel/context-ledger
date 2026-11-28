"""T4 analysis: verdicts from the measured files and L2's per-item answers. Standard library only.

Inputs are the JSON files `measure.py` writes and the L2 run folder (`receive/<model>.json`,
whose `results[item][arm]["f1"]` holds token F1). Nothing here reads answers or passages
into the output; it reports means, paired intervals and timings.
"""
import json
import os

from latent_compare.stats import compare, mean

SMALL = "qwen1.5"
BIG_READERS = ("qwen7", "llama8", "mistral7", "qwen14")
S2_LIMIT_SECONDS_PER_1K = 5.0
S2_LENGTH = "2048"

# M2b-S training (Phi-3.5-mini to Qwen2.5-1.5B), from its log: steps, batch, passage tokens,
# measured seconds per step with the 3.8B sender resident.
M2BS_STAGES = ({"stage": 1, "steps": 15000, "batch": 4, "tokens": 256, "secPerStep": 0.567},
               {"stage": 2, "steps": 20000, "batch": 2, "tokens": 256, "secPerStep": 0.539})


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def arm_f1(receive, arm):
    """{item id: F1} for one arm of a receive file's main-set items that have it without an error."""
    out = {}
    for item, record in receive["results"].items():
        if not item.startswith("main-"):
            continue
        value = record.get(arm)
        if isinstance(value, dict) and "f1" in value and "error" not in value:
            out[item] = value["f1"]
    return out


def paired(a, b):
    """compare() of a minus b over the items both have, with both means."""
    items = sorted(set(a) & set(b))
    if not items:
        return None
    left, right = [a[i] for i in items], [b[i] for i in items]
    return {**compare(left, right), "a": round(mean(left), 4), "b": round(mean(right), 4)}


def above_zero(result):
    return bool(result) and result["low"] > 0


def quality(receives):
    """receives: {model key: receive file data}. Q1: each bigger reader's own text vs the small
    model's own text. Q2: each bigger reader's summary read by the small model vs the small text."""
    small = receives[SMALL]
    small_text = arm_f1(small, "text")
    if not small_text:
        raise ValueError(f"{SMALL} has no main-set text answers to compare with.")
    q1, q2 = {}, {}
    for key in BIG_READERS:
        if key in receives:
            q1[key] = paired(arm_f1(receives[key], "text"), small_text)
        summaries = arm_f1(small, f"t2t:{key}")
        if summaries:
            q2[key] = paired(summaries, small_text)
    return {"smallTextF1": round(mean(small_text.values()), 4), "items": len(small_text),
            "q1": q1, "q2": q2,
            "q1Pass": any(above_zero(r) for r in q1.values()), "q2Pass": any(above_zero(r) for r in q2.values())}


def exactness(resident, streamed):
    """S1 and S3 from the two exact-*.json files (same items, same order)."""
    pairs = list(zip(resident["items"], streamed["items"]))
    if not pairs or [a["id"] for a, _ in pairs] != [b["id"] for _, b in pairs]:
        raise ValueError("The resident and streamed exact runs must cover the same items.")
    argmax = sum(a["argmax"] == b["argmax"] for a, b in pairs)
    answers = sum(a["whole"] == b["whole"] for a, b in pairs)
    moved = sum(b["moved"] == b["split"] for _, b in pairs)
    return {"items": len(pairs), "argmaxSame": argmax, "answerSame": answers, "movedSameAsUnmoved": moved,
            "splitSameAsWhole": sum(b["split"] == b["whole"] for _, b in pairs),
            "residentSplitSameAsWhole": sum(a["split"] == a["whole"] for a, _ in pairs),
            "kvSerializedBytesMean": round(mean(b["kvSerializedBytes"] for _, b in pairs)),
            "prefixTokensMean": round(mean(b["prefixTokens"] for _, b in pairs), 1),
            "s1Pass": argmax == answers == len(pairs), "s3Pass": moved == len(pairs)}


def s2(timing):
    """S2 on the cpu-50 timing file."""
    row = timing["lengths"][S2_LENGTH]
    return {"secondsPer1kTokens": row["secondsPer1kTokens"], "limit": S2_LIMIT_SECONDS_PER_1K,
            "pass": row["secondsPer1kTokens"] <= S2_LIMIT_SECONDS_PER_1K}


def stream_rate(resident, streamed, length=S2_LENGTH):
    """Seconds added per GiB streamed, from a resident and a streamed timing at one length."""
    extra = streamed["lengths"][length]["prefillSeconds"] - resident["lengths"][length]["prefillSeconds"]
    return extra / streamed["streamedGiBPerPass"] if streamed["streamedGiBPerPass"] else None


def mapper_cost(resident, streamed):
    """GPU hours for M2b-S's schedule with the streamed reader as the sender. Each step adds one
    streamed prefill of batch x 256 tokens over the resident 3.8B sender's step time (an upper
    bound for the step: the 3.8B sender's own prefill is not subtracted)."""
    rows, total = [], 0.0
    for stage in M2BS_STAGES:
        tokens = stage["batch"] * stage["tokens"]
        key = str(tokens) if str(tokens) in streamed["lengths"] else min(
            streamed["lengths"], key=lambda k: abs(int(k) - tokens))
        added = streamed["lengths"][key]["prefillSeconds"]
        hours = stage["steps"] * (stage["secPerStep"] + added) / 3600
        rows.append({**stage, "streamedPrefillSeconds": added, "measuredAt": int(key), "hours": round(hours, 2)})
        total += hours
    baseline = sum(s["steps"] * s["secPerStep"] for s in M2BS_STAGES) / 3600
    return {"stages": rows, "hours": round(total, 2), "m2bsHours": round(baseline, 2)}


def verdict(s1, s2_pass, s3, q1, q2):
    """The rule table fixed before the run. None for a check means its file is missing."""
    if None in (s1, s2_pass, s3, q1, q2):
        return "incomplete: a check has no measurement"
    if not (s1 and s2_pass):
        return "do not build: the read-once step is not affordable or not exact"
    if not q1:
        return "do not build: on this task a bigger reader adds nothing a small reader lacks"
    if not s3:
        return "outside the rule table: the cache did not survive the move (S3 fails)"
    if q2:
        return "build: a streamed reader writing a summary helps small models"
    return "do not build yet: the gain exists but only a trained big-to-small mapper could carry it"


def report(out, l2):
    receives = {}
    for name in os.listdir(os.path.join(l2, "receive")):
        if name.endswith(".json"):
            receives[name[:-5]] = load(os.path.join(l2, "receive", name))
    if os.path.exists(os.path.join(out, "receive-qwen14.json")):
        receives["qwen14"] = load(os.path.join(out, "receive-qwen14.json"))
    timings = {name[len("timing-"):-5]: load(os.path.join(out, name)) for name in sorted(os.listdir(out))
               if name.startswith("timing-") and name.endswith(".json")}
    result = {"timings": timings, "quality": quality(receives)}
    if os.path.exists(os.path.join(out, "exact-resident.json")) and os.path.exists(os.path.join(out, "exact-cpu-50.json")):
        result["exact"] = exactness(load(os.path.join(out, "exact-resident.json")), load(os.path.join(out, "exact-cpu-50.json")))
    if "cpu-50" in timings:
        result["s2"] = s2(timings["cpu-50"])
        if "disk-50" in timings:
            result["s2Disk"] = s2(timings["disk-50"])
        if "resident" in timings:
            result["mapperCost"] = mapper_cost(timings["resident"], timings["cpu-50"])
            rates = {key: stream_rate(timings["resident"], t) for key, t in timings.items() if key != "resident"}
            result["secondsPerGiBStreamed"] = {key: round(rate, 4) for key, rate in rates.items() if rate is not None}
    exact = result.get("exact", {})
    result["verdict"] = verdict(exact.get("s1Pass"), result.get("s2", {}).get("pass"),
                                exact.get("s3Pass"), result["quality"]["q1Pass"], result["quality"]["q2Pass"])
    return result
