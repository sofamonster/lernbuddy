from __future__ import annotations

import json
import logging
import re
import secrets
import time
import unicodedata
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.ai import (
    AIConfigError,
    AIServiceError,
    evaluate_open_answer,
    generate_interactive_practice,
    generate_parent_report,
    generate_worksheet,
    get_active_models,
    grade_worksheet_photos,
    list_available_models,
    scan_exam_topic_images,
    scan_vocab_images,
    test_model_connectivity,
)
from app.auth import (
    clear_family_cookie,
    clear_parent_cookie,
    is_family_authenticated,
    is_parent_authenticated,
    require_family,
    require_parent,
    set_family_cookie,
    set_parent_cookie,
    verify_family_password,
    verify_parent_pin,
)
from app.config import settings
from app.db import db_session, init_db, set_app_setting, utc_now_iso
from app.learning import (
    award_stars_and_streak,
    check_vocab_answer,
    compute_exam_readiness,
    record_weakness,
    select_adaptive_topics,
    update_topic_mastery,
    update_vocab_leitner,
)
from app.schemas import (
    AISettingsUpdateRequest,
    ChildSelfProfileUpdateRequest,
    ChildSubjectsUpdateRequest,
    ChildUpdateRequest,
    ExamCreateRequest,
    ExamUpdateRequest,
    FamilyLoginRequest,
    MaterialCommitRequest,
    ParentUnlockRequest,
    PracticeEvaluateAnswerRequest,
    PracticeFinishRequest,
    PracticeGenerateRequest,
    SubjectCreateRequest,
    TopicCreateRequest,
    TopicUpdateRequest,
    VocabBulkCreateRequest,
    VocabReviewRequest,
    WeaknessUpdateRequest,
    WorksheetGenerateRequest,
)

STATIC_DIR = Path(__file__).resolve().parent / "static"
ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
}
MAX_IMAGE_BYTES = 12 * 1024 * 1024  # 12 MB per image
MAX_UPLOAD_FILES = 20
logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="LernBuddy", version="1.0.0", lifespan=lifespan)
ASSET_VERSION = str(int(time.time()))


@app.middleware("http")
async def disable_static_cache(request: Request, call_next):
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


@app.exception_handler(AIConfigError)
async def ai_config_error_handler(_request: Request, exc: AIConfigError):
    return JSONResponse(status_code=503, content={"detail": str(exc), "error_code": "AI_CONFIG_MISSING"})


@app.exception_handler(AIServiceError)
async def ai_service_error_handler(_request: Request, exc: AIServiceError):
    return JSONResponse(status_code=502, content={"detail": str(exc), "error_code": "AI_SERVICE_ERROR"})


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ============================================================
# Helpers
# ============================================================

def _get_child_or_404(conn, child_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM children WHERE id = ?", (child_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Kind nicht gefunden.")
    data = dict(row)
    data["settings"] = json.loads(data.get("settings_json") or "{}")
    return data


def _get_subject_or_404(conn, subject_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM subjects WHERE id = ?", (subject_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Fach nicht gefunden.")
    return dict(row)


async def _save_uploaded_images(child_id: int, files: list[UploadFile]) -> tuple[list[str], list[tuple[bytes, str]]]:
    if not files:
        raise HTTPException(status_code=400, detail="Bitte mindestens ein Foto auswählen.")
    child_dir = settings.uploads_dir / str(child_id)
    child_dir.mkdir(parents=True, exist_ok=True)

    saved_rel_paths: list[str] = []
    image_blobs: list[tuple[bytes, str]] = []

    for f in files[:MAX_UPLOAD_FILES]:
        content_type = (f.content_type or "image/jpeg").lower()
        ext = ALLOWED_IMAGE_TYPES.get(content_type, ".jpg")
        if content_type not in ALLOWED_IMAGE_TYPES:
            content_type = "image/jpeg"
        data = await f.read()
        if not data:
            continue
        if len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail="Ein Foto ist größer als 12 MB.")
        filename = f"{secrets.token_hex(8)}{ext}"
        dest = child_dir / filename
        dest.write_bytes(data)
        saved_rel_paths.append(f"{child_id}/{filename}")
        image_blobs.append((data, content_type))

    if not image_blobs:
        raise HTTPException(status_code=400, detail="Die hochgeladenen Dateien waren leer.")
    return saved_rel_paths, image_blobs


def _slugify_subject(name: str) -> str:
    s = name.strip().lower()
    for src, dst in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        s = s.replace(src, dst)
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or f"fach-{secrets.token_hex(3)}"


