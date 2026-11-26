"""The question sets: one main set and five named edge-case groups. Standard library only.

An item is {id, group, passage, question, answers, answerable} plus group fields. The main
set and two groups come from SQuAD v1.1 validation rows (public); the other groups are
synthetic and written here. Builders take rows as arguments, so they run without the data.
"""
import random

GROUPS = ("main", "long_passage", "tiny_passage", "non_english_emoji", "unanswerable", "no_system_role")

MAIN_COUNT = 200
LONG_COUNT = 20
LONG_CHARS = 14000       # about 3,000 tokens: over the 2,048-token context the group runs at
UNANSWERABLE_COUNT = 20  # and as many answerable controls with the same prompt
SYSTEM_COUNT = 40

# Emoji are built from code points, so the source holds no format characters (the
# zero-width joiner and the variation selector are invisible in an editor).
ZWJ, VS16 = chr(0x200D), chr(0xFE0F)
FAMILY = chr(0x1F469) + ZWJ + chr(0x1F469) + ZWJ + chr(0x1F467)
SCIENTIST = chr(0x1F469) + ZWJ + chr(0x1F52C)
ROCKET, SUN, CHECK, RAIN = chr(0x1F680), chr(0x2600) + VS16, chr(0x2705), chr(0x1F327) + VS16
NOODLES, SUSHI, TEA, CLOCK, TARGET = chr(0x1F35C), chr(0x1F363), chr(0x1F375), chr(0x1F551), chr(0x1F3AF)
FLAG_JP, YEN = chr(0x1F1EF) + chr(0x1F1F5), chr(0xA5)

# One-word passages. The token count differs by tokenizer and is recorded with each run.
TINY = [
    ("Paris", "Which city does the passage name?"),
    ("1969", "Which year does the passage give?"),
    ("blue", "Which colour does the passage name?"),
    ("seven", "Which number does the passage give?"),
    ("Tokyo", "Which city does the passage name?"),
    ("Mars", "Which planet does the passage name?"),
]
EMPTY_QUESTIONS = [
    "Which city does the passage name?",
    "Which year does the passage give?",
    "Who wrote the report?",
    "How many ships were sent?",
]

# Synthetic passages: invented people, places and numbers, so no model knows the answers.
NON_ENGLISH = [
    ("ru", "Инженер Зарина Юлдашева перевезла архив из Самарканда в Нукус в 2019 году. "
           "В архиве было 412 коробок, и перевозка заняла девять дней.",
     "Сколько коробок было в архиве?", ["412"]),
    ("ru", "Команда Тимура Раджабова открыла мастерскую на улице Навои. "
           "Первым заказом стал ремонт колокола весом 86 килограммов для школы №14.",
     "Сколько весил колокол?", ["86", "86 килограммов"]),
    ("zh", "林月在2021年把图书馆从青岛搬到了兰州。搬运一共用了37辆卡车，负责人是周海。",
     "搬运一共用了多少辆卡车？", ["37"]),
    ("zh", "工程师周海设计的桥全长1280米，于三月在兰州通车。",
     "桥全长多少米？", ["1280"]),
    ("ja", "森田ハルカは2018年に札幌で小さなパン屋を開いた。店の名前は「こむぎ堂」で、初日は64個のパンが売れた。",
     "初日に何個のパンが売れましたか？", ["64"]),
    ("ar", "نقلت المهندسة ليلى الحداد المكتبة من طنجة إلى وجدة عام 2017. استغرقت الرحلة 11 يوما وشملت 530 صندوقا.",
     "كم صندوقا شملت الرحلة؟", ["530"]),
    ("hi", "अनीता वर्मा ने 2020 में जयपुर से भोपाल तक पुस्तकालय पहुँचाया। इस काम में 23 ट्रक लगे।",
     "इस काम में कितने ट्रक लगे?", ["23"]),
    ("uz", "Dilnoza Karimova 2016-yilda Xivadan Termizga 275 ta kitob olib keldi. Yo‘l olti kun davom etdi.",
     "Dilnoza nechta kitob olib keldi?", ["275"]),
    ("es", "El ingeniero Íñigo Ordóñez trasladó el archivo de Cádiz a Logroño en 2015. "
           "El traslado duró catorce días y costó 9.300 euros.",
     "¿Cuántos euros costó el traslado?", ["9.300", "9300", "9.300 euros"]),
    ("de", "Jörg Müßig eröffnete 2014 in Görlitz eine Werkstatt für Glocken. "
           "Die größte Glocke wog 748 Kilogramm und hängt heute in Zwönitz.",
     "Wie viel wog die größte Glocke?", ["748", "748 Kilogramm"]),
    ("emoji", f"Launch log {ROCKET}: the Kestrel-4 probe left pad 12 at 06:40 {SUN}. "
              f"Crew families {FAMILY} watched from deck C. Fuel check {CHECK}, weather {RAIN} cleared "
              f"after 25 minutes. Mission lead: Odile Tran {SCIENTIST}.",
     "From which pad did the probe leave?", ["12", "pad 12"]),
    ("emoji", f"Menu {NOODLES}{SUSHI}: ramen {YEN}880, sushi set {YEN}1,450, tea {TEA} free. "
              f"Chef: Mika {FLAG_JP}. Open 11{chr(0x2013)}22 {CLOCK}. Tip jar goal {TARGET}: 300 coins.",
     "What is the tip jar goal?", ["300 coins", "300"]),
]


