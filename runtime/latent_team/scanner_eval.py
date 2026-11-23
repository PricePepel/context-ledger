"""W2 eval 8: the gateway's secret scanner measured on a synthetic set (no gate).

    python -m latent_team.scanner_eval [--seed 0] [--count 100]

`count` texts each hold one fake credential in a known format at a random place in made-up
prose, and `count` texts hold look-alikes that are not credentials. Everything is generated
at run time from a seeded random source, so no file holds a credential-shaped string.
Reports recall (texts whose credential is fully covered by a finding) and the false-alarm
rate (look-alike texts with any finding). The scanner is the weak line: the gateway relies
on origin labels and declarations, and this number says how weak.
"""
import argparse
import json
import random
import string

from .secret_scan import find_secrets

WORDS = ("the", "build", "runs", "after", "we", "merge", "a", "plan", "for", "release", "notes", "on", "monday",
         "please", "check", "logs", "from", "staging", "and", "send", "summary", "to", "team", "with", "results")


def _chars(rng, alphabet, n):
    return "".join(rng.choice(alphabet) for _ in range(n))


def _mixed(rng, n):
    """Letters and digits, at least one of each."""
    while True:
        value = _chars(rng, string.ascii_letters + string.digits, n)
        if any(c.isalpha() for c in value) and any(c.isdigit() for c in value):
            return value


def credentials(rng):
    """(kind, maker) for every known format. Each maker builds a fresh fake value."""
    alnum = string.ascii_letters + string.digits
    b64url = alnum + "-_"
    pem = "PRIVATE" + " KEY"
    return [
        ("anthropic-key", lambda: "sk" + "-ant-" + "api03-" + _mixed(rng, 40)),
        ("github-token", lambda: "gh" + rng.choice("pousr") + "_" + _chars(rng, alnum, 36)),
        ("github-token", lambda: "github" + "_pat_" + _chars(rng, alnum + "_", 60)),
        ("aws-access-key-id", lambda: rng.choice(["AK", "AS"]) + "IA" + _chars(rng, string.ascii_uppercase + string.digits, 16)),
        ("slack-token", lambda: "xo" + "x" + rng.choice("abposr") + "-" + _chars(rng, string.digits, 10) + "-" + _mixed(rng, 24)),
        ("stripe-key", lambda: rng.choice(["sk", "rk"]) + "_" + rng.choice(["live", "test"]) + "_" + _mixed(rng, 24)),
        ("openai-key", lambda: "sk" + "-proj-" + _mixed(rng, 40)),
        ("jwt", lambda: "ey" + "J" + _chars(rng, b64url, 20) + ".ey" + "J" + _chars(rng, b64url, 30) + "." + _chars(rng, b64url, 30)),
        ("private-key", lambda: f"-----BEGIN RSA {pem}-----\n" + _chars(rng, alnum + "+/", 64) + "\n" + _chars(rng, alnum + "+/", 40)
         + f"\n-----END RSA {pem}-----"),
        ("aws-secret-access-key", lambda: "aws_secret_access_key = " + _chars(rng, alnum + "/+", 40)),
        ("assigned-secret", lambda: rng.choice(["password", "api_key", "client_secret", "auth_token"]) + "=" + _mixed(rng, 18)),
        ("bearer-token", lambda: "Authorization: Bearer " + _mixed(rng, 32)),
    ]


def look_alikes(rng):
    hexd = string.hexdigits.lower()[:16]
    return [
        lambda: "commit " + _chars(rng, hexd, 40),
        lambda: "sha256 " + _chars(rng, hexd, 64),
        lambda: "id " + "-".join(_chars(rng, hexd, n) for n in (8, 4, 4, 4, 12)),
        lambda: f"version v{rng.randint(0, 9)}.{rng.randint(0, 30)}.{rng.randint(0, 99)}-rc{rng.randint(1, 9)}",
        lambda: "pip install sk-" + rng.choice(["learn", "image", "video"]) + "-extras-" + rng.choice(["preview", "nightly"]),
        lambda: "blob " + _chars(rng, string.ascii_letters + string.digits + "+/", 48) + "==",
        lambda: "The password policy needs " + str(rng.randint(8, 20)) + " characters.",
        lambda: "token count was " + str(rng.randint(100, 9000)),
        lambda: "api_key: <your-key-here>",
        lambda: "password=${DB_PASSWORD}",
        lambda: "AKIA is the prefix of an AWS key id, " + _chars(rng, string.ascii_lowercase, 16),
        lambda: "secret santa is on " + rng.choice(["friday", "monday"]),
        lambda: "ghp_ is how a GitHub token starts",
        lambda: "eyJ" + _chars(rng, string.ascii_letters, 12) + " is not a token",
    ]


