from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import init_db
from app.learning import check_vocab_answer
from app.main import app
from app.schemas import (
    AnswerEvaluationOutput,
    GeneratedPracticeSet,
    GeneratedQuestion,
    GeneratedWorksheetOutput,
    GradedWorksheetItem,
    GradedWorksheetOutput,
    ParentReportOutput,
    ScanVocabOutput,
    ScannedVocabItem,
    WorksheetQuestion,
)


@pytest.fixture()
def client(tmp_path: Path):
    os.environ["DATA_DIR"] = str(tmp_path)
    os.environ["FAMILY_PASSWORD"] = "testpass"
    os.environ["PARENT_PIN"] = "4321"
    os.environ["GEMINI_API_KEY"] = "test-key"
    settings.reload()
    init_db()
    with TestClient(app) as tc:
        yield tc


def test_vocab_checker_french_accents_and_articles():
    # Exact match
    r1 = check_vocab_answer("l'école", "école", article="l'", typo_tolerance="moderate", accent_strict=False)
    assert r1["result"] == "correct"

    # Missing accent (relaxed -> almost + akzent tag)
    r2 = check_vocab_answer("l'ecole", "école", article="l'", typo_tolerance="moderate", accent_strict=False)
    assert r2["result"] == "almost"
    assert r2["error_tag"] == "akzent"

    # Missing accent (strict -> wrong + akzent tag)
    r3 = check_vocab_answer("l'ecole", "école", article="l'", typo_tolerance="moderate", accent_strict=True)
    assert r3["result"] == "wrong"
    assert r3["error_tag"] == "akzent"

    # Wrong article
    r4 = check_vocab_answer("la chien", "chien", article="le", typo_tolerance="moderate", accent_strict=False)
    assert r4["result"] == "wrong"
    assert r4["error_tag"] == "artikel"

    # Small typo in moderate mode
    r5 = check_vocab_answer("libary", "library", typo_tolerance="moderate")
    assert r5["result"] == "almost"
    assert r5["error_tag"] == "rechtschreibung"


def test_auth_and_seed_and_parent_pin(client: TestClient):
    # Unauthenticated request rejected
    assert client.get("/api/children").status_code == 401

    # Wrong password
    assert client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401

    # Correct login
    assert client.post("/api/auth/login", json={"password": "testpass"}).status_code == 200

    # Check seeded children & 6 subjects
    children = client.get("/api/children").json()["children"]
    assert len(children) == 2
    assert [c["age"] for c in children] == [8, 11]

    subjects = client.get("/api/subjects").json()["subjects"]
    names = {s["name"] for s in subjects}
    assert names == {"Mathe", "Deutsch", "Englisch", "Französisch", "Sachunterricht", "Biologie"}

    # Parent endpoint requires PIN
    assert client.get("/api/parent/overview").status_code == 403
    assert client.post("/api/auth/parent/unlock", json={"pin": "0000"}).status_code == 403
    assert client.post("/api/auth/parent/unlock", json={"pin": "4321"}).status_code == 200

    overview = client.get("/api/parent/overview").json()
    assert len(overview["children"]) == 2

    # Rename child & lock parent again
    cid = children[0]["id"]
    upd = client.patch(f"/api/children/{cid}", json={"name": "Max", "age": 8, "grade": "3a"})
    assert upd.status_code == 200
    assert upd.json()["child"]["name"] == "Max"

    client.post("/api/auth/parent/lock")
    assert client.get("/api/parent/overview").status_code == 403


