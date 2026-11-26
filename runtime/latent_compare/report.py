"""Aggregates and tables for the cross-model harness. Standard library only.

build_summary turns the per-item phase files into aggregates (no passage or answer text),
and render_markdown turns those into the tables of docs/evals.md.
"""
from .models import MAPPERS, MODELS, latent_status
from .stats import BOOTSTRAP_ROUNDS, compare, kv_bytes, mean, mean_interval

NO_MAPPER = "no mapper yet"
FAITHFUL_SHARE = 0.95
# Resamples per interval; build_summary sets it for one build (tests use fewer).
ROUNDS = {"n": BOOTSTRAP_ROUNDS}


def ok(record, arm):
    value = (record or {}).get(arm)
    return value if value is not None and "error" not in value else None


def aggregate(records, arm, metrics=("f1", "em", "hit")):
    """{n, errors, missing, f1, em, hit, ms, bytes, f1Low, f1High} of one arm over item records."""
    good = [ok(record, arm) for record in records]
    present = [record.get(arm) for record in records if record.get(arm) is not None]
    good = [value for value in good if value is not None]
    result = {"n": len(good), "errors": len(present) - len(good), "missing": len(records) - len(present)}
    if not good:
        return result
    for metric in metrics:
        result[metric] = round(mean(value[metric] for value in good), 4)
    low, high = mean_interval([value["f1"] for value in good], rounds=ROUNDS["n"])
    result.update({"f1Low": round(low, 4), "f1High": round(high, 4),
                   "ms": round(mean(value["ms"] for value in good), 1),
                   "bytes": round(mean(value.get("bytes", 0) for value in good))})
    return result


def paired(records, arm_a, arm_b, metric="f1"):
    """arm_a minus arm_b over the items where both ran."""
    both = [(ok(record, arm_a), ok(record, arm_b)) for record in records]
    both = [(a, b) for a, b in both if a is not None and b is not None]
    return compare([a[metric] for a, _ in both], [b[metric] for _, b in both], rounds=ROUNDS["n"])


def same_answer(records, arm_a, arm_b):
    both = [(ok(record, arm_a), ok(record, arm_b)) for record in records]
    both = [(a, b) for a, b in both if a is not None and b is not None]
    return round(mean(float(a["answer"] == b["answer"]) for a, b in both), 4) if both else None


def rows_of(groups, results, group):
    """(item, record) for each item of a group; a missing record is an empty one."""
    return [(item, results.get(item["id"], {})) for item in groups[group]]


def model_row(description):
    per_token = kv_bytes(description["layers"], description["kvHeads"], description["headDim"], 1)
    return {name: description.get(name) for name in
            ("key", "id", "family", "params", "weights", "licence", "tokenizer", "template", "layers", "kvHeads",
             "headDim", "context", "systemRole", "cacheDtype", "gpuGiB")} | {"kvBytesPerToken": per_token}


def main_section(groups, receive, summaries):
    receivers, t2t, senders = {}, {}, {}
    for key, data in receive.items():
        records = [record for _, record in rows_of(groups, data["results"], "main")]
        cache = aggregate(records, "self_cache")
        good = [ok(record, "self_cache") for record in records]
        good = [value for value in good if value is not None]
        if good:
            for part in ("prefillMs", "saveMs", "loadMs", "answerMs"):
                cache[part] = round(mean(value[part] for value in good), 1)
            cache["prefixTokens"] = round(mean(value["prefixTokens"] for value in good), 1)
        cache["sameAnswer"] = same_answer(records, "self_cache", "text")
        cache["vsText"] = {metric: paired(records, "self_cache", "text", metric) for metric in ("f1", "em")}
        receivers[key] = {"text": aggregate(records, "text"), "closed": aggregate(records, "closed"),
                          "self_cache": cache}
        for sender in receive:
            arm = f"t2t:{sender}"
            cell = aggregate(records, arm)
            if cell["n"]:
                cell["vsText"] = {metric: paired(records, arm, "text", metric) for metric in ("f1", "em")}
                cell["receiverMs"] = round(mean(ok(r, arm)["receiverMs"] for r in records if ok(r, arm)), 1)
            t2t.setdefault(sender, {})[key] = cell
    main_ids = {item["id"] for item in groups["main"]}
    for key, data in summaries.items():
        rows = [value for name, value in data["summaries"].items() if name in main_ids and "error" not in value]
        if rows:
            senders[key] = {"n": len(rows), "ms": round(mean(r["ms"] for r in rows), 1),
                            "bytes": round(mean(r["bytes"] for r in rows)),
                            "newTokens": round(mean(r["newTokens"] for r in rows), 1)}
    return {"receivers": receivers, "t2t": t2t, "senders": senders}


