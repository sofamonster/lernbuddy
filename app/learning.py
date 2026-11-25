from __future__ import annotations

import json
import re
import sqlite3
import unicodedata
from datetime import date, datetime, timedelta, timezone
from typing import Any

from app.db import utc_now_iso

# Leitner intervals in hours per box (1..5)
LEITNER_INTERVAL_HOURS = {
    1: 0,
    2: 24,
    3: 72,
    4: 168,
    5: 336,
}

FRENCH_ARTICLES = ("le ", "la ", "les ", "l'", "l’", "un ", "une ", "des ")


def _strip_accents(text: str) -> str:
    nfd = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in nfd if unicodedata.category(ch) != "Mn")


def _normalize(text: str) -> str:
    cleaned = text.strip().lower()
    cleaned = cleaned.replace("’", "'").replace("`", "'")
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = cleaned.strip(".,!?;:")
    return cleaned


def _strip_article(text: str) -> tuple[str, str]:
    norm = _normalize(text)
    for art in FRENCH_ARTICLES:
        if norm.startswith(art):
            return art.strip(), norm[len(art) :].strip()
    return "", norm


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        curr = [i]
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            curr.append(min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost))
        prev = curr
    return prev[-1]


def _join_article(article: str, word: str) -> str:
    art = article.strip()
    w = word.strip()
    if not art:
        return w
    if _normalize(w).startswith(_normalize(art)):
        return w
    if art.endswith(("'", "’")):
        return f"{art}{w}"
    return f"{art} {w}"


def check_vocab_answer(
    user_input: str,
    expected: str,
    article: str = "",
    typo_tolerance: str = "moderate",
    accent_strict: bool = False,
) -> dict[str, Any]:
    """
    Evaluate a typed vocabulary answer with optional French article & accent diagnostics.
    Returns: {result: 'correct'|'almost'|'wrong', error_tag: str|None, feedback: str}
    """
    u_norm = _normalize(user_input)
    full_expected = _join_article(article, expected)
    # Support slash-separated valid alternatives like "house / home"
    variants = [v.strip() for v in re.split(r"[/;]", full_expected) if v.strip()]
    if expected.strip() not in variants:
        variants.append(expected.strip())

    if not u_norm:
        return {
            "result": "wrong",
            "error_tag": "bedeutung",
            "feedback": f"Keine Eingabe. Richtige Antwort: {full_expected}",
        }

    # 1. Exact match against any variant
    for var in variants:
        if u_norm == _normalize(var):
            return {
                "result": "correct",
                "error_tag": None,
                "feedback": "Perfekt! Genau richtig.",
            }

    # 2. Check accent-only difference
    u_no_acc = _strip_accents(u_norm)
    for var in variants:
        v_norm = _normalize(var)
        if u_no_acc == _strip_accents(v_norm):
            if accent_strict:
                return {
                    "result": "wrong",
                    "error_tag": "akzent",
                    "feedback": f"Fast! Achte genau auf die Akzente: {var}",
                }
            return {
                "result": "almost",
                "error_tag": "akzent",
                "feedback": f"Richtiges Wort! Achte auf den Akzent: {var}",
            }

    # 3. Check French article mismatch (right noun, missing/wrong article)
    u_art, u_stem = _strip_article(u_norm)
    for var in variants:
        v_art, v_stem = _strip_article(var)
        if v_art and u_stem and (_strip_accents(u_stem) == _strip_accents(v_stem)):
            if u_art != v_art:
                return {
                    "result": "almost" if typo_tolerance == "relaxed" else "wrong",
                    "error_tag": "artikel",
                    "feedback": f"Das Wort stimmt, aber der Artikel ist '{v_art}': {var}",
                }

    # 4. Check typo tolerance (Levenshtein)
    best_dist = 999
    best_var = full_expected
    for var in variants:
        d = levenshtein(u_no_acc, _strip_accents(_normalize(var)))
        if d < best_dist:
            best_dist = d
            best_var = var

    max_allowed = 0
    if typo_tolerance == "moderate" and len(best_var) >= 5:
        max_allowed = 1
    elif typo_tolerance == "relaxed":
        if len(best_var) >= 8:
            max_allowed = 2
        elif len(best_var) >= 4:
            max_allowed = 1

    if best_dist <= max_allowed:
        return {
            "result": "almost",
            "error_tag": "rechtschreibung",
            "feedback": f"Fast richtig (kleiner Tippfehler)! Schreibung: {best_var}",
        }

    return {
        "result": "wrong",
        "error_tag": "rechtschreibung" if best_dist <= 3 else "bedeutung",
        "feedback": f"Nicht ganz. Richtig wäre: {full_expected}",
    }