def test_full_learning_workflow_vocab_practice_worksheet_grading(client: TestClient):
    client.post("/api/auth/login", json={"password": "testpass"})
    children = client.get("/api/children").json()["children"]
    older = children[1]  # 11-year-old
    subjects = {s["slug"]: s for s in client.get("/api/subjects").json()["subjects"]}
    fr_id = subjects["franzoesisch"]["id"]
    mathe_id = subjects["mathe"]["id"]

    # 1. Mocked photo scan for French vocab
    mock_scan = ScanVocabOutput(
        suggested_title="Unité 2 – À l'école",
        unit_name="Unité 2",
        extracted_markdown="l'école = die Schule",
        items=[
            ScannedVocabItem(term_foreign="école", term_german="die Schule", article="l'", hint="Akzent auf dem é"),
            ScannedVocabItem(term_foreign="chien", term_german="der Hund", article="le"),
        ],
    )
    with patch("app.main.scan_vocab_images", return_value=mock_scan):
        resp = client.post(
            f"/api/children/{older['id']}/scan",
            data={"subject_id": str(fr_id), "material_type": "vocab", "extra_note": "Seite 14"},
            files=[("files", ("page1.jpg", b"\xff\xd8\xff\xe0fakejpeg", "image/jpeg"))],
        )
        assert resp.status_code == 200
        scan_data = resp.json()
        assert len(scan_data["preview"]["items"]) == 2
        assert len(scan_data["image_paths"]) == 1

    # Commit scanned vocab
    commit = client.post(
        f"/api/children/{older['id']}/materials/commit",
        json={
            "subject_id": fr_id,
            "material_type": "vocab",
            "title": "Unité 2",
            "image_paths": scan_data["image_paths"],
            "extracted_markdown": "l'école = Schule",
            "unit_name": "Unité 2",
            "vocab_items": scan_data["preview"]["items"],
        },
    )
    assert commit.status_code == 200
    assert commit.json()["created_vocab"] == 2

    # Review vocab (2 wrong answers -> automatically logs weakness!)
    vocab_list = client.get(f"/api/children/{older['id']}/vocab?subject_id={fr_id}").json()["items"]
    ecole = next(v for v in vocab_list if v["term_foreign"] == "école")
    for _ in range(2):
        rv = client.post(
            f"/api/children/{older['id']}/vocab/review",
            json={"vocab_id": ecole["id"], "mode": "typing", "user_input": "falsch", "direction": "de_to_foreign"},
        )
        assert rv.status_code == 200
        assert rv.json()["outcome"] == "wrong"

    # 2. Create Math exam + topics
    ex_resp = client.post(
        f"/api/children/{older['id']}/exams",
        json={
            "subject_id": mathe_id,
            "title": "Klassenarbeit Brüche",
            "exam_date": "2026-12-05",
            "topics": [
                {"title": "Brüche erweitern", "description": "Zähler und Nenner multiplizieren"},
                {"title": "Brüche addieren", "description": "Gemeinsamen Nenner finden"},
            ],
        },
    )
    assert ex_resp.status_code == 200
    exam_id = ex_resp.json()["exam_id"]

    child_detail = client.get(f"/api/children/{older['id']}").json()
    exam = next(e for e in child_detail["exams"] if e["id"] == exam_id)
    topic_id = exam["topics"][0]["id"]

    # 3. Interactive Practice (mocked Gemini)
    mock_set = GeneratedPracticeSet(
        title="Bruch-Training",
        intro_message="Los geht's!",
        questions=[
            GeneratedQuestion(
                id="q1",
                topic_id=topic_id,
                topic_title="Brüche erweitern",
                question_type="math_step",
                prompt="Erweitere 2/3 mit 4.",
                hints=["Multipliziere Zähler und Nenner mit 4."],
                expected_answer="8/12",
                explanation="2*4=8 und 3*4=12.",
                points=2,
                targets_weakness=True,
            )
        ],
    )
    with patch("app.main.generate_interactive_practice", return_value=mock_set):
        gen = client.post(
            f"/api/children/{older['id']}/practice/generate",
            json={"subject_id": mathe_id, "exam_id": exam_id, "practice_style": "math_steps", "question_count": 4},
        )
        assert gen.status_code == 200
        assert gen.json()["questions"][0]["expected_answer"] == "8/12"

    mock_eval = AnswerEvaluationOutput(
        is_correct=False,
        partial_credit=True,
        score_ratio=0.5,
        feedback="Fast! Du hast nur den Zähler multipliziert.",
        weakness_summary="Multipliziert beim Erweitern nur den Zähler",
        weakness_example="2/3 mit 4 -> 8/3 statt 8/12",
        weakness_recommendation="Immer Zähler UND Nenner mit derselben Zahl malnehmen.",
    )
    with patch("app.main.evaluate_open_answer", return_value=mock_eval):
        ev = client.post(
            f"/api/children/{older['id']}/practice/evaluate",
            json={
                "subject_id": mathe_id,
                "exam_id": exam_id,
                "topic_id": topic_id,
                "question_type": "math_step",
                "prompt": "Erweitere 2/3 mit 4.",
                "expected_answer": "8/12",
                "user_answer": "8/3",
            },
        )
        assert ev.status_code == 200
        assert ev.json()["weakness_summary"]

    fin = client.post(
        f"/api/children/{older['id']}/practice/finish",
        json={
            "subject_id": mathe_id,
            "exam_id": exam_id,
            "mode": "exam_interactive",
            "score": 1,
            "max_score": 2,
            "topic_results": [{"topic_id": topic_id, "ratio": 0.5}],
            "detected_weaknesses": [
                {
                    "topic_id": topic_id,
                    "summary": mock_eval.weakness_summary,
                    "example_mistake": mock_eval.weakness_example,
                    "recommendation": mock_eval.weakness_recommendation,
                }
            ],
        },
    )
    assert fin.status_code == 200
    assert fin.json()["stars_earned"] >= 1

    # 4. Printable Worksheet Generation + Photo Handwriting Grading
    mock_ws = GeneratedWorksheetOutput(
        title="Förderblatt Brüche",
        instructions="Rechne sauber mit Rechenweg.",
        questions=[
            WorksheetQuestion(
                number=1,
                topic_id=topic_id,
                topic_title="Brüche erweitern",
                prompt="Erweitere 3/5 mit 3.",
                answer_space_lines=4,
                points=2,
                model_solution="3*3 / (5*3) = 9/15",
            )
        ],
    )
    with patch("app.main.generate_worksheet", return_value=mock_ws):
        ws_resp = client.post(
            f"/api/children/{older['id']}/worksheets/generate",
            json={"subject_id": mathe_id, "exam_id": exam_id, "focus_mode": "weaknesses", "question_count": 4},
        )
        assert ws_resp.status_code == 200
        ws = ws_resp.json()["worksheet"]
        assert ws["code"] == "AB-001"
        assert ws["paper_style"] == "grid"

    mock_graded = GradedWorksheetOutput(
        overall_feedback="Sehr ordentlich geschrieben!",
        praise="Prima Rechenweg!",
        total_points=2,
        max_points=2,
        items=[
            GradedWorksheetItem(
                number=1,
                topic_id=topic_id,
                transcribed_answer="9/15",
                points_awarded=2,
                max_points=2,
                status="correct",
                feedback="Perfekt erweitert!",
            )
        ],
    )
    with patch("app.main.grade_worksheet_photos", return_value=mock_graded):
        gr = client.post(
            f"/api/worksheets/{ws['id']}/grade",
            files=[("files", ("solved.jpg", b"\xff\xd8\xff\xe0solved", "image/jpeg"))],
        )
        assert gr.status_code == 200
        assert gr.json()["grading_result"]["total_points"] == 2

    # 5. Parent Dashboard & AI Report
    client.post("/api/auth/parent/unlock", json={"pin": "4321"})
    ov = client.get("/api/parent/overview").json()
    older_ov = next(x for x in ov["children"] if x["child"]["id"] == older["id"])
    assert older_ov["open_weaknesses_count"] >= 2  # vocab weakness + math weakness

    mock_report = ParentReportOutput(
        headline="Gute Fortschritte in Mathe & Französisch",
        overall_summary="Fleißig geübt!",
        strengths=["Saubere Rechenwege"],
        top_weaknesses=["Erweitern von Brüchen"],
        concrete_next_steps=["5 Minuten Brüche wiederholen"],
        motivation_tip="Kurze Runden loben!",
    )
    with patch("app.main.generate_parent_report", return_value=mock_report):
        rep = client.post(f"/api/parent/children/{older['id']}/report")
        assert rep.status_code == 200
        assert rep.json()["report"]["headline"] == "Gute Fortschritte in Mathe & Französisch"