def latent_section(groups, receive, latent):
    """Per mapper pair: the latent arms, their controls and paired intervals."""
    pairs = {}
    for (sender, receiver), data in latent.items():
        name = f"{sender}>{receiver}"
        if "skipped" in data:
            pairs[name] = {"skipped": data["skipped"]}
            continue
        rows = rows_of(groups, data["results"], "main")
        records = [record for _, record in rows]
        arms = {arm: aggregate(records, arm) for arm in ("text_m2b", "swat", "mismatched", "zeroed", "t2t_m2b")}
        good = [ok(record, "swat") for record in records]
        good = [value for value in good if value is not None]
        if good:
            for part in ("alignMs", "senderMs", "mapperMs"):
                arms["swat"][part] = round(mean(value[part] for value in good), 1)
            arms["swat"]["mappedBytes"] = round(mean(value["mappedBytes"] for value in good))
            arms["swat"]["senderTokens"] = round(mean(value["senderTokens"] for value in good), 1)
        intervals = {f"swat-{other}": {metric: paired(records, "swat", other, metric) for metric in ("f1", "em", "hit")}
                     for other in ("mismatched", "zeroed", "t2t_m2b", "text_m2b")}
        # Against the harness's own arms for the same receiver and items (its chat template).
        harness = receive.get(receiver, {}).get("results", {})
        joined = [{"swat": record.get("swat"), "text": harness.get(item["id"], {}).get("text"),
                   "t2t": harness.get(item["id"], {}).get(f"t2t:{sender}")} for item, record in rows]
        for other in ("text", "t2t"):
            intervals[f"swat-harness_{other}"] = {metric: paired(joined, "swat", other, metric) for metric in ("f1", "em")}
        edge = {}
        for group in ("long_passage", "tiny_passage", "non_english_emoji"):
            group_rows = rows_of(groups, data["results"], group)
            answerable = [record for item, record in group_rows if item.get("answerable", True)]
            edge[group] = {arm: aggregate(answerable, arm) for arm in ("text_m2b", "swat")}
            edge[group]["items"] = len(group_rows)
            edge[group]["errors"] = sum(1 for _, record in group_rows for value in record.values() if "error" in value)
        pairs[name] = {"checkpoint": data["checkpoint"], "card": MAPPERS[(sender, receiver)]["card"], "arms": arms,
                       "intervals": intervals, "edge": edge}
    return pairs