def _build_child_parent_summary(conn, child: dict[str, Any], include_archived: bool = False) -> dict[str, Any]:
    cid = child["id"]
    now = utc_now_iso()

    subjects = [
        dict(r)
        for r in conn.execute(
            """
            SELECT s.*, cs.enabled
            FROM subjects s
            JOIN child_subjects cs ON cs.subject_id = s.id
            WHERE cs.child_id = ?
            ORDER BY s.sort_order, s.id
            """,
            (cid,),
        ).fetchall()
    ]

    exam_where = "e.child_id = ?" if include_archived else "e.child_id = ? AND e.archived = 0"
    exams_raw = [
        dict(r)
        for r in conn.execute(
            f"""
            SELECT e.*, s.name AS subject_name, s.icon AS subject_icon, s.color AS subject_color
            FROM exams e
            JOIN subjects s ON s.id = e.subject_id
            WHERE {exam_where}
            ORDER BY e.archived ASC,
                     CASE WHEN e.status = 'active' THEN 0 ELSE 1 END,
                     COALESCE(e.exam_date, '9999-12-31') ASC,
                     e.id DESC
            """,
            (cid,),
        ).fetchall()
    ]

    exams = []
    active_exams_count = 0
    archived_exams_count = 0
    for ex in exams_raw:
        ex["archived"] = bool(ex.get("archived", 0))
        topic_where = "exam_id = ?" if include_archived else "exam_id = ? AND archived = 0"
        topics = [
            dict(t)
            for t in conn.execute(
                f"SELECT * FROM topics WHERE {topic_where} ORDER BY archived ASC, mastery_score ASC, id ASC",
                (ex["id"],),
            ).fetchall()
        ]
        for t in topics:
            t["archived"] = bool(t.get("archived", 0))
            t["key_concepts"] = json.loads(t.get("key_concepts_json") or "[]")

        active_topics = [t for t in topics if not t["archived"]]
        ex["active_topics_count"] = len(active_topics)
        ex["archived_topics_count"] = len(topics) - len(active_topics)

        open_w_count = conn.execute(
            """
            SELECT COUNT(*) FROM weaknesses w
            LEFT JOIN topics t ON t.id = w.topic_id
            LEFT JOIN exams e ON e.id = t.exam_id
            WHERE w.child_id = ? AND w.subject_id = ? AND w.resolved = 0
              AND (w.topic_id IS NULL OR (COALESCE(t.archived, 0) = 0 AND COALESCE(e.archived, 0) = 0))
            """,
            (cid, ex["subject_id"]),
        ).fetchone()[0]

        ex["topics"] = topics
        if ex["archived"]:
            archived_exams_count += 1
            ex["readiness"] = {
                "avg_mastery": 0,
                "effective_score": 0,
                "days_left": None,
                "traffic_light": "yellow",
                "label": "Archiviert",
            }
        else:
            if ex["status"] == "active":
                active_exams_count += 1
            # Readiness & averages ONLY count non-archived topics!
            ex["readiness"] = compute_exam_readiness(ex, active_topics, open_w_count)
        exams.append(ex)

    weaknesses = [
        dict(r)
        for r in conn.execute(
            """
            SELECT w.*, s.name AS subject_name, s.icon AS subject_icon, s.color AS subject_color
            FROM weaknesses w
            JOIN subjects s ON s.id = w.subject_id
            LEFT JOIN topics t ON t.id = w.topic_id
            LEFT JOIN exams e ON e.id = t.exam_id
            WHERE w.child_id = ?
              AND (w.topic_id IS NULL OR (COALESCE(t.archived, 0) = 0 AND COALESCE(e.archived, 0) = 0))
            ORDER BY w.resolved ASC, w.severity DESC, w.occurrences DESC, w.last_seen_at DESC
            LIMIT 60
            """,
            (cid,),
        ).fetchall()
    ]

    vocab_boxes = {str(b): 0 for b in range(1, 6)}
    for r in conn.execute(
        "SELECT box, COUNT(*) AS cnt FROM vocab_items WHERE child_id = ? GROUP BY box", (cid,)
    ).fetchall():
        vocab_boxes[str(r["box"])] = int(r["cnt"])
    vocab_total = sum(vocab_boxes.values())
    vocab_due = conn.execute(
        "SELECT COUNT(*) FROM vocab_items WHERE child_id = ? AND next_review_at <= ?", (cid, now)
    ).fetchone()[0]

    problem_vocab = [
        dict(r)
        for r in conn.execute(
            """
            SELECT v.*, s.name AS subject_name, s.icon AS subject_icon
            FROM vocab_items v
            JOIN subjects s ON s.id = v.subject_id
            WHERE v.child_id = ? AND v.wrong_count > 0
            ORDER BY v.wrong_count DESC, v.box ASC
            LIMIT 8
            """,
            (cid,),
        ).fetchall()
    ]
    for pv in problem_vocab:
        pv["error_tags"] = json.loads(pv.get("error_tags_json") or "[]")

    recent_sessions = [
        dict(r)
        for r in conn.execute(
            """
            SELECT p.*, s.name AS subject_name, s.icon AS subject_icon
            FROM practice_sessions p
            JOIN subjects s ON s.id = p.subject_id
            LEFT JOIN exams e ON e.id = p.exam_id
            WHERE p.child_id = ? AND COALESCE(e.archived, 0) = 0
            ORDER BY p.created_at DESC
            LIMIT 12
            """,
            (cid,),
        ).fetchall()
    ]
    for rs in recent_sessions:
        rs["summary"] = json.loads(rs.get("summary_json") or "{}")

    recent_worksheets = [
        dict(r)
        for r in conn.execute(
            """
            SELECT w.id, w.code, w.title, w.subject_id, w.exam_id, w.duration_minutes,
                   w.score, w.max_score, w.created_at, w.graded_at,
                   s.name AS subject_name, s.icon AS subject_icon
            FROM worksheets w
            JOIN subjects s ON s.id = w.subject_id
            LEFT JOIN exams e ON e.id = w.exam_id
            WHERE w.child_id = ? AND COALESCE(e.archived, 0) = 0
            ORDER BY w.created_at DESC
            LIMIT 10
            """,
            (cid,),
        ).fetchall()
    ]

    return {
        "child": child,
        "subjects": subjects,
        "exams": exams,
        "active_exams_count": active_exams_count,
        "archived_exams_count": archived_exams_count,
        "weaknesses": weaknesses,
        "open_weaknesses_count": sum(1 for w in weaknesses if not w["resolved"]),
        "vocab": {
            "total": vocab_total,
            "due": int(vocab_due),
            "boxes": vocab_boxes,
            "problem_words": problem_vocab,
        },
        "recent_sessions": recent_sessions,
        "recent_worksheets": recent_worksheets,
    }


def _next_worksheet_code(conn) -> str:
    row = conn.execute("SELECT MAX(id) AS max_id FROM worksheets").fetchone()
    next_num = int(row["max_id"] or 0) + 1
    return f"AB-{next_num:03d}"


# ============================================================
# Health & Auth Endpoints
# ============================================================

@app.get("/api/health")
def health():
    return {"ok": True, "version": "1.8", "asset_version": ASSET_VERSION}


@app.get("/api/auth/status")
def auth_status(request: Request):
    return {
        "authenticated": is_family_authenticated(request),
        "parent_unlocked": is_parent_authenticated(request),
        "has_gemini_key": settings.has_gemini_key,
        "using_default_credentials": settings.using_default_credentials,
    }