def test_spa_and_static_assets_served(client: TestClient):
    for path in [
        "/",
        "/static/styles.css",
        "/static/app.js",
        "/static/views_child.js",
        "/static/views_print_parent.js",
        "/static/manifest.json",
    ]:
        r = client.get(path)
        assert r.status_code == 200, f"Failed for {path}"
        assert len(r.content) > 50


def test_child_self_profile_customization_without_parent_pin(client: TestClient):
    client.post("/api/auth/login", json={"password": "testpass"})
    children = client.get("/api/children").json()["children"]
    cid = children[0]["id"]

    # Without parent PIN, full parent PATCH must still be forbidden
    assert client.patch(f"/api/children/{cid}", json={"name": "Nope"}).status_code == 403

    # Child can update own name, age, and emoji avatar without parent PIN
    res = client.patch(
        f"/api/children/{cid}/profile",
        json={"name": "Leo", "age": 9, "avatar": "🦖"},
    )
    assert res.status_code == 200
    updated = res.json()["child"]
    assert updated["name"] == "Leo"
    assert updated["age"] == 9
    assert updated["avatar"] == "🦖"
    assert updated["avatar_image"] == ""

    # Invalid age rejected
    assert client.patch(f"/api/children/{cid}/profile", json={"age": 3}).status_code == 422

    # Child can upload a custom profile picture
    up = client.post(
        f"/api/children/{cid}/profile/avatar",
        files={"file": ("me.jpg", b"\xff\xd8\xff\xe0avatarjpeg", "image/jpeg")},
    )
    assert up.status_code == 200
    avatar_img = up.json()["child"]["avatar_image"]
    assert avatar_img.startswith(f"{cid}/")
    assert client.get(f"/api/uploads/{avatar_img}").status_code == 200

    # Switching back to an emoji clears the custom photo
    clr = client.patch(
        f"/api/children/{cid}/profile",
        json={"avatar": "🚀", "clear_avatar_image": True},
    )
    assert clr.status_code == 200
    assert clr.json()["child"]["avatar"] == "🚀"
    assert clr.json()["child"]["avatar_image"] == ""