def edge_section(groups, receive):
    edge = {}
    for key, data in receive.items():
        results, own = data["results"], f"t2t:{key}"
        arms = ("text", "self_cache", own)

        def part(group, keep, arm):
            return aggregate([record for item, record in rows_of(groups, results, group) if keep(item)], arm)

        def errors(group):
            return sum(1 for _, record in rows_of(groups, results, group) for value in record.values() if "error" in value)

        long_rows = rows_of(groups, results, "long_passage")
        long_text = [ok(record, "text") for _, record in long_rows]
        long_text = [value for value in long_text if value is not None]
        system_rows = rows_of(groups, results, "no_system_role")
        main_results = {item["id"]: results.get(item["id"], {}) for item in groups["main"]}
        joined = [{"system": record.get("text"), "plain": main_results.get(item["mainId"], {}).get("text")}
                  for item, record in system_rows]
        edge[key] = {
            "long_passage": {
                "head": {arm.split(":")[0]: part("long_passage", lambda i: i["answerAt"] == "head", arm) for arm in arms},
                "tail": {arm.split(":")[0]: part("long_passage", lambda i: i["answerAt"] == "tail", arm) for arm in arms},
                "truncatedShare": round(mean(float(v["truncated"]) for v in long_text), 4) if long_text else None,
                "passageTokens": round(mean(v["passageTokens"] for v in long_text)) if long_text else None,
                "keptTokens": round(mean(v["keptTokens"] for v in long_text)) if long_text else None,
                "maxPromptTokens": max((v["promptTokens"] for v in long_text), default=None),
                "errors": errors("long_passage"),
            },
            "tiny_passage": {
                "one_word": {arm.split(":")[0]: part("tiny_passage", lambda i: i["kind"] == "one_word", arm) for arm in arms},
                "empty": {arm.split(":")[0]: part("tiny_passage", lambda i: i["kind"] == "empty", arm) for arm in arms},
                "errors": errors("tiny_passage"),
            },
            "non_english_emoji": {**{arm.split(":")[0]: part("non_english_emoji", lambda i: True, arm) for arm in arms},
                                  "errors": errors("non_english_emoji")},
            "unanswerable": {
                "unanswerable": {arm.split(":")[0]: part("unanswerable", lambda i: not i["answerable"], arm) for arm in arms},
                "control": {arm.split(":")[0]: part("unanswerable", lambda i: i["answerable"], arm,) for arm in arms},
                "controlAbstained": {arm.split(":")[0]: aggregate(
                    [record for item, record in rows_of(groups, results, "unanswerable") if item["answerable"]],
                    arm, metrics=("abstained",)).get("abstained") for arm in arms},
                "errors": errors("unanswerable"),
            },
            "no_system_role": {
                "systemRole": data["model"]["systemRole"],
                "text": aggregate([record for _, record in system_rows], "text"),
                "self_cache": aggregate([record for _, record in system_rows], "self_cache"),
                "sameAnswer": same_answer([record for _, record in system_rows], "self_cache", "text"),
                "vsPlain": paired(joined, "system", "plain"),
                "errors": errors("no_system_role"),
            },
        }
    return edge


def checks(summary):
    """The four checks of the eval definition, from the aggregates."""
    main, result = summary["main"]["receivers"], {}
    faithful = {}
    for key, row in main.items():
        cache = row["self_cache"]
        interval = (cache.get("vsText") or {}).get("f1")
        faithful[key] = bool(cache.get("sameAnswer") is not None and cache["sameAnswer"] >= FAITHFUL_SHARE
                             and interval and interval["low"] <= 0 <= interval["high"])
    result["handoffFaithful"] = {"passed": bool(faithful) and all(faithful.values()), "models": faithful}
    mapper = {}
    for name, pair in summary["latent"].items():
        if "skipped" in pair:
            mapper[name] = False
            continue
        needed = [pair["intervals"][f"swat-{other}"]["f1"] for other in ("mismatched", "zeroed", "t2t_m2b")]
        needed.append(pair["intervals"]["swat-harness_t2t"]["f1"])
        mapper[name] = all(interval is not None and interval["low"] > 0 for interval in needed)
    result["mapperHolds"] = {"passed": bool(mapper) and all(mapper.values()), "pairs": mapper}
    complete = [key for key in main if key in summary["edge"]]
    result["coverage"] = {"passed": len(complete) >= 5, "models": len(complete)}
    errors = {key: sum(group["errors"] for group in groups.values()) + sum(
        main[key][arm]["errors"] for arm in ("text", "closed", "self_cache")) for key, groups in summary["edge"].items()}
    result["edgeCases"] = {"passed": bool(errors) and not any(errors.values()), "errors": errors}
    return result


def build_summary(groups, receive, summaries, latent, rounds=BOOTSTRAP_ROUNDS):
    ROUNDS["n"] = rounds
    summary = {
        "items": {name: len(rows) for name, rows in groups.items()},
        "bootstrapRounds": rounds,
        "models": [model_row(data["model"]) for data in receive.values()],
        "main": main_section(groups, receive, summaries),
        "latent": latent_section(groups, receive, latent),
        "edge": edge_section(groups, receive),
    }
    order = list(receive)
    summary["latentTable"] = {sender: {receiver: latent_cell(summary, sender, receiver) for receiver in order}
                              for sender in order}
    summary["checks"] = checks(summary)
    return summary