def _item(group, index, passage, question, answers, answerable=True, **extra):
    return {"id": f"{group}-{index:03d}", "group": group, "passage": passage, "question": question,
            "answers": list(answers), "answerable": answerable, **extra}


def shuffled(rows, seed):
    rows = list(rows)
    random.Random(seed).shuffle(rows)
    return rows


def main_items(rows, fits, count=MAIN_COUNT):
    """The first `count` shuffled rows whose passage fits every model (`fits(passage)`).

    Returns (items, used): `used` is how many rows were consumed, so the edge groups can
    take theirs from the rows after it and never repeat a main question.
    """
    items = []
    for used, row in enumerate(rows, 1):
        if fits(row["context"].strip()):
            items.append(_item("main", len(items), row["context"].strip(), row["question"], row["answers"],
                               squadId=row["id"]))
            if len(items) == count:
                return items, used
    raise ValueError(f"Only {len(items)} of {count} main items fit every model.")


def long_items(rows, count=LONG_COUNT, chars=LONG_CHARS):
    """Passages longer than the context: the answer's paragraph first (even items) or last
    (odd items), padded with paragraphs from other articles up to `chars` characters."""
    items = []
    for index in range(count):
        target = rows[index]
        filler, size = [], len(target["context"])
        for other in rows[count + index * 40:]:
            if other["title"] == target["title"]:
                continue
            if other["context"].strip() in filler:
                continue  # SQuAD asks several questions per paragraph
            filler.append(other["context"].strip())
            size += len(filler[-1]) + 2
            if size >= chars:
                break
        if size < chars:
            raise ValueError("Not enough rows to build a long passage.")
        place = "head" if index % 2 == 0 else "tail"
        parts = [target["context"].strip()] + filler if place == "head" else filler + [target["context"].strip()]
        items.append(_item("long_passage", index, "\n\n".join(parts), target["question"], target["answers"],
                           answerAt=place, squadId=target["id"]))
    return items


def tiny_items():
    """A passage of one word (answerable) and an empty passage (the right reply is to abstain)."""
    items = [_item("tiny_passage", i, word, question, [word], kind="one_word") for i, (word, question) in enumerate(TINY)]
    for question in EMPTY_QUESTIONS:
        items.append(_item("tiny_passage", len(items), "", question, [], answerable=False, kind="empty"))
    return items


def non_english_items():
    return [_item("non_english_emoji", i, passage, question, answers, language=language)
            for i, (language, passage, question, answers) in enumerate(NON_ENGLISH)]


def unanswerable_items(rows, count=UNANSWERABLE_COUNT):
    """`count` questions paired with a passage from another article (unanswerable), then
    `count` ordinary rows as controls. Both halves get the same abstain instruction."""
    items = []
    for index in range(count):
        row = rows[index]
        other = next(r for r in rows[count * 2:] if r["title"] != row["title"]
                     and not any(answer.lower() in r["context"].lower() for answer in row["answers"]))
        items.append(_item("unanswerable", index, other["context"].strip(), row["question"], [], answerable=False,
                           squadId=row["id"]))
    for row in rows[count:count * 2]:
        items.append(_item("unanswerable", len(items), row["context"].strip(), row["question"], row["answers"],
                           squadId=row["id"]))
    return items


def system_items(main, count=SYSTEM_COUNT):
    """The first main items again, asked with a system instruction."""
    return [{**item, "id": f"no_system_role-{index:03d}", "group": "no_system_role", "mainId": item["id"]}
            for index, item in enumerate(main[:count])]


def uses_abstain(item):
    """Groups whose prompt carries the abstain instruction."""
    return item["group"] in ("tiny_passage", "unanswerable")


def build(rows, fits, seed=0):
    """Every group, from SQuAD validation rows and a `fits(passage)` test."""
    rows = shuffled(rows, seed)
    main, used = main_items(rows, fits)
    rest = [row for row in rows[used:] if fits(row["context"].strip())]
    return {
        "main": main,
        "long_passage": long_items(rest),
        "tiny_passage": tiny_items(),
        "non_english_emoji": non_english_items(),
        "unanswerable": unanswerable_items(rest[2000:]),
        "no_system_role": system_items(main),
    }