def test_multipage_9_photos_batched_scan(client: TestClient):
    from app.ai import scan_exam_topic_images
    from app.schemas import ScanExamTopicOutput, ScannedTopic

    calls = []

    def fake_batch(child, subject, images, extra_note, batch_label):
        calls.append(len(images))
        return ScanExamTopicOutput(
            suggested_title="Sachunterricht Prüfung",
            extracted_markdown=f"- Inhalt aus {len(images)} Seiten",
            topics=[
                ScannedTopic(title=f"Thema Batch {len(calls)}", description="Kurzbeschreibung"),
                ScannedTopic(title="Gemeinsames Thema", description="Duplikat-Test"),
            ],
        )

    fake_images = [(b"img", "image/jpeg") for _ in range(9)]
    with patch("app.ai._scan_exam_topic_batch", side_effect=fake_batch):
        merged = scan_exam_topic_images(
            {"name": "Junior", "age": 8, "grade": "3. Klasse"},
            {"name": "Sachunterricht"},
            fake_images,
        )

    assert calls == [3, 3, 3]
    # 3 unique batch topics + 1 deduplicated common topic = 4 topics
    assert len(merged.topics) == 4
    assert "Seiten-Abschnitt 3" in merged.extracted_markdown

    # Also verify HTTP endpoint accepts all 9 files without capping at 8
    client.post("/api/auth/login", json={"password": "testpass"})
    children = client.get("/api/children").json()["children"]
    subjects = {s["slug"]: s for s in client.get("/api/subjects").json()["subjects"]}
    files = [("files", (f"p{i}.jpg", b"\xff\xd8\xff\xe0img", "image/jpeg")) for i in range(9)]
    with patch("app.main.scan_exam_topic_images", return_value=merged):
        r = client.post(
            f"/api/children/{children[0]['id']}/scan",
            data={"subject_id": str(subjects["sachunterricht"]["id"]), "material_type": "exam_topic"},
            files=files,
        )
        assert r.status_code == 200
        assert len(r.json()["image_paths"]) == 9


def test_ai_503_retry_and_fallback_to_secondary_model(client: TestClient):
    from types import SimpleNamespace
    from app.ai import _call_structured

    seen_models: list[str] = []

    class FakeModels:
        def generate_content(self, model, contents, config):
            seen_models.append(model)
            if model == "gemini-fast-busy":
                raise RuntimeError("503 UNAVAILABLE. This model is currently experiencing high demand.")
            return SimpleNamespace(
                parsed=ParentReportOutput(
                    headline="Fallback klappt",
                    overall_summary="OK",
                    strengths=["A"],
                    top_weaknesses=["B"],
                    concrete_next_steps=["C"],
                    motivation_tip="D",
                )
            )

    fake_client = SimpleNamespace(models=FakeModels())
    with (
        patch("app.ai._get_client", return_value=fake_client),
        patch("app.ai.get_active_models", return_value={"fast": "gemini-fast-busy", "smart": "gemini-smart-ok"}),
        patch("app.ai.time.sleep", return_value=None),
    ):
        res = _call_structured(["hello"], ParentReportOutput, "sys", tier="fast")

    assert res.headline == "Fallback klappt"
    # Retried primary once (2 attempts) then fell back cleanly to secondary model
    assert seen_models == ["gemini-fast-busy", "gemini-fast-busy", "gemini-smart-ok"]