def latent_cell(summary, sender, receiver):
    """What the latent table shows for a pair: a measured F1 or 'no mapper yet'."""
    status = latent_status(sender, receiver)
    if status == "self":
        return {"status": "self", "f1": summary["main"]["receivers"][sender]["self_cache"].get("f1")}
    if status == "mapper":
        pair = summary["latent"].get(f"{sender}>{receiver}")
        if pair and "skipped" not in pair:
            return {"status": "mapper", "f1": pair["arms"]["swat"].get("f1")}
        return {"status": "mapper_not_run"}
    return {"status": "none"}


# Markdown -----------------------------------------------------------------
def num(value, digits=3):
    return "—" if value is None else f"{value:.{digits}f}"


def interval(cell):
    return "—" if not cell else f"{cell['diff']:+.3f} [{cell['low']:+.3f}, {cell['high']:+.3f}]"


def size(value):
    if value is None:
        return "—"
    for unit, scale in (("MB", 1e6), ("kB", 1e3)):
        if value >= scale:
            return f"{value / scale:.1f} {unit}"
    return f"{value:.0f} B"


def table(header, rows):
    lines = ["| " + " | ".join(header) + " |", "| " + " | ".join("---" for _ in header) + " |"]
    lines += ["| " + " | ".join(str(cell) for cell in row) + " |" for row in rows]
    return "\n".join(lines)