def update_vocab_leitner(
    conn: sqlite3.Connection,
    vocab_id: int,
    outcome: str,  # 'correct' | 'almost' | 'wrong'
    error_tag: str | None = None,
) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM vocab_items WHERE id = ?", (vocab_id,)).fetchone()
    if not row:
        raise ValueError("Vokabel nicht gefunden.")

    box = int(row["box"])
    correct_count = int(row["correct_count"])
    wrong_count = int(row["wrong_count"])
    tags: list[str] = json.loads(row["error_tags_json"] or "[]")

    if outcome == "correct":
        new_box = min(5, box + 1)
        correct_count += 1
    elif outcome == "almost":
        # Stay in current box (or move to 2 if box 1) so it gets reinforced soon
        new_box = max(1, min(box, 3))
        correct_count += 1
        if error_tag and error_tag not in tags:
            tags.append(error_tag)
    else:
        new_box = 1
        wrong_count += 1
        if error_tag and error_tag not in tags:
            tags.append(error_tag)

    hours = LEITNER_INTERVAL_HOURS.get(new_box, 24)
    next_review = (datetime.now(timezone.utc) + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")

    conn.execute(
        """
        UPDATE vocab_items
        SET box = ?, next_review_at = ?, correct_count = ?, wrong_count = ?, error_tags_json = ?
        WHERE id = ?
        """,
        (new_box, next_review, correct_count, wrong_count, json.dumps(tags, ensure_ascii=False), vocab_id),
    )

    # Also log recurring vocab weakness if wrong_count >= 2
    if outcome == "wrong" and wrong_count >= 2:
        tag_label = f" ({error_tag})" if error_tag else ""
        record_weakness(
            conn=conn,
            child_id=row["child_id"],
            subject_id=row["subject_id"],
            topic_id=None,
            summary=f"Vokabel '{row['term_foreign']}' (= {row['term_german']}){tag_label}",
            example_mistake=f"{wrong_count}x falsch beantwortet",
            recommendation="In kurzen Runden gezielt eintippen und laut vorlesen lassen.",
            severity=2 if wrong_count < 4 else 3,
        )

    return {
        "id": vocab_id,
        "box": new_box,
        "next_review_at": next_review,
        "correct_count": correct_count,
        "wrong_count": wrong_count,
        "error_tags": tags,
    }


def record_weakness(
    conn: sqlite3.Connection,
    child_id: int,
    subject_id: int,
    topic_id: int | None,
    summary: str,
    example_mistake: str = "",
    recommendation: str = "",
    severity: int = 2,
) -> int:
    clean_summary = summary.strip()
    if not clean_summary:
        return 0
    now = utc_now_iso()

    # Check if an open similar weakness already exists
    existing = conn.execute(
        """
        SELECT id, occurrences, severity FROM weaknesses
        WHERE child_id = ? AND subject_id = ? AND resolved = 0
          AND lower(summary) = lower(?)
        LIMIT 1
        """,
        (child_id, subject_id, clean_summary),
    ).fetchone()

    if existing:
        new_occ = int(existing["occurrences"]) + 1
        new_sev = max(int(existing["severity"]), min(3, severity))
        conn.execute(
            """
            UPDATE weaknesses
            SET occurrences = ?, severity = ?, example_mistake = CASE WHEN ? != '' THEN ? ELSE example_mistake END,
                recommendation = CASE WHEN ? != '' THEN ? ELSE recommendation END,
                last_seen_at = ?
            WHERE id = ?
            """,
            (
                new_occ,
                new_sev,
                example_mistake,
                example_mistake,
                recommendation,
                recommendation,
                now,
                existing["id"],
            ),
        )
        return int(existing["id"])

    cur = conn.execute(
        """
        INSERT INTO weaknesses
            (child_id, subject_id, topic_id, summary, example_mistake, recommendation, severity, occurrences, resolved, detected_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
        """,
        (
            child_id,
            subject_id,
            topic_id,
            clean_summary,
            example_mistake.strip(),
            recommendation.strip(),
            max(1, min(3, severity)),
            now,
            now,
        ),
    )
    return int(cur.lastrowid)


def update_topic_mastery(conn: sqlite3.Connection, topic_id: int, correct_ratio: float) -> int:
    """Smoothly update topic mastery score (0..100) using exponential moving average."""
    row = conn.execute("SELECT mastery_score, attempts_count FROM topics WHERE id = ?", (topic_id,)).fetchone()
    if not row:
        return 0
    old_score = int(row["mastery_score"])
    attempts = int(row["attempts_count"])
    target = int(round(max(0.0, min(1.0, correct_ratio)) * 100))
    alpha = 0.45 if attempts < 2 else 0.3
    new_score = int(round((1 - alpha) * old_score + alpha * target))
    new_score = max(5, min(100, new_score))
    conn.execute(
        """
        UPDATE topics
        SET mastery_score = ?, attempts_count = ?, last_practiced_at = ?
        WHERE id = ?
        """,
        (new_score, attempts + 1, utc_now_iso(), topic_id),
    )
    return new_score


def select_adaptive_topics(topics: list[dict[str, Any]], count: int = 4) -> dict[str, list[dict[str, Any]]]:
    """Split topics into ~70% focus (weakest) and ~30% reinforcement (strongest)."""
    if not topics:
        return {"focus": [], "reinforcement": []}
    sorted_topics = sorted(topics, key=lambda t: (t.get("mastery_score", 50), t.get("attempts_count", 0)))
    focus_n = max(1, round(count * 0.7))
    focus = sorted_topics[:focus_n]
    remaining = sorted_topics[focus_n:]
    reinforcement = list(reversed(remaining))[: max(0, count - len(focus))]
    return {"focus": focus, "reinforcement": reinforcement}


def compute_exam_readiness(exam: dict[str, Any], topics: list[dict[str, Any]], open_weaknesses: int) -> dict[str, Any]:
    if topics:
        avg_mastery = int(round(sum(int(t["mastery_score"]) for t in topics) / len(topics)))
    else:
        avg_mastery = 0

    days_left: int | None = None
    if exam.get("exam_date"):
        try:
            d = date.fromisoformat(exam["exam_date"][:10])
            days_left = (d - date.today()).days
        except ValueError:
            days_left = None

    effective = max(0, avg_mastery - min(25, open_weaknesses * 5))
    if not topics:
        light = "yellow"
        label = "Noch kein Stoff erfasst"
    elif effective >= 75:
        light = "green"
        label = "Gut vorbereitet"
    elif effective >= 48:
        light = "yellow"
        label = "Auf gutem Weg"
    else:
        light = "red"
        label = "Übungsbedarf"

    return {
        "avg_mastery": avg_mastery,
        "effective_score": effective,
        "days_left": days_left,
        "traffic_light": light,
        "label": label,
    }


DAILY_STAR_CAP = 10


def get_effective_stars_today(child: dict[str, Any]) -> int:
    today_str = date.today().isoformat()
    if child.get("last_active_date") == today_str:
        return int(child.get("stars_today") or 0)
    return 0


def award_stars_and_streak(
    conn: sqlite3.Connection,
    child_id: int,
    stars_earned: int,
    daily_cap: int = DAILY_STAR_CAP,
) -> dict[str, Any]:
    row = conn.execute(
        "SELECT stars, stars_today, streak_days, last_active_date FROM children WHERE id = ?",
        (child_id,),
    ).fetchone()
    if not row:
        return {
            "stars": 0,
            "stars_today": 0,
            "stars_awarded": 0,
            "daily_star_cap": daily_cap,
            "daily_cap_reached": False,
            "streak_days": 0,
        }

    today_str = date.today().isoformat()
    yesterday_str = (date.today() - timedelta(days=1)).isoformat()
    last_active = row["last_active_date"]
    streak = int(row["streak_days"])

    if last_active == today_str:
        current_today = int(row["stars_today"] or 0)
    elif last_active == yesterday_str:
        streak += 1
        current_today = 0
    else:
        streak = 1
        current_today = 0

    remaining = max(0, daily_cap - current_today)
    awarded = min(max(0, int(stars_earned)), remaining)
    new_stars_today = current_today + awarded
    new_stars = int(row["stars"]) + awarded

    conn.execute(
        """
        UPDATE children
        SET stars = ?, stars_today = ?, streak_days = ?, last_active_date = ?
        WHERE id = ?
        """,
        (new_stars, new_stars_today, streak, today_str, child_id),
    )
    return {
        "stars": new_stars,
        "stars_today": new_stars_today,
        "stars_awarded": awarded,
        "daily_star_cap": daily_cap,
        "daily_cap_reached": new_stars_today >= daily_cap,
        "streak_days": streak,
    }