def prose(rng, n):
    return " ".join(rng.choice(WORDS) for _ in range(n))


def build(seed=0, count=100, layout="line"):
    rng = random.Random(seed)
    makers, decoys = credentials(rng), look_alikes(rng)
    positives = []
    for index in range(count):
        kind, make = makers[index % len(makers)]
        value = make()
        before, after = prose(rng, rng.randint(0, 12)), prose(rng, rng.randint(0, 12))
        joiner = rng.choice([" ", "\n", " : ", " ("])
        # As in real files: a free-text value runs to the end of its line (P4c reads the rest
        # of the line as the value) and a key block ends its own line; other formats sit
        # inside a sentence.
        own_line = kind in ("assigned-secret", "bearer-token", "private-key")
        lead = (before + ("\n" if kind == "private-key" else joiner)) if before else ""
        text = lead + value + ("\n" if own_line else rng.choice([" ", ". ", ")\n"])) + after
        positives.append({"kind": kind, "text": text, "value": value})
    # layout "line": look-alikes end their line too, as a stand-in such as <your-key-here> does
    # in a config. layout "sentence": prose follows on the same line, which P4c reads as part of
    # a free-text value, so a stand-in there is no longer only a stand-in.
    end = "\n" if layout == "line" else " "
    negatives = [{"text": prose(rng, rng.randint(0, 8)) + " " + decoys[i % len(decoys)]() + end + prose(rng, rng.randint(0, 8))}
                 for i in range(count)]
    return positives, negatives


def covered(text, value, findings):
    """The secret part of the value is inside one finding (a name or header before it may show)."""
    start = text.index(value)
    secret_start = start + (value.index("=") + 1 if "=" in value and value.count("=") >= 1 and " = " not in value
                            and not value.startswith("ey") else 0)
    if value.startswith("Authorization: Bearer "):
        secret_start = start + len("Authorization: Bearer ")
    if value.startswith("aws_secret_access_key = "):
        secret_start = start + len("aws_secret_access_key = ")
    end = start + len(value)
    return any(f["start"] <= secret_start and f["end"] >= end for f in findings)


def measure(seed=0, count=100, layout="line"):
    positives, negatives = build(seed, count, layout)
    found = [covered(p["text"], p["value"], find_secrets(p["text"])) for p in positives]
    alarms = [bool(find_secrets(n["text"])) for n in negatives]
    by_kind = {}
    for p, hit in zip(positives, found):
        stats = by_kind.setdefault(p["kind"], [0, 0])
        stats[0] += hit
        stats[1] += 1
    # A canary in no known format (random hex, as eval 7 declares) is not what a scanner can
    # find: that is what declarations are for.
    rng = random.Random(seed + 1)
    canaries = [prose(rng, 4) + " cnry" + _chars(rng, "0123456789abcdef", 32) + " " + prose(rng, 4) for _ in range(count)]
    unknown = sum(bool(find_secrets(text)) for text in canaries)
    return {"seed": seed, "layout": layout, "positives": count, "negatives": count,
            "recall": round(sum(found) / count, 4), "unknownFormatRecall": round(unknown / count, 4),
            "falseAlarmRate": round(sum(alarms) / count, 4), "falseAlarms": sum(alarms),
            "recallByKind": {k: f"{hit}/{n}" for k, (hit, n) in sorted(by_kind.items())}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--count", type=int, default=100)
    parser.add_argument("--layout", choices=("line", "sentence"), default="line")
    args = parser.parse_args()
    print(json.dumps(measure(args.seed, args.count, args.layout), indent=1))


if __name__ == "__main__":
    main()