@app.post("/api/auth/login")
def family_login(payload: FamilyLoginRequest, response: Response):
    if not verify_family_password(payload.password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Falsches Familien-Passwort.")
    set_family_cookie(response, remember=payload.remember)
    return {"ok": True}


@app.post("/api/auth/logout")
def family_logout(response: Response):
    clear_family_cookie(response)
    return {"ok": True}


@app.post("/api/auth/parent/unlock", dependencies=[Depends(require_family)])
def parent_unlock(payload: ParentUnlockRequest, response: Response):
    if not verify_parent_pin(payload.pin):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Falsche Eltern-PIN.")
    set_parent_cookie(response)
    return {"ok": True}


@app.post("/api/auth/parent/lock", dependencies=[Depends(require_family)])
def parent_lock(response: Response):
    clear_parent_cookie(response)
    return {"ok": True}


# ============================================================
# Protected Uploads Serving
# ============================================================

@app.get("/api/uploads/{child_id}/{filename}", dependencies=[Depends(require_family)])
def get_uploaded_image(child_id: int, filename: str):
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Ungültiger Dateiname.")
    file_path = (settings.uploads_dir / str(child_id) / filename).resolve()
    allowed_root = (settings.uploads_dir / str(child_id)).resolve()
    if not str(file_path).startswith(str(allowed_root)) or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Bild nicht gefunden.")
    return FileResponse(str(file_path))


# ============================================================
# Children & Subjects
# ============================================================

@app.get("/api/subjects", dependencies=[Depends(require_family)])
def list_subjects():
    with db_session() as conn:
        rows = conn.execute("SELECT * FROM subjects ORDER BY sort_order").fetchall()
        return {"subjects": [dict(r) for r in rows]}


@app.get("/api/children", dependencies=[Depends(require_family)])
def list_children():
    now = utc_now_iso()
    with db_session() as conn:
        rows = conn.execute("SELECT * FROM children ORDER BY age ASC, id ASC").fetchall()
        result = []
        for row in rows:
            c = dict(row)
            c["settings"] = json.loads(c.get("settings_json") or "{}")
            due_vocab = conn.execute(
                "SELECT COUNT(*) FROM vocab_items WHERE child_id = ? AND next_review_at <= ?",
                (c["id"], now),
            ).fetchone()[0]
            active_exams = conn.execute(
                "SELECT COUNT(*) FROM exams WHERE child_id = ? AND status = 'active' AND archived = 0",
                (c["id"],),
            ).fetchone()[0]
            open_weaknesses = conn.execute(
                """
                SELECT COUNT(*) FROM weaknesses w
                LEFT JOIN topics t ON t.id = w.topic_id
                LEFT JOIN exams e ON e.id = t.exam_id
                WHERE w.child_id = ? AND w.resolved = 0
                  AND (w.topic_id IS NULL OR (COALESCE(t.archived, 0) = 0 AND COALESCE(e.archived, 0) = 0))
                """,
                (c["id"],),
            ).fetchone()[0]
            c["stats"] = {
                "due_vocab": int(due_vocab),
                "active_exams": int(active_exams),
                "open_weaknesses": int(open_weaknesses),
            }
            result.append(c)
        return {"children": result}


@app.get("/api/children/{child_id}", dependencies=[Depends(require_family)])
def get_child_detail(child_id: int):
    with db_session() as conn:
        child = _get_child_or_404(conn, child_id)
        return _build_child_parent_summary(conn, child)


@app.patch("/api/children/{child_id}/profile", dependencies=[Depends(require_family)])
def update_child_self_profile(child_id: int, payload: ChildSelfProfileUpdateRequest):
    """Allows a child to customize their own name, age, and emoji avatar without Parent PIN."""
    with db_session() as conn:
        child = _get_child_or_404(conn, child_id)
        new_name = payload.name.strip() if payload.name is not None else child["name"]
        if not new_name:
            raise HTTPException(status_code=400, detail="Bitte gib einen Namen ein.")
        new_age = payload.age if payload.age is not None else child["age"]
        new_avatar = payload.avatar.strip() if payload.avatar is not None else child["avatar"]
        new_avatar_img = "" if payload.clear_avatar_image else child.get("avatar_image", "")
        conn.execute(
            """
            UPDATE children
            SET name = ?, age = ?, avatar = ?, avatar_image = ?
            WHERE id = ?
            """,
            (new_name, new_age, new_avatar or child["avatar"], new_avatar_img, child_id),
        )
        return {"child": _get_child_or_404(conn, child_id)}


@app.post("/api/children/{child_id}/profile/avatar", dependencies=[Depends(require_family)])
async def upload_child_avatar(child_id: int, file: UploadFile = File(...)):
    """Allows a child to upload a custom profile picture."""
    with db_session() as conn:
        _get_child_or_404(conn, child_id)

    rel_paths, _ = await _save_uploaded_images(child_id, [file])
    avatar_rel = rel_paths[0]
    with db_session() as conn:
        conn.execute("UPDATE children SET avatar_image = ? WHERE id = ?", (avatar_rel, child_id))
        return {"child": _get_child_or_404(conn, child_id)}


@app.patch("/api/children/{child_id}", dependencies=[Depends(require_parent)])
def update_child(child_id: int, payload: ChildUpdateRequest):
    with db_session() as conn:
        child = _get_child_or_404(conn, child_id)
        new_settings = dict(child["settings"])
        if payload.settings:
            new_settings.update(payload.settings)
        new_avatar_img = "" if payload.clear_avatar_image else child.get("avatar_image", "")
        conn.execute(
            """
            UPDATE children
            SET name = ?, age = ?, grade = ?, avatar = ?, avatar_image = ?, ui_mode = ?, settings_json = ?
            WHERE id = ?
            """,
            (
                payload.name.strip() if payload.name else child["name"],
                payload.age if payload.age is not None else child["age"],
                payload.grade.strip() if payload.grade else child["grade"],
                payload.avatar.strip() if payload.avatar else child["avatar"],
                new_avatar_img,
                payload.ui_mode or child["ui_mode"],
                json.dumps(new_settings, ensure_ascii=False),
                child_id,
            ),
        )
        return {"child": _get_child_or_404(conn, child_id)}


@app.put("/api/children/{child_id}/subjects", dependencies=[Depends(require_parent)])
def update_child_subjects(child_id: int, payload: ChildSubjectsUpdateRequest):
    with db_session() as conn:
        _get_child_or_404(conn, child_id)
        all_subs = [r["id"] for r in conn.execute("SELECT id FROM subjects").fetchall()]
        enabled_set = set(payload.enabled_subject_ids)
        for sid in all_subs:
            conn.execute(
                """
                INSERT INTO child_subjects (child_id, subject_id, enabled)
                VALUES (?, ?, ?)
                ON CONFLICT(child_id, subject_id) DO UPDATE SET enabled = excluded.enabled
                """,
                (child_id, sid, 1 if sid in enabled_set else 0),
            )
        return {"ok": True}


# ============================================================
# Photo Scanner & Materials
# ============================================================

@app.post("/api/children/{child_id}/scan", dependencies=[Depends(require_family)])
async def scan_material_photos(
    child_id: int,
    subject_id: int = Form(...),
    material_type: str = Form(...),
    extra_note: str = Form(""),
    files: list[UploadFile] = File(...),
):
    if material_type not in ("vocab", "exam_topic"):
        raise HTTPException(status_code=400, detail="Ungültiger Scan-Typ.")
    with db_session() as conn:
        child = _get_child_or_404(conn, child_id)
        subject = _get_subject_or_404(conn, subject_id)

    rel_paths, image_blobs = await _save_uploaded_images(child_id, files)
    logger.info(
        "[LernBuddy] Foto-Scan gestartet: %d Foto(s), Typ=%s, Kind=%s, Fach=%s",
        len(image_blobs),
        material_type,
        child["name"],
        subject["name"],
    )

    if material_type == "vocab":
        parsed = await run_in_threadpool(scan_vocab_images, child, subject, image_blobs, extra_note)
        return {
            "material_type": "vocab",
            "image_paths": rel_paths,
            "preview": parsed.model_dump(),
        }
    else:
        parsed = await run_in_threadpool(scan_exam_topic_images, child, subject, image_blobs, extra_note)
        return {
            "material_type": "exam_topic",
            "image_paths": rel_paths,
            "preview": parsed.model_dump(),
        }


@app.post("/api/children/{child_id}/materials/commit", dependencies=[Depends(require_family)])
def commit_scanned_material(child_id: int, payload: MaterialCommitRequest):
    now = utc_now_iso()
    with db_session() as conn:
        _get_child_or_404(conn, child_id)
        _get_subject_or_404(conn, payload.subject_id)

        exam_id = payload.exam_id
        if payload.material_type == "exam_topic" and not exam_id:
            exam_title = (payload.new_exam_title or payload.title or "Neue Prüfung").strip()
            cur_ex = conn.execute(
                """
                INSERT INTO exams (child_id, subject_id, title, exam_date, status, created_at)
                VALUES (?, ?, ?, ?, 'active', ?)
                """,
                (child_id, payload.subject_id, exam_title, payload.new_exam_date, now),
            )
            exam_id = int(cur_ex.lastrowid)

        cur_mat = conn.execute(
            """
            INSERT INTO materials
                (child_id, subject_id, exam_id, material_type, title, image_paths_json, extracted_markdown, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                child_id,
                payload.subject_id,
                exam_id,
                payload.material_type,
                payload.title.strip() or "Gescanntes Material",
                json.dumps(payload.image_paths),
                payload.extracted_markdown,
                now,
            ),
        )
        material_id = int(cur_mat.lastrowid)

        created_vocab = 0
        created_topics = 0

        if payload.material_type == "vocab":
            for item in payload.vocab_items:
                if not item.term_foreign.strip() or not item.term_german.strip():
                    continue
                conn.execute(
                    """
                    INSERT INTO vocab_items
                        (child_id, subject_id, material_id, unit_name, term_foreign, term_german,
                         article, example_sentence, hint, box, next_review_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                    """,
                    (
                        child_id,
                        payload.subject_id,
                        material_id,
                        (item.unit_name or payload.unit_name or "Scan").strip(),
                        item.term_foreign.strip(),
                        item.term_german.strip(),
                        item.article.strip(),
                        item.example_sentence.strip(),
                        item.hint.strip(),
                        now,
                        now,
                    ),
                )
                created_vocab += 1
        else:
            for t in payload.topics:
                if not t.title.strip():
                    continue
                conn.execute(
                    """
                    INSERT INTO topics
                        (exam_id, title, description, key_concepts_json, mastery_score, created_at)
                    VALUES (?, ?, ?, ?, 25, ?)
                    """,
                    (
                        exam_id,
                        t.title.strip(),
                        t.description.strip(),
                        json.dumps(t.key_concepts, ensure_ascii=False),
                        now,
                    ),
                )
                created_topics += 1

        return {
            "ok": True,
            "material_id": material_id,
            "exam_id": exam_id,
            "created_vocab": created_vocab,
            "created_topics": created_topics,
        }


@app.get("/api/children/{child_id}/materials", dependencies=[Depends(require_family)])
def list_materials(child_id: int, subject_id: int | None = None):
    with db_session() as conn:
        _get_child_or_404(conn, child_id)
        if subject_id:
            rows = conn.execute(
                """
                SELECT m.*, s.name AS subject_name, s.icon AS subject_icon
                FROM materials m JOIN subjects s ON s.id = m.subject_id
                WHERE m.child_id = ? AND m.subject_id = ?
                ORDER BY m.created_at DESC
                """,
                (child_id, subject_id),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT m.*, s.name AS subject_name, s.icon AS subject_icon
                FROM materials m JOIN subjects s ON s.id = m.subject_id
                WHERE m.child_id = ?
                ORDER BY m.created_at DESC
                """,
                (child_id,),
            ).fetchall()
        items = []
        for r in rows:
            d = dict(r)
            d["image_paths"] = json.loads(d.get("image_paths_json") or "[]")
            items.append(d)
        return {"materials": items}


@app.delete("/api/materials/{material_id}", dependencies=[Depends(require_parent)])
def delete_material(material_id: int):
    with db_session() as conn:
        row = conn.execute("SELECT id FROM materials WHERE id = ?", (material_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Material nicht gefunden.")
        conn.execute("DELETE FROM materials WHERE id = ?", (material_id,))
        return {"ok": True}


# ============================================================
# Vocabulary Trainer (Leitner)
# ============================================================

@app.get("/api/children/{child_id}/vocab", dependencies=[Depends(require_family)])
def list_vocab(
    child_id: int,
    subject_id: int | None = None,
    unit_name: str | None = None,
    due_only: bool = False,
):
    now = utc_now_iso()
    with db_session() as conn:
        _get_child_or_404(conn, child_id)
        clauses = ["v.child_id = ?"]
        params: list[Any] = [child_id]
        if subject_id:
            clauses.append("v.subject_id = ?")
            params.append(subject_id)
        if unit_name:
            clauses.append("v.unit_name = ?")
            params.append(unit_name)
        if due_only:
            clauses.append("v.next_review_at <= ?")
            params.append(now)

        where_sql = " AND ".join(clauses)
        rows = conn.execute(
            f"""
            SELECT v.*, s.name AS subject_name, s.lang_code, s.slug AS subject_slug
            FROM vocab_items v
            JOIN subjects s ON s.id = v.subject_id
            WHERE {where_sql}
            ORDER BY CASE WHEN v.next_review_at <= ? THEN 0 ELSE 1 END,
                     v.box ASC, v.wrong_count DESC, v.id DESC
            """,
            [*params, now],
        ).fetchall()

        items = []
        box_counts = {str(b): 0 for b in range(1, 6)}
        due_count = 0
        units = set()
        for r in rows:
            d = dict(r)
            d["error_tags"] = json.loads(d.get("error_tags_json") or "[]")
            d["is_due"] = d["next_review_at"] <= now
            if d["is_due"]:
                due_count += 1
            box_counts[str(d["box"])] = box_counts.get(str(d["box"]), 0) + 1
            units.add(d["unit_name"])
            items.append(d)

        return {
            "items": items,
            "total": len(items),
            "due_count": due_count,
            "box_counts": box_counts,
            "units": sorted(units),
        }


@app.post("/api/children/{child_id}/vocab/bulk", dependencies=[Depends(require_family)])
def add_vocab_bulk(child_id: int, payload: VocabBulkCreateRequest):
    now = utc_now_iso()
    with db_session() as conn:
        _get_child_or_404(conn, child_id)
        _get_subject_or_404(conn, payload.subject_id)
        count = 0
        for item in payload.items:
            if not item.term_foreign.strip() or not item.term_german.strip():
                continue
            conn.execute(
                """
                INSERT INTO vocab_items
                    (child_id, subject_id, material_id, unit_name, term_foreign, term_german,
                     article, example_sentence, hint, box, next_review_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                """,
                (
                    child_id,
                    payload.subject_id,
                    payload.material_id,
                    item.unit_name.strip() or "Allgemein",
                    item.term_foreign.strip(),
                    item.term_german.strip(),
                    item.article.strip(),
                    item.example_sentence.strip(),
                    item.hint.strip(),
                    now,
                    now,
                ),
            )
            count += 1
        return {"ok": True, "created": count}


@app.post("/api/children/{child_id}/vocab/review", dependencies=[Depends(require_family)])
def review_vocab(child_id: int, payload: VocabReviewRequest):
    with db_session() as conn:
        child = _get_child_or_404(conn, child_id)
        row = conn.execute(
            "SELECT * FROM vocab_items WHERE id = ? AND child_id = ?", (payload.vocab_id, child_id)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Vokabel nicht gefunden.")

        child_settings = child["settings"]
        typo_tol = child_settings.get("typo_tolerance", "moderate")
        accent_strict = bool(child_settings.get("accent_strict", False))

        if payload.mode == "typing":
            expected = row["term_foreign"] if payload.direction == "de_to_foreign" else row["term_german"]
            article = row["article"] if payload.direction == "de_to_foreign" else ""
            check = check_vocab_answer(
                user_input=payload.user_input or "",
                expected=expected,
                article=article,
                typo_tolerance=typo_tol,
                accent_strict=accent_strict,
            )
            outcome = check["result"]
            error_tag = check["error_tag"]
            feedback = check["feedback"]
        else:
            outcome = payload.self_rating or "wrong"
            error_tag = "bedeutung" if outcome == "wrong" else None
            feedback = (
                "Super gewusst!"
                if outcome == "correct"
                else ("Fast – wir wiederholen es bald nochmal." if outcome == "almost" else "Kein Problem, kommt zurück in Fach 1.")
            )

        updated = update_vocab_leitner(conn, payload.vocab_id, outcome=outcome, error_tag=error_tag)
        stars_delta = 1 if outcome in ("correct", "almost") else 0
        progress = award_stars_and_streak(conn, child_id, stars_delta) if stars_delta else None
        return {
            "outcome": outcome,
            "error_tag": error_tag,
            "feedback": feedback,
            "vocab": updated,
            "progress": progress,
        }


@app.post("/api/children/{child_id}/vocab/session-log", dependencies=[Depends(require_family)])
def log_vocab_session(child_id: int, payload: PracticeFinishRequest):
    with db_session() as conn:
        _get_child_or_404(conn, child_id)
        stars = max(1, round((payload.score / max(1, payload.max_score)) * 5))
        conn.execute(
            """
            INSERT INTO practice_sessions (child_id, subject_id, exam_id, mode, score, max_score, stars_earned, summary_json, created_at)
            VALUES (?, ?, NULL, 'vocab', ?, ?, ?, '{}', ?)
            """,
            (child_id, payload.subject_id, payload.score, payload.max_score, stars, utc_now_iso()),
        )
        progress = award_stars_and_streak(conn, child_id, stars)
        return {"ok": True, "stars_earned": stars, "progress": progress}


@app.delete("/api/vocab/{vocab_id}", dependencies=[Depends(require_parent)])
def delete_vocab(vocab_id: int):
    with db_session() as conn:
        conn.execute("DELETE FROM vocab_items WHERE id = ?", (vocab_id,))
        return {"ok": True}


# ============================================================
# Exams & Topics
# ============================================================

@app.post("/api/children/{child_id}/exams", dependencies=[Depends(require_family)])
def create_exam(child_id: int, payload: ExamCreateRequest):
    now = utc_now_iso()
    with db_session() as conn:
        _get_child_or_404(conn, child_id)
        _get_subject_or_404(conn, payload.subject_id)
        cur = conn.execute(
            """
            INSERT INTO exams (child_id, subject_id, title, exam_date, notes, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?)
            """,
            (child_id, payload.subject_id, payload.title.strip(), payload.exam_date, payload.notes.strip(), now),
        )
        exam_id = int(cur.lastrowid)
        for t in payload.topics:
            if not t.title.strip():
                continue
            conn.execute(
                """
                INSERT INTO topics (exam_id, title, description, key_concepts_json, mastery_score, created_at)
                VALUES (?, ?, ?, ?, 25, ?)
                """,
                (exam_id, t.title.strip(), t.description.strip(), json.dumps(t.key_concepts, ensure_ascii=False), now),
            )
        return {"ok": True, "exam_id": exam_id}


@app.patch("/api/exams/{exam_id}", dependencies=[Depends(require_family)])
def update_exam(exam_id: int, payload: ExamUpdateRequest, request: Request):
    # Archiving or moving an exam to another subject requires Parent PIN
    if payload.archived is not None or payload.subject_id is not None:
        require_parent(request)
    with db_session() as conn:
        row = conn.execute("SELECT * FROM exams WHERE id = ?", (exam_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Prüfung nicht gefunden.")
        if payload.subject_id is not None:
            _get_subject_or_404(conn, payload.subject_id)
        if payload.exam_date is None:
            new_date = row["exam_date"]
        else:
            cleaned = payload.exam_date.strip()
            new_date = cleaned if cleaned else None
        new_archived = int(payload.archived) if payload.archived is not None else int(row["archived"])
        conn.execute(
            """
            UPDATE exams SET title = ?, subject_id = ?, exam_date = ?, notes = ?, status = ?, archived = ?
            WHERE id = ?
            """,
            (
                payload.title.strip() if payload.title and payload.title.strip() else row["title"],
                payload.subject_id if payload.subject_id is not None else row["subject_id"],
                new_date,
                payload.notes if payload.notes is not None else row["notes"],
                payload.status or row["status"],
                new_archived,
                exam_id,
            ),
        )
        updated = dict(conn.execute("SELECT * FROM exams WHERE id = ?", (exam_id,)).fetchone())
        updated["archived"] = bool(updated["archived"])
        return {"ok": True, "exam": updated}


@app.delete("/api/exams/{exam_id}", dependencies=[Depends(require_parent)])
def delete_exam(exam_id: int):
    with db_session() as conn:
        conn.execute("DELETE FROM exams WHERE id = ?", (exam_id,))
        return {"ok": True}


@app.post("/api/parent/exams/{exam_id}/topics", dependencies=[Depends(require_parent)])
def add_exam_topic(exam_id: int, payload: TopicCreateRequest):
    with db_session() as conn:
        ex = conn.execute("SELECT id FROM exams WHERE id = ?", (exam_id,)).fetchone()
        if not ex:
            raise HTTPException(status_code=404, detail="Prüfung nicht gefunden.")
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="Bitte einen Themen-Titel eingeben.")
        cur = conn.execute(
            """
            INSERT INTO topics (exam_id, title, description, key_concepts_json, mastery_score, archived, created_at)
            VALUES (?, ?, ?, ?, 25, 0, ?)
            """,
            (
                exam_id,
                title,
                payload.description.strip(),
                json.dumps([c.strip() for c in payload.key_concepts if c.strip()], ensure_ascii=False),
                utc_now_iso(),
            ),
        )
        topic = dict(conn.execute("SELECT * FROM topics WHERE id = ?", (cur.lastrowid,)).fetchone())
        topic["archived"] = bool(topic["archived"])
        topic["key_concepts"] = json.loads(topic.get("key_concepts_json") or "[]")
        return {"ok": True, "topic": topic}


@app.patch("/api/parent/topics/{topic_id}", dependencies=[Depends(require_parent)])
def update_topic(topic_id: int, payload: TopicUpdateRequest):
    with db_session() as conn:
        row = conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Thema nicht gefunden.")
        new_title = payload.title.strip() if payload.title and payload.title.strip() else row["title"]
        new_desc = payload.description.strip() if payload.description is not None else row["description"]
        new_concepts_json = (
            json.dumps([c.strip() for c in payload.key_concepts if c.strip()], ensure_ascii=False)
            if payload.key_concepts is not None
            else row["key_concepts_json"]
        )
        new_archived = int(payload.archived) if payload.archived is not None else int(row["archived"])
        new_mastery = payload.mastery_score if payload.mastery_score is not None else int(row["mastery_score"])
        conn.execute(
            """
            UPDATE topics
            SET title = ?, description = ?, key_concepts_json = ?, mastery_score = ?, archived = ?
            WHERE id = ?
            """,
            (new_title, new_desc, new_concepts_json, new_mastery, new_archived, topic_id),
        )
        updated = dict(conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone())
        updated["archived"] = bool(updated["archived"])
        updated["key_concepts"] = json.loads(updated.get("key_concepts_json") or "[]")
        return {"ok": True, "topic": updated}


@app.delete("/api/parent/topics/{topic_id}", dependencies=[Depends(require_parent)])
def delete_topic(topic_id: int):
    with db_session() as conn:
        conn.execute("DELETE FROM topics WHERE id = ?", (topic_id,))
        return {"ok": True}


# ============================================================
# Interactive Exam Coach
# ============================================================

@app.post("/api/children/{child_id}/practice/generate", dependencies=[Depends(require_family)])
def generate_practice(child_id: int, payload: PracticeGenerateRequest):
    with db_session() as conn:
        child = _get_child_or_404(conn, child_id)
        subject = _get_subject_or_404(conn, payload.subject_id)

        exam = None
        topics: list[dict[str, Any]] = []
        if payload.exam_id:
            ex_row = conn.execute(
                "SELECT * FROM exams WHERE id = ? AND child_id = ? AND archived = 0", (payload.exam_id, child_id)
            ).fetchone()
            if ex_row:
                exam = dict(ex_row)
                topics = [
                    dict(t)
                    for t in conn.execute(
                        "SELECT * FROM topics WHERE exam_id = ? AND archived = 0", (exam["id"],)
                    ).fetchall()
                ]
        else:
            topics = [
                dict(t)
                for t in conn.execute(
                    """
                    SELECT t.* FROM topics t
                    JOIN exams e ON e.id = t.exam_id
                    WHERE e.child_id = ? AND e.subject_id = ? AND e.status = 'active'
                      AND e.archived = 0 AND t.archived = 0
                    """,
                    (child_id, payload.subject_id),
                ).fetchall()
            ]

        weaknesses = [
            dict(w)
            for w in conn.execute(
                """
                SELECT w.* FROM weaknesses w
                LEFT JOIN topics t ON t.id = w.topic_id
                LEFT JOIN exams e ON e.id = t.exam_id
                WHERE w.child_id = ? AND w.subject_id = ? AND w.resolved = 0
                  AND (w.topic_id IS NULL OR (COALESCE(t.archived, 0) = 0 AND COALESCE(e.archived, 0) = 0))
                ORDER BY w.severity DESC, w.occurrences DESC
                LIMIT 10
                """,
                (child_id, payload.subject_id),
            ).fetchall()
        ]

        mat_rows = conn.execute(
            """
            SELECT m.title, m.extracted_markdown FROM materials m
            LEFT JOIN exams e ON e.id = m.exam_id
            WHERE m.child_id = ? AND m.subject_id = ?
              AND COALESCE(e.archived, 0) = 0
              AND (? IS NULL OR m.exam_id = ? OR m.exam_id IS NULL)
            ORDER BY m.created_at DESC LIMIT 5
            """,
            (child_id, payload.subject_id, payload.exam_id, payload.exam_id),
        ).fetchall()
        materials_excerpt = "\n\n".join(
            f"### {r['title']}\n{r['extracted_markdown']}" for r in mat_rows if r["extracted_markdown"]
        )

    split = select_adaptive_topics(topics, count=min(6, max(2, len(topics))))
    q_count = max(3, min(12, payload.question_count))

    practice_set = generate_interactive_practice(
        child=child,
        subject=subject,
        exam=exam,
        focus_topics=split["focus"],
        reinforcement_topics=split["reinforcement"],
        weaknesses=weaknesses,
        materials_excerpt=materials_excerpt,
        practice_style=payload.practice_style,
        question_count=q_count,
    )
    return practice_set.model_dump()


@app.post("/api/children/{child_id}/practice/evaluate", dependencies=[Depends(require_family)])
def evaluate_practice_answer(child_id: int, payload: PracticeEvaluateAnswerRequest):
    with db_session() as conn:
        child = _get_child_or_404(conn, child_id)
        subject = _get_subject_or_404(conn, payload.subject_id)

    evaluation = evaluate_open_answer(
        child=child,
        subject=subject,
        question_type=payload.question_type,
        prompt_text=payload.prompt,
        expected_answer=payload.expected_answer,
        user_answer=payload.user_answer,
    )
    return evaluation.model_dump()


@app.post("/api/children/{child_id}/practice/finish", dependencies=[Depends(require_family)])
def finish_practice(child_id: int, payload: PracticeFinishRequest):
    with db_session() as conn:
        _get_child_or_404(conn, child_id)
        _get_subject_or_404(conn, payload.subject_id)

        for tr in payload.topic_results:
            tid = tr.get("topic_id")
            ratio = float(tr.get("ratio", 0.5))
            if tid:
                update_topic_mastery(conn, int(tid), ratio)

        for w in payload.detected_weaknesses:
            summary = (w.get("summary") or "").strip()
            if summary:
                record_weakness(
                    conn=conn,
                    child_id=child_id,
                    subject_id=payload.subject_id,
                    topic_id=w.get("topic_id"),
                    summary=summary,
                    example_mistake=w.get("example_mistake", ""),
                    recommendation=w.get("recommendation", ""),
                    severity=int(w.get("severity", 2)),
                )

        ratio_total = payload.score / max(1, payload.max_score)
        stars = max(1, min(6, int(round(ratio_total * 5)) + 1))

        conn.execute(
            """
            INSERT INTO practice_sessions
                (child_id, subject_id, exam_id, mode, score, max_score, stars_earned, summary_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                child_id,
                payload.subject_id,
                payload.exam_id,
                payload.mode,
                payload.score,
                payload.max_score,
                stars,
                json.dumps(
                    {
                        "topic_results": payload.topic_results,
                        "weaknesses_logged": len(payload.detected_weaknesses),
                    },
                    ensure_ascii=False,
                ),
                utc_now_iso(),
            ),
        )
        progress = award_stars_and_streak(conn, child_id, stars)
        return {"ok": True, "stars_earned": stars, "progress": progress}


# ============================================================
# Printable Worksheets + Photo Handwriting Grading
# ============================================================

@app.get("/api/children/{child_id}/worksheets", dependencies=[Depends(require_family)])
def list_worksheets(child_id: int, subject_id: int | None = None):
    with db_session() as conn:
        _get_child_or_404(conn, child_id)
        if subject_id:
            rows = conn.execute(
                """
                SELECT w.*, s.name AS subject_name, s.icon AS subject_icon, s.color AS subject_color
                FROM worksheets w JOIN subjects s ON s.id = w.subject_id
                WHERE w.child_id = ? AND w.subject_id = ?
                ORDER BY w.created_at DESC
                """,
                (child_id, subject_id),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT w.*, s.name AS subject_name, s.icon AS subject_icon, s.color AS subject_color
                FROM worksheets w JOIN subjects s ON s.id = w.subject_id
                WHERE w.child_id = ?
                ORDER BY w.created_at DESC
                """,
                (child_id,),
            ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["questions"] = json.loads(d.get("questions_json") or "[]")
            d["grading_result"] = json.loads(d["grading_result_json"]) if d.get("grading_result_json") else None
            d["submission_images"] = json.loads(d.get("submission_images_json") or "[]")
            out.append(d)
        return {"worksheets": out}


@app.get("/api/worksheets/{worksheet_id}", dependencies=[Depends(require_family)])
def get_worksheet(worksheet_id: int):
    with db_session() as conn:
        row = conn.execute(
            """
            SELECT w.*, s.name AS subject_name, s.icon AS subject_icon, s.color AS subject_color,
                   c.name AS child_name, c.age AS child_age, c.grade AS child_grade
            FROM worksheets w
            JOIN subjects s ON s.id = w.subject_id
            JOIN children c ON c.id = w.child_id
            WHERE w.id = ?
            """,
            (worksheet_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Arbeitsblatt nicht gefunden.")
        d = dict(row)
        d["questions"] = json.loads(d.get("questions_json") or "[]")
        d["answer_key"] = json.loads(d.get("answer_key_json") or "[]")
        d["grading_result"] = json.loads(d["grading_result_json"]) if d.get("grading_result_json") else None
        d["submission_images"] = json.loads(d.get("submission_images_json") or "[]")
        return {"worksheet": d}


@app.post("/api/children/{child_id}/worksheets/generate", dependencies=[Depends(require_family)])
def create_worksheet(child_id: int, payload: WorksheetGenerateRequest):
    with db_session() as conn:
        child = _get_child_or_404(conn, child_id)
        subject = _get_subject_or_404(conn, payload.subject_id)

        exam = None
        topics: list[dict[str, Any]] = []
        if payload.exam_id:
            ex_row = conn.execute(
                "SELECT * FROM exams WHERE id = ? AND child_id = ? AND archived = 0", (payload.exam_id, child_id)
            ).fetchone()
            if ex_row:
                exam = dict(ex_row)
                topics = [
                    dict(t)
                    for t in conn.execute(
                        "SELECT * FROM topics WHERE exam_id = ? AND archived = 0", (exam["id"],)
                    ).fetchall()
                ]
        else:
            topics = [
                dict(t)
                for t in conn.execute(
                    """
                    SELECT t.* FROM topics t JOIN exams e ON e.id = t.exam_id
                    WHERE e.child_id = ? AND e.subject_id = ? AND e.status = 'active'
                      AND e.archived = 0 AND t.archived = 0
                    """,
                    (child_id, payload.subject_id),
                ).fetchall()
            ]

        weaknesses = [
            dict(w)
            for w in conn.execute(
                """
                SELECT w.* FROM weaknesses w
                LEFT JOIN topics t ON t.id = w.topic_id
                LEFT JOIN exams e ON e.id = t.exam_id
                WHERE w.child_id = ? AND w.subject_id = ? AND w.resolved = 0
                  AND (w.topic_id IS NULL OR (COALESCE(t.archived, 0) = 0 AND COALESCE(e.archived, 0) = 0))
                ORDER BY w.severity DESC, w.occurrences DESC LIMIT 12
                """,
                (child_id, payload.subject_id),
            ).fetchall()
        ]
        vocab_items = [
            dict(v)
            for v in conn.execute(
                """
                SELECT * FROM vocab_items WHERE child_id = ? AND subject_id = ?
                ORDER BY box ASC, wrong_count DESC LIMIT 25
                """,
                (child_id, payload.subject_id),
            ).fetchall()
        ]
        mat_rows = conn.execute(
            """
            SELECT m.title, m.extracted_markdown FROM materials m
            LEFT JOIN exams e ON e.id = m.exam_id
            WHERE m.child_id = ? AND m.subject_id = ?
              AND COALESCE(e.archived, 0) = 0
            ORDER BY m.created_at DESC LIMIT 5
            """,
            (child_id, payload.subject_id),
        ).fetchall()
        materials_excerpt = "\n\n".join(
            f"### {r['title']}\n{r['extracted_markdown']}" for r in mat_rows if r["extracted_markdown"]
        )

    q_count = max(3, min(12, payload.question_count))
    generated = generate_worksheet(
        child=child,
        subject=subject,
        exam=exam,
        topics=topics,
        weaknesses=weaknesses,
        vocab_items=vocab_items,
        materials_excerpt=materials_excerpt,
        duration_minutes=payload.duration_minutes,
        focus_mode=payload.focus_mode,
        question_count=q_count,
    )

    q_dicts = [q.model_dump() for q in generated.questions]
    max_points = sum(int(q.get("points", 2)) for q in q_dicts)
    answer_key = [
        {"number": q["number"], "model_solution": q["model_solution"], "grading_notes": q.get("grading_notes", "")}
        for q in q_dicts
    ]

    with db_session() as conn:
        code = _next_worksheet_code(conn)
        title = (payload.title or generated.title or f"{subject['name']} Arbeitsblatt").strip()
        cur = conn.execute(
            """
            INSERT INTO worksheets
                (code, child_id, subject_id, exam_id, title, duration_minutes, focus_mode, paper_style,
                 questions_json, answer_key_json, max_score, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                code,
                child_id,
                payload.subject_id,
                payload.exam_id,
                title,
                payload.duration_minutes,
                payload.focus_mode,
                subject.get("paper_style", "lines"),
                json.dumps(q_dicts, ensure_ascii=False),
                json.dumps(answer_key, ensure_ascii=False),
                max_points,
                utc_now_iso(),
            ),
        )
        ws_id = int(cur.lastrowid)

    return get_worksheet(ws_id)


@app.post("/api/worksheets/{worksheet_id}/grade", dependencies=[Depends(require_family)])
async def grade_worksheet(worksheet_id: int, files: list[UploadFile] = File(...)):
    with db_session() as conn:
        ws_row = conn.execute("SELECT * FROM worksheets WHERE id = ?", (worksheet_id,)).fetchone()
        if not ws_row:
            raise HTTPException(status_code=404, detail="Arbeitsblatt nicht gefunden.")
        ws = dict(ws_row)
        child = _get_child_or_404(conn, ws["child_id"])
        subject = _get_subject_or_404(conn, ws["subject_id"])

    rel_paths, image_blobs = await _save_uploaded_images(ws["child_id"], files)
    logger.info("[LernBuddy] Handschrift-Korrektur gestartet: %s (%d Foto(s))", ws["code"], len(image_blobs))
    graded = await run_in_threadpool(grade_worksheet_photos, child, subject, ws, image_blobs)
    graded_dict = graded.model_dump()
    now = utc_now_iso()

    with db_session() as conn:
        # Update topic mastery & weaknesses from graded items
        topic_buckets: dict[int, list[float]] = {}
        weaknesses_logged = 0
        for item in graded.items:
            if item.topic_id:
                ratio = item.points_awarded / max(1, item.max_points)
                topic_buckets.setdefault(item.topic_id, []).append(ratio)
            if item.detected_weakness.strip():
                record_weakness(
                    conn=conn,
                    child_id=ws["child_id"],
                    subject_id=ws["subject_id"],
                    topic_id=item.topic_id,
                    summary=item.detected_weakness.strip(),
                    example_mistake=f"Arbeitsblatt {ws['code']} Aufg. {item.number}: {item.transcribed_answer[:140]}",
                    recommendation=item.weakness_recommendation.strip(),
                    severity=3 if item.status == "wrong" else 2,
                )
                weaknesses_logged += 1

        for tid, ratios in topic_buckets.items():
            update_topic_mastery(conn, tid, sum(ratios) / len(ratios))

        conn.execute(
            """
            UPDATE worksheets
            SET submission_images_json = ?, grading_result_json = ?, score = ?, max_score = ?, graded_at = ?
            WHERE id = ?
            """,
            (
                json.dumps(rel_paths),
                json.dumps(graded_dict, ensure_ascii=False),
                graded.total_points,
                graded.max_points,
                now,
                worksheet_id,
            ),
        )

        ratio_total = graded.total_points / max(1, graded.max_points)
        stars = max(2, min(8, int(round(ratio_total * 6)) + 2))
        conn.execute(
            """
            INSERT INTO practice_sessions
                (child_id, subject_id, exam_id, mode, score, max_score, stars_earned, summary_json, created_at)
            VALUES (?, ?, ?, 'paper_graded', ?, ?, ?, ?, ?)
            """,
            (
                ws["child_id"],
                ws["subject_id"],
                ws["exam_id"],
                graded.total_points,
                graded.max_points,
                stars,
                json.dumps({"worksheet_code": ws["code"], "weaknesses_logged": weaknesses_logged}, ensure_ascii=False),
                now,
            ),
        )
        progress = award_stars_and_streak(conn, ws["child_id"], stars)

    return {
        "ok": True,
        "grading_result": graded_dict,
        "submission_images": rel_paths,
        "stars_earned": stars,
        "progress": progress,
    }


@app.delete("/api/worksheets/{worksheet_id}", dependencies=[Depends(require_parent)])
def delete_worksheet(worksheet_id: int):
    with db_session() as conn:
        conn.execute("DELETE FROM worksheets WHERE id = ?", (worksheet_id,))
        return {"ok": True}


# ============================================================
# Parent Dashboard (PIN protected)
# ============================================================

@app.get("/api/parent/overview", dependencies=[Depends(require_parent)])
def parent_overview():
    with db_session() as conn:
        rows = conn.execute("SELECT * FROM children ORDER BY age ASC, id ASC").fetchall()
        children_summaries = []
        for r in rows:
            c = dict(r)
            c["settings"] = json.loads(c.get("settings_json") or "{}")
            children_summaries.append(_build_child_parent_summary(conn, c, include_archived=True))

        all_subjects = [dict(s) for s in conn.execute("SELECT * FROM subjects ORDER BY sort_order, id").fetchall()]

    return {
        "children": children_summaries,
        "all_subjects": all_subjects,
        "ai_models": get_active_models(),
        "has_gemini_key": settings.has_gemini_key,
        "using_default_credentials": settings.using_default_credentials,
    }


@app.post("/api/parent/subjects", dependencies=[Depends(require_parent)])
def create_subject(payload: SubjectCreateRequest):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Bitte einen Fachnamen eingeben.")
    base_slug = _slugify_subject(name)
    color = payload.color.strip() if payload.color and payload.color.strip().startswith("#") else "#4338ca"
    lang_code = payload.lang_code.strip() or ("en-GB" if payload.subject_type == "language" else "de-DE")

    with db_session() as conn:
        existing_name = conn.execute("SELECT id FROM subjects WHERE lower(name) = lower(?)", (name,)).fetchone()
        if existing_name:
            raise HTTPException(status_code=409, detail=f"Das Fach '{name}' existiert bereits.")

        slug = base_slug
        suffix = 2
        while conn.execute("SELECT 1 FROM subjects WHERE slug = ?", (slug,)).fetchone():
            slug = f"{base_slug}-{suffix}"
            suffix += 1

        max_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM subjects").fetchone()[0]
        cur = conn.execute(
            """
            INSERT INTO subjects (slug, name, icon, color, subject_type, lang_code, paper_style, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (slug, name, payload.icon.strip() or "📘", color, payload.subject_type, lang_code, payload.paper_style, int(max_order) + 1),
        )
        subject_id = int(cur.lastrowid)

        child_ids = [r["id"] for r in conn.execute("SELECT id FROM children").fetchall()]
        enable_set = set(payload.enable_for_child_ids)
        for cid in child_ids:
            conn.execute(
                "INSERT OR IGNORE INTO child_subjects (child_id, subject_id, enabled) VALUES (?, ?, ?)",
                (cid, subject_id, 1 if cid in enable_set else 0),
            )

        created = dict(conn.execute("SELECT * FROM subjects WHERE id = ?", (subject_id,)).fetchone())
        return {"ok": True, "subject": created}


@app.delete("/api/parent/subjects/{subject_id}", dependencies=[Depends(require_parent)])
def delete_subject(subject_id: int):
    with db_session() as conn:
        row = conn.execute("SELECT * FROM subjects WHERE id = ?", (subject_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Fach nicht gefunden.")
        conn.execute("DELETE FROM subjects WHERE id = ?", (subject_id,))
        return {"ok": True}


@app.patch("/api/parent/weaknesses/{weakness_id}", dependencies=[Depends(require_parent)])
def update_weakness(weakness_id: int, payload: WeaknessUpdateRequest):
    with db_session() as conn:
        row = conn.execute("SELECT * FROM weaknesses WHERE id = ?", (weakness_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Schwachstelle nicht gefunden.")
        resolved = int(payload.resolved) if payload.resolved is not None else row["resolved"]
        severity = max(1, min(3, payload.severity)) if payload.severity is not None else row["severity"]
        conn.execute(
            "UPDATE weaknesses SET resolved = ?, severity = ? WHERE id = ?",
            (resolved, severity, weakness_id),
        )
        return {"ok": True}


@app.delete("/api/parent/weaknesses/{weakness_id}", dependencies=[Depends(require_parent)])
def delete_weakness(weakness_id: int):
    with db_session() as conn:
        conn.execute("DELETE FROM weaknesses WHERE id = ?", (weakness_id,))
        return {"ok": True}


@app.post("/api/parent/children/{child_id}/report", dependencies=[Depends(require_parent)])
def create_parent_ai_report(child_id: int):
    with db_session() as conn:
        child = _get_child_or_404(conn, child_id)
        summary = _build_child_parent_summary(conn, child)

    report = generate_parent_report(child=child, overview_data=summary)
    return {"report": report.model_dump()}


@app.get("/api/parent/settings/ai/models", dependencies=[Depends(require_parent)])
def get_available_ai_models():
    return {"models": list_available_models()}


@app.post("/api/parent/settings/ai/test", dependencies=[Depends(require_parent)])
def test_ai_models(payload: dict[str, Any] | None = None):
    target = (payload or {}).get("model") if isinstance(payload, dict) else None
    if target and str(target).strip():
        return {"results": [test_model_connectivity(str(target).strip())]}
    active = get_active_models()
    models_to_test = [active["fast"]]
    if active["smart"] != active["fast"]:
        models_to_test.append(active["smart"])
    return {"results": [test_model_connectivity(m) for m in models_to_test]}


@app.patch("/api/parent/settings/ai", dependencies=[Depends(require_parent)])
def update_ai_settings(payload: AISettingsUpdateRequest):
    with db_session() as conn:
        if payload.gemini_model_fast and payload.gemini_model_fast.strip():
            set_app_setting(conn, "gemini_model_fast", payload.gemini_model_fast.strip())
        if payload.gemini_model_smart and payload.gemini_model_smart.strip():
            set_app_setting(conn, "gemini_model_smart", payload.gemini_model_smart.strip())
    return {"ai_models": get_active_models()}


# ============================================================
# PWA & SPA Entrypoint
# ============================================================

@app.get("/manifest.webmanifest")
def serve_manifest():
    return FileResponse(
        str(STATIC_DIR / "manifest.json"),
        media_type="application/manifest+json",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


@app.get("/sw.js")
def serve_service_worker():
    js = (STATIC_DIR / "sw.js").read_text(encoding="utf-8").replace("__CACHE_VERSION__", ASSET_VERSION)
    return Response(
        content=js,
        media_type="application/javascript",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Service-Worker-Allowed": "/",
        },
    )


@app.get("/")
def serve_index():
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    for asset in ("styles.css", "app.js", "views_child.js", "views_print_parent.js"):
        html = html.replace(f"/static/{asset}", f"/static/{asset}?v={ASSET_VERSION}")
    return HTMLResponse(content=html, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