def render_markdown(summary):
    main, order = summary["main"], [row["key"] for row in summary["models"]]
    parts = [f"Items: {summary['items']}"]
    parts.append("### Models\n\n" + table(
        ["Key", "Checkpoint", "Weights", "Licence", "Tokenizer", "Chat template", "System role",
         "KV shape (layers × KV heads × head dim)", "Cache per token", "Declared context"],
        [[m["key"], f"`{m['id']}`", m["weights"], m["licence"], m["tokenizer"], m["template"],
          "yes" if m["systemRole"] else "no", f"{m['layers']} × {m['kvHeads']} × {m['headDim']}",
          size(m["kvBytesPerToken"]), m["context"]] for m in summary["models"]]))
    rows = []
    for key in order:
        r = main["receivers"][key]
        text, closed, cache = r["text"], r["closed"], r["self_cache"]
        rows.append([key, f"{num(text.get('f1'))} / {num(text.get('em'))}", num(closed.get("f1")),
                     f"{num(cache.get('f1'))} / {num(cache.get('em'))}", interval(cache["vsText"]["f1"]),
                     num(cache.get("sameAnswer")), num(text.get("ms"), 0), num(cache.get("ms"), 0),
                     f"{num(cache.get('loadMs'), 0)} + {num(cache.get('answerMs'), 0)}",
                     size(text.get("bytes")), size(cache.get("bytes"))])
    parts.append("### Main set: reading the passage, and the same model's cache handed over\n\n" + table(
        ["Model", "`text` F1 / EM", "`closed` F1", "`self_cache` F1 / EM", "`self_cache` − `text` F1 (95%)",
         "Same answer", "`text` ms", "`self_cache` ms end to end", "of which load + answer",
         "`text` bytes", "`self_cache` bytes"], rows))
    parts.append("### Main set: `t2t` F1, sender's summary (rows) read by receiver (columns)\n\n" + table(
        ["Sender \\ receiver"] + order + ["Summary ms", "Summary bytes"],
        [[sender] + [num(main["t2t"].get(sender, {}).get(receiver, {}).get("f1")) for receiver in order]
         + [num(main["senders"].get(sender, {}).get("ms"), 0), size(main["senders"].get(sender, {}).get("bytes"))]
         for sender in order]))
    parts.append("### Main set: `t2t` − `text` F1 with paired 95% interval\n\n" + table(
        ["Sender \\ receiver"] + order,
        [[sender] + [interval((main["t2t"].get(sender, {}).get(receiver, {}).get("vsText") or {}).get("f1"))
                     for receiver in order] for sender in order]))
    parts.append("### Main set: `t2t` time end to end, ms (summary written, then read)\n\n" + table(
        ["Sender \\ receiver"] + order,
        [[sender] + [num(main["t2t"].get(sender, {}).get(receiver, {}).get("ms"), 0) for receiver in order]
         for sender in order]))

    def latent_text(cell):
        if cell["status"] == "self":
            return f"{num(cell['f1'])} (own cache, no mapper)"
        if cell["status"] == "mapper":
            return f"**{num(cell['f1'])}** (mapper)"
        return "mapper not run" if cell["status"] == "mapper_not_run" else NO_MAPPER

    parts.append("### Latent hand-over F1, sender (rows) to receiver (columns)\n\n" + table(
        ["Sender \\ receiver"] + order,
        [[sender] + [latent_text(summary["latentTable"][sender][receiver]) for receiver in order] for sender in order]))
    for name, pair in summary["latent"].items():
        if "skipped" in pair:
            parts.append(f"### Mapper pair {name}\n\nNot run: {pair['skipped']}")
            continue
        arms = pair["arms"]
        parts.append(f"### Mapper pair {name} (checkpoint `{pair['checkpoint']}`, {pair['card']})\n\n" + table(
            ["Arm", "F1", "EM", "Containment", "ms end to end", "Bytes handed over", "n", "Errors"],
            [[f"`{arm}`", num(a.get("f1")), num(a.get("em")), num(a.get("hit")), num(a.get("ms"), 0),
              size(a.get("bytes")) + (f" sender cache, {size(a['mappedBytes'])} mapped" if "mappedBytes" in a else ""),
              a["n"], a["errors"]] for arm, a in arms.items()]))
        parts.append(table(["Difference", "F1 (95%)", "EM (95%)"],
                           [[f"`{k}`", interval(v["f1"]), interval(v["em"])] for k, v in pair["intervals"].items()]))
        parts.append(table(["Edge group (answerable items)", "`text_m2b` hit", "`swat` hit", "`swat` F1", "Items", "Errors"],
                           [[group, num(e["text_m2b"].get("hit")), num(e["swat"].get("hit")), num(e["swat"].get("f1")),
                             e["items"], e["errors"]] for group, e in pair["edge"].items()]))
    edge = summary["edge"]

    def trio(cells, metric="f1"):
        return " / ".join(num(cells[arm].get(metric)) for arm in ("text", "self_cache", "t2t"))

    parts.append("### Edge cases (each cell: `text` / `self_cache` / `t2t` from the model's own summary)\n\n" + table(
        ["Model", "Long, answer first F1", "Long, answer last F1", "Kept of passage tokens", "Largest prompt",
         "One word hit", "Empty abstains", "Non-English and emoji hit", "Unanswerable abstains", "Control F1",
         "Control wrongly abstains", "Errors"],
        [[key, trio(e["long_passage"]["head"]), trio(e["long_passage"]["tail"]),
          f"{e['long_passage']['keptTokens']} of {e['long_passage']['passageTokens']}",
          e["long_passage"]["maxPromptTokens"], trio(e["tiny_passage"]["one_word"], "hit"),
          trio(e["tiny_passage"]["empty"]), trio(e["non_english_emoji"], "hit"),
          trio(e["unanswerable"]["unanswerable"]), trio(e["unanswerable"]["control"]),
          " / ".join(num(e["unanswerable"]["controlAbstained"][arm]) for arm in ("text", "self_cache", "t2t")),
          sum(e[group]["errors"] for group in e)] for key, e in edge.items()]))
    parts.append("### Edge case: a system instruction\n\n" + table(
        ["Model", "Template has a system role", "`text` F1 with the instruction", "Against the same items without it (95%)",
         "`self_cache` F1", "Same answer", "Errors"],
        [[key, "yes" if e["no_system_role"]["systemRole"] else "no (instruction opens the user turn)",
          num(e["no_system_role"]["text"].get("f1")), interval(e["no_system_role"]["vsPlain"]),
          num(e["no_system_role"]["self_cache"].get("f1")), num(e["no_system_role"]["sameAnswer"]),
          e["no_system_role"]["errors"]] for key, e in edge.items()]))
    parts.append("### Checks\n\n" + table(["Check", "Result", "Detail"], [
        [name, "Pass" if check["passed"] else "Fail",
         ", ".join(f"{k}: {v}" for k, v in check.items() if k != "passed")]
        for name, check in summary["checks"].items()]))
    return "\n\n".join(parts) + "\n"
