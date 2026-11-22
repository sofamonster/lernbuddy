from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

from app.config import settings


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(settings.db_path), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    return conn


@contextmanager
def db_session() -> Iterator[sqlite3.Connection]:
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS children (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    age INTEGER NOT NULL,
    grade TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '🦊',
    avatar_image TEXT NOT NULL DEFAULT '',
    ui_mode TEXT NOT NULL DEFAULT 'standard', -- 'junior' | 'standard'
    stars INTEGER NOT NULL DEFAULT 0,
    streak_days INTEGER NOT NULL DEFAULT 0,
    last_active_date TEXT,
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    color TEXT NOT NULL,
    subject_type TEXT NOT NULL DEFAULT 'subject', -- 'language' | 'subject'
    lang_code TEXT NOT NULL DEFAULT 'de-DE',
    paper_style TEXT NOT NULL DEFAULT 'lines', -- 'grid' | 'lines' | 'mixed'
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS child_subjects (
    child_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (child_id, subject_id),
    FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    exam_date TEXT,
    notes TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'completed'
    created_at TEXT NOT NULL,
    FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    key_concepts_json TEXT NOT NULL DEFAULT '[]',
    mastery_score INTEGER NOT NULL DEFAULT 25, -- 0..100
    attempts_count INTEGER NOT NULL DEFAULT 0,
    last_practiced_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    exam_id INTEGER,
    material_type TEXT NOT NULL, -- 'vocab' | 'exam_topic'
    title TEXT NOT NULL,
    image_paths_json TEXT NOT NULL DEFAULT '[]',
    extracted_markdown TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS vocab_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    material_id INTEGER,
    unit_name TEXT NOT NULL DEFAULT 'Allgemein',
    term_foreign TEXT NOT NULL,
    term_german TEXT NOT NULL,
    article TEXT NOT NULL DEFAULT '',
    example_sentence TEXT NOT NULL DEFAULT '',
    hint TEXT NOT NULL DEFAULT '',
    box INTEGER NOT NULL DEFAULT 1, -- 1..5 Leitner
    next_review_at TEXT NOT NULL,
    correct_count INTEGER NOT NULL DEFAULT 0,
    wrong_count INTEGER NOT NULL DEFAULT 0,
    error_tags_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS weaknesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    topic_id INTEGER,
    summary TEXT NOT NULL,
    example_mistake TEXT NOT NULL DEFAULT '',
    recommendation TEXT NOT NULL DEFAULT '',
    severity INTEGER NOT NULL DEFAULT 2, -- 1=leicht, 2=mittel, 3=wichtig
    occurrences INTEGER NOT NULL DEFAULT 1,
    resolved INTEGER NOT NULL DEFAULT 0,
    detected_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS worksheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE, -- e.g. AB-001
    child_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    exam_id INTEGER,
    title TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 15,
    focus_mode TEXT NOT NULL DEFAULT 'weaknesses', -- 'weaknesses' | 'mixed' | 'vocab'
    paper_style TEXT NOT NULL DEFAULT 'lines',
    questions_json TEXT NOT NULL DEFAULT '[]',
    answer_key_json TEXT NOT NULL DEFAULT '[]',
    submission_images_json TEXT NOT NULL DEFAULT '[]',
    grading_result_json TEXT,
    score INTEGER,
    max_score INTEGER,
    created_at TEXT NOT NULL,
    graded_at TEXT,
    FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS practice_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    exam_id INTEGER,
    mode TEXT NOT NULL, -- 'vocab' | 'exam_interactive' | 'dictation' | 'paper_graded'
    score INTEGER NOT NULL DEFAULT 0,
    max_score INTEGER NOT NULL DEFAULT 0,
    stars_earned INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_vocab_child_sub ON vocab_items(child_id, subject_id, next_review_at);
CREATE INDEX IF NOT EXISTS idx_weaknesses_child ON weaknesses(child_id, resolved, severity);
CREATE INDEX IF NOT EXISTS idx_exams_child ON exams(child_id, status);
CREATE INDEX IF NOT EXISTS idx_worksheets_child ON worksheets(child_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_child ON practice_sessions(child_id, created_at);
"""

DEFAULT_SUBJECTS = [
    ("mathe", "Mathe", "📐", "#3b82f6", "subject", "de-DE", "grid", 1),
    ("deutsch", "Deutsch", "📖", "#f59e0b", "subject", "de-DE", "lines", 2),
    ("englisch", "Englisch", "🇬🇧", "#10b981", "language", "en-GB", "lines", 3),
    ("franzoesisch", "Französisch", "🇫🇷", "#8b5cf6", "language", "fr-FR", "lines", 4),
    ("sachunterricht", "Sachunterricht", "🌍", "#f97316", "subject", "de-DE", "lines", 5),
    ("biologie", "Biologie", "🌿", "#16a34a", "subject", "de-DE", "lines", 6),
]


def init_db() -> None:
    with db_session() as conn:
        conn.executescript(SCHEMA_SQL)
        # Lightweight migration for existing databases
        child_cols = {row["name"] for row in conn.execute("PRAGMA table_info(children)").fetchall()}
        if "avatar_image" not in child_cols:
            conn.execute("ALTER TABLE children ADD COLUMN avatar_image TEXT NOT NULL DEFAULT ''")
        now = utc_now_iso()

        # Seed default subjects
        for slug, name, icon, color, stype, lang, pstyle, order in DEFAULT_SUBJECTS:
            conn.execute(
                """
                INSERT OR IGNORE INTO subjects
                    (slug, name, icon, color, subject_type, lang_code, paper_style, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (slug, name, icon, color, stype, lang, pstyle, order),
            )

        # Seed 2 default children if table is empty
        child_count = conn.execute("SELECT COUNT(*) FROM children").fetchone()[0]
        if child_count == 0:
            junior_settings = json.dumps(
                {
                    "auto_read_aloud": True,
                    "typo_tolerance": "relaxed",
                    "accent_strict": False,
                    "session_length": 6,
                }
            )
            older_settings = json.dumps(
                {
                    "auto_read_aloud": False,
                    "typo_tolerance": "moderate",
                    "accent_strict": False,
                    "session_length": 10,
                }
            )
            cur1 = conn.execute(
                """
                INSERT INTO children (name, age, grade, avatar, ui_mode, settings_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                ("Junior", 8, "3. Klasse", "🦊", "junior", junior_settings, now),
            )
            child1_id = cur1.lastrowid

            cur2 = conn.execute(
                """
                INSERT INTO children (name, age, grade, avatar, ui_mode, settings_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                ("Großer", 11, "6. Klasse", "🦉", "standard", older_settings, now),
            )
            child2_id = cur2.lastrowid

            subj_rows = conn.execute("SELECT id, slug FROM subjects").fetchall()
            junior_enabled = {"mathe", "deutsch", "sachunterricht", "englisch"}
            older_enabled = {"mathe", "deutsch", "englisch", "franzoesisch", "biologie"}

            for row in subj_rows:
                conn.execute(
                    "INSERT INTO child_subjects (child_id, subject_id, enabled) VALUES (?, ?, ?)",
                    (child1_id, row["id"], 1 if row["slug"] in junior_enabled else 0),
                )
                conn.execute(
                    "INSERT INTO child_subjects (child_id, subject_id, enabled) VALUES (?, ?, ?)",
                    (child2_id, row["id"], 1 if row["slug"] in older_enabled else 0),
                )


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return dict(row)


def get_app_setting(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_app_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        (key, value, utc_now_iso()),
    )
