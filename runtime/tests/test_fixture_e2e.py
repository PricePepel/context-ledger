"""End to end on the real eval fixture (evals/latent) with a fake model.

The fake synthesizer answers each of the eight questions with a canned slice.
The slice goes through the whole service and is graded with a port of
evals/latent/grade.mjs.
"""

import json
import os
import unittest

from tests.helpers import FakeVllm, Service

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
EVALS = os.path.join(REPO, "evals", "latent")


def grade_slice(question, slice_):
    """Python port of gradeSlice in evals/latent/grade.mjs."""
    haystack = "\n".join([slice_["answer"], *(f["label"] for f in slice_.get("findings", []))]).lower()
    correct = all(any(option.lower() in haystack for option in group) for group in question["required"])
    spans = [span for finding in slice_.get("findings", []) for span in finding.get("evidence", [])]
    cited = any(
        span["path"] == ev["path"] and span["startLine"] <= ev["lines"][1] and span["endLine"] >= ev["lines"][0]
        for span in spans for ev in question["evidence"]
    )
    return {"id": question["id"], "correct": correct, "cited": cited}


def canned_slice(question):
    first = question["evidence"][0]
    facts = ", ".join(group[0] for group in question["required"])
    return {
        "answer": f"From the files: {facts}.",
        "findings": [{
            "label": f"Defined here: {facts}",
            "evidence": [{"path": first["path"], "startLine": first["lines"][0], "endLine": first["lines"][1]}],
        }],
    }


class FixtureEndToEndTest(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(EVALS, "questions.json"), encoding="utf-8") as handle:
            self.qa = json.load(handle)
        by_text = {q["question"]: canned_slice(q) for q in self.qa["questions"]}

        def synthesizer(body):
            user = body["messages"][1]["content"]
            question = user.split("\n")[1][len("Question: "):]
            return json.dumps(by_text[question])

        self.fake = FakeVllm(replies={"synthesizer": synthesizer})
        self.service = Service(self.fake.url, root=os.path.join(EVALS, "fixture"))

    def tearDown(self):
        self.service.close()
        self.fake.close()

    def test_all_questions_grade_correct_and_cited(self):
        results = []
        for question in self.qa["questions"]:
            status, payload = self.service.request("POST", "/latent/read", {
                "paths": self.qa["paths"], "question": question["question"], "budgetTokens": 600, "workers": 3,
            })
            self.assertEqual(status, 200, payload)
            graph = payload["graph"]
            self.assertEqual(graph["kind"], "latent-slice")
            self.assertEqual(payload["receipt"]["droppedFindings"], 0)
            self.assertLessEqual(payload["stats"]["sliceTokensEstimate"], payload["stats"]["prefixTokens"] * 0.1)
            results.append(grade_slice(question, graph))
        self.assertEqual(len(results), 8)
        self.assertTrue(all(r["correct"] and r["cited"] for r in results), results)
        # one prefix for every call of every read
        self.assertEqual(len(set(self.fake.systems())), 1)

    def test_grader_port_rejects_a_wrong_slice(self):
        question = self.qa["questions"][0]
        wrong = {"answer": "unknown", "findings": [
            {"label": "x", "evidence": [{"path": "src/notify.js", "startLine": 1, "endLine": 2}]}]}
        self.assertEqual(grade_slice(question, wrong), {"id": question["id"], "correct": False, "cited": False})


if __name__ == "__main__":
    unittest.main()
