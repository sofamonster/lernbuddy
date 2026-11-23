from __future__ import annotations

import json
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Type, TypeVar

from google import genai
from google.genai import types
from pydantic import BaseModel

from app.config import settings
from app.db import db_session, get_app_setting
from app.schemas import (
    AnswerEvaluationOutput,
    GeneratedPracticeSet,
    GeneratedWorksheetOutput,
    GradedWorksheetOutput,
    ParentReportOutput,
    ScanExamTopicOutput,
    ScanVocabOutput,
    ScannedTopic,
    ScannedVocabItem,
)

logger = logging.getLogger("uvicorn.error")

T = TypeVar("T", bound=BaseModel)

# Timeout in milliseconds for individual Gemini API calls
AI_TIMEOUT_MS_FAST = 45_000
AI_TIMEOUT_MS_SMART = 85_000
SCAN_BATCH_SIZE = 3


class AIConfigError(RuntimeError):
    pass


class AIServiceError(RuntimeError):
    pass


def get_active_models() -> dict[str, str]:
    with db_session() as conn:
        fast = get_app_setting(conn, "gemini_model_fast", settings.gemini_model_fast)
        smart = get_app_setting(conn, "gemini_model_smart", settings.gemini_model_smart)
    return {
        "fast": fast or settings.gemini_model_fast,
        "smart": smart or settings.gemini_model_smart,
    }


def _get_client(timeout_ms: int = AI_TIMEOUT_MS_FAST) -> genai.Client:
    if not settings.has_gemini_key:
        raise AIConfigError(
            "Kein Google Gemini API-Key konfiguriert. Bitte trage GEMINI_API_KEY in die Datei .env ein und starte die App neu."
        )
    return genai.Client(
        api_key=settings.gemini_api_key,
        http_options=types.HttpOptions(timeout=timeout_ms),
    )


def list_available_models() -> list[dict[str, str]]:
    client = _get_client(timeout_ms=30_000)
    out: list[dict[str, str]] = []
    try:
        for m in client.models.list():
            raw_name = getattr(m, "name", "") or ""
            model_id = raw_name.removeprefix("models/")
            if not model_id or "gemini" not in model_id.lower():
                continue
            low = model_id.lower()
            if any(
                skip in low
                for skip in ("embedding", "aqa", "imagen", "veo", "tts", "audio-only", "robotics", "computer-use")
            ):
                continue
            actions = getattr(m, "supported_actions", None) or []
            if actions and "generateContent" not in actions:
                continue
            out.append(
                {
                    "id": model_id,
                    "display_name": getattr(m, "display_name", "") or model_id,
                }
            )
    except AIConfigError:
        raise
    except Exception as exc:
        raise AIServiceError(f"Konnte verfügbare Modelle nicht abrufen: {exc}") from exc
    out.sort(key=lambda x: x["id"], reverse=True)
    return out


def _child_tone_instruction(child: dict[str, Any]) -> str:
    age = int(child.get("age", 10))
    grade = child.get("grade", "")
    name = child.get("name", "das Kind")
    if age <= 9:
        return (
            f"Das Kind heißt {name}, ist {age} Jahre alt ({grade}). "
            "Nutze sehr klare, kurze, leicht verständliche Sätze, warme ermutigende Sprache und alltagsnahe Beispiele. "
            "Keine unnötig komplizierten Fremdwörter."
        )
    return (
        f"Das Kind heißt {name}, ist {age} Jahre alt ({grade}). "
        "Nutze einen freundlichen, respektvollen, motivierenden Ton auf Augenhöhe (nicht kindisch), "
        "altersgerechte Fachbegriffe und präzise Erklärungen zur gezielten Klassenarbeits-Vorbereitung."
    )


def _extract_json_text(raw: str) -> str:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


def _classify_ai_error(exc: Exception) -> str:
    msg = str(exc).lower()
    if any(tok in msg for tok in ("429", "resource_exhausted", "quota", "rate limit", "too many requests")):
        return "quota_429"
    if any(tok in msg for tok in ("503", "unavailable", "high demand", "overloaded", "temporarily")):
        return "overload_503"
    if any(tok in msg for tok in ("timeout", "timed out", "deadline_exceeded", "504")):
        return "timeout"
    if any(tok in msg for tok in ("404", "not_found", "not found", "is not found")):
        return "not_found_404"
    if any(tok in msg for tok in ("400", "invalid_argument", "thinking")):
        return "bad_request_400"
    return "other"


def _short_err(exc: Exception) -> str:
    text = re.sub(r"\s+", " ", str(exc)).strip()
    return text[:200] + ("…" if len(text) > 200 else "")


def test_model_connectivity(model_name: str) -> dict[str, Any]:
    """Run a tiny 1-token ping against a Gemini model to diagnose 503 vs 429 vs 404 vs latency."""
    client = _get_client(timeout_ms=20_000)
    t0 = time.monotonic()
    try:
        resp = client.models.generate_content(
            model=model_name,
            contents="Antworte nur mit OK",
            config=types.GenerateContentConfig(temperature=0.0, max_output_tokens=16),
        )
        elapsed = round(time.monotonic() - t0, 2)
        return {
            "model": model_name,
            "ok": True,
            "status": "ok",
            "elapsed_sec": elapsed,
            "message": f"Erreichbar in {elapsed}s ({(resp.text or 'OK').strip()[:20]})",
        }
    except AIConfigError:
        raise
    except Exception as exc:
        elapsed = round(time.monotonic() - t0, 2)
        kind = _classify_ai_error(exc)
        labels = {
            "quota_429": "429 Quota / Limit erreicht (Tages- oder Minutenlimit des API-Keys)",
            "overload_503": "503 Google-Server überlastet (temporäre Lastspitze)",
            "timeout": "Timeout (keine Antwort innerhalb 20s)",
            "not_found_404": "404 Modellname ungültig oder nicht freigeschaltet",
            "bad_request_400": "400 Anfrage abgelehnt",
            "other": "Fehler",
        }
        return {
            "model": model_name,
            "ok": False,
            "status": kind,
            "elapsed_sec": elapsed,
            "message": f"{labels[kind]} – {_short_err(exc)}",
        }


def _call_structured(
    contents: list[Any],
    schema: Type[T],
    system_instruction: str,
    tier: str = "fast",
    temperature: float = 0.3,
    low_thinking: bool = False,
    label: str = "request",
) -> T:
    timeout_ms = AI_TIMEOUT_MS_SMART if tier == "smart" else AI_TIMEOUT_MS_FAST
    client = _get_client(timeout_ms=timeout_ms)
    models = get_active_models()
    primary_model = models["smart"] if tier == "smart" else models["fast"]
    secondary_model = models["fast"] if tier == "smart" else models["smart"]

    candidates: list[str] = [primary_model]
    if secondary_model and secondary_model not in candidates:
        candidates.append(secondary_model)

    attempt_errors: list[tuple[str, str, Exception]] = []

    for model_name in candidates:
        # Try MINIMAL/LOW thinking for fast tasks; fall back cleanly to plain config on any 400
        config_variants: list[types.GenerateContentConfig] = []
        if low_thinking:
            config_variants.append(
                types.GenerateContentConfig(
                    system_instruction=system_instruction,
                    temperature=temperature,
                    response_mime_type="application/json",
                    response_schema=schema,
                    thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.MINIMAL),
                )
            )
        config_variants.append(
            types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=temperature,
                response_mime_type="application/json",
                response_schema=schema,
            )
        )

        # Up to 2 attempts per model ONLY on transient 503 overload (not on 429 quota or 404!)
        for attempt in range(1, 3):
            t0 = time.monotonic()
            logger.info("[LernBuddy AI] %s -> Modell %s (Versuch %d) gestartet...", label, model_name, attempt)
            retry_same_model = False

            for cfg_idx, cfg in enumerate(config_variants):
                try:
                    response = client.models.generate_content(
                        model=model_name,
                        contents=contents,
                        config=cfg,
                    )
                    elapsed = time.monotonic() - t0
                    logger.info("[LernBuddy AI] %s -> Modell %s fertig in %.1fs", label, model_name, elapsed)
                    if getattr(response, "parsed", None) is not None and isinstance(response.parsed, schema):
                        return response.parsed
                    raw_text = _extract_json_text(response.text or "")
                    return schema.model_validate_json(raw_text)
                except AIConfigError:
                    raise
                except Exception as exc:
                    kind = _classify_ai_error(exc)
                    # If thinking_config wasn't supported by this model (400), immediately retry without it
                    if cfg_idx == 0 and len(config_variants) > 1 and kind == "bad_request_400":
                        logger.info("[LernBuddy AI] %s -> Modell %s lehnt thinking_config ab, retry ohne...", label, model_name)
                        continue
                    attempt_errors.append((model_name, kind, exc))
                    logger.warning(
                        "[LernBuddy AI] %s -> Fehler [%s] bei Modell %s (Versuch %d) nach %.1fs: %s",
                        label,
                        kind,
                        model_name,
                        attempt,
                        time.monotonic() - t0,
                        exc,
                    )
                    if attempt == 1 and kind == "overload_503":
                        retry_same_model = True
                    break

            if retry_same_model:
                logger.info("[LernBuddy AI] %s -> Modell %s kurz überlastet (503), warte 2s für Retry...", label, model_name)
                time.sleep(2.0)
                continue
            break

    # Build a clear, honest diagnostic error message distinguishing 429 vs 503 vs timeout
    kinds = {k for _, k, _ in attempt_errors}
    details = " | ".join(f"{m}: {k} ({_short_err(e)})" for m, k, e in attempt_errors[-2:])

    if kinds == {"quota_429"} or ("quota_429" in kinds and "overload_503" not in kinds):
        raise AIServiceError(
            f"Google Gemini API-Limit erreicht (429 RESOURCE_EXHAUSTED – Tages- oder Minutenkontingent erschöpft, keine Server-Überlastung). Details: {details}"
        )
    if "overload_503" in kinds:
        raise AIServiceError(
            f"Google Gemini meldet echte Server-Überlastung (503 UNAVAILABLE) für die getesteten Modelle. "
            f"Tipp: Im Elternbereich unter '⚙️ Profile, Fächer & KI' auf '⚡ Modelle testen' klicken, um ein freies Modell zu finden. Details: {details}"
        )
    if "timeout" in kinds:
        raise AIServiceError(
            f"Zeitüberschreitung bei Google Gemini (keine Antwort rechtzeitig erhalten). Details: {details}"
        )
    raise AIServiceError(f"Gemini-Anfrage fehlgeschlagen: {details}")


def _images_to_parts(images: list[tuple[bytes, str]]) -> list[Any]:
    return [types.Part.from_bytes(data=data, mime_type=mime) for data, mime in images]


def _chunk_list(items: list[Any], size: int) -> list[list[Any]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def _scan_vocab_batch(
    child: dict[str, Any],
    subject: dict[str, Any],
    images: list[tuple[bytes, str]],
    extra_note: str,
    batch_label: str,
) -> ScanVocabOutput:
    system = (
        "Du bist ein sorgfältiger Schul-Lernassistent. "
        "Lies alle Vokabeln aus den Fotos einer Schulbuchseite oder eines Vokabelhefts fehlerfrei aus. "
        "Achte besonders auf französische Akzente (é, è, ê, ç, à, ù, ô, œ) und Artikel (le, la, l', un, une). "
        "Erfinde keine Vokabeln, die nicht auf den Fotos stehen. Antworte kompakt auf Deutsch im JSON-Schema."
    )
    prompt = (
        f"Fach: {subject['name']} ({subject['lang_code']}).\n"
        f"{_child_tone_instruction(child)}\n"
        f"Zusatzhinweis: {extra_note or 'keiner'}.\n\n"
        "Extrahiere alle sichtbaren Vokabelpaare. Wenn ein französisches Nomen einen Artikel hat, "
        "trage ihn im Feld 'article' ein und das Hauptwort in 'term_foreign'. "
        "Halte 'extracted_markdown' kurz (max. 10 Stichpunkte)."
    )
    contents = [*_images_to_parts(images), prompt]
    return _call_structured(
        contents,
        ScanVocabOutput,
        system,
        tier="fast",
        temperature=0.15,
        low_thinking=True,
        label=batch_label,
    )


def scan_vocab_images(
    child: dict[str, Any],
    subject: dict[str, Any],
    images: list[tuple[bytes, str]],
    extra_note: str = "",
) -> ScanVocabOutput:
    batches = _chunk_list(images, SCAN_BATCH_SIZE)
    if len(batches) == 1:
        return _scan_vocab_batch(child, subject, batches[0], extra_note, f"scan_vocab ({len(images)} Seiten)")

    logger.info("[LernBuddy AI] Vokabel-Scan: %d Seiten aufgeteilt in %d Batches", len(images), len(batches))
    with ThreadPoolExecutor(max_workers=min(2, len(batches))) as pool:
        futures = [
            pool.submit(
                _scan_vocab_batch,
                child,
                subject,
                batch,
                extra_note,
                f"scan_vocab Batch {idx + 1}/{len(batches)} ({len(batch)} Seiten)",
            )
            for idx, batch in enumerate(batches)
        ]
        results = [f.result() for f in futures]

    seen: set[tuple[str, str]] = set()
    merged_items: list[ScannedVocabItem] = []
    md_parts: list[str] = []
    for idx, res in enumerate(results, start=1):
        if res.extracted_markdown.strip():
            md_parts.append(f"### Abschnitt {idx}\n{res.extracted_markdown.strip()}")
        for it in res.items:
            key = (it.term_foreign.strip().lower(), it.term_german.strip().lower())
            if key not in seen and it.term_foreign.strip() and it.term_german.strip():
                seen.add(key)
                merged_items.append(it)

    return ScanVocabOutput(
        suggested_title=results[0].suggested_title or f"{subject['name']} Vokabeln",
        unit_name=results[0].unit_name or "Scan",
        extracted_markdown="\n\n".join(md_parts),
        items=merged_items,
    )


def _scan_exam_topic_batch(
    child: dict[str, Any],
    subject: dict[str, Any],
    images: list[tuple[bytes, str]],
    extra_note: str,
    batch_label: str,
) -> ScanExamTopicOutput:
    system = (
        "Du bist ein erfahrener Nachhilfelehrer für Grundschule und Unterstufe. "
        "Analysiere die Fotos von Schulbuchseiten, Arbeitsblättern oder Heftaufschrieben "
        "und strukturiere den Lernstoff prägnant in prüfungsrelevante Unterthemen mit Schlüsselbegriffen."
    )
    prompt = (
        f"Fach: {subject['name']}.\n"
        f"{_child_tone_instruction(child)}\n"
        f"Zusatzhinweis: {extra_note or 'keiner'}.\n\n"
        "1) Fasse die wichtigsten Fakten, Regeln, Begriffe und Beispiele der Seiten kompakt als Markdown-Stichpunkte zusammen (max. ca. 250 Wörter, kein Abschreiben langer Fließtexte).\n"
        "2) Gliedere den Stoff in 2 bis 4 klare Unterthemen (topics), die man gezielt für eine Prüfung üben kann."
    )
    contents = [*_images_to_parts(images), prompt]
    return _call_structured(
        contents,
        ScanExamTopicOutput,
        system,
        tier="fast",
        temperature=0.2,
        low_thinking=True,
        label=batch_label,
    )


def scan_exam_topic_images(
    child: dict[str, Any],
    subject: dict[str, Any],
    images: list[tuple[bytes, str]],
    extra_note: str = "",
) -> ScanExamTopicOutput:
    batches = _chunk_list(images, SCAN_BATCH_SIZE)
    if len(batches) == 1:
        return _scan_exam_topic_batch(child, subject, batches[0], extra_note, f"scan_exam ({len(images)} Seiten)")

    logger.info("[LernBuddy AI] Prüfungs-Scan: %d Seiten aufgeteilt in %d Batches", len(images), len(batches))
    with ThreadPoolExecutor(max_workers=min(2, len(batches))) as pool:
        futures = [
            pool.submit(
                _scan_exam_topic_batch,
                child,
                subject,
                batch,
                extra_note,
                f"scan_exam Batch {idx + 1}/{len(batches)} ({len(batch)} Seiten)",
            )
            for idx, batch in enumerate(batches)
        ]
        results = [f.result() for f in futures]

    seen_titles: set[str] = set()
    merged_topics: list[ScannedTopic] = []
    md_parts: list[str] = []
    for idx, res in enumerate(results, start=1):
        if res.extracted_markdown.strip():
            md_parts.append(f"### Seiten-Abschnitt {idx}\n{res.extracted_markdown.strip()}")
        for t in res.topics:
            key = t.title.strip().lower()
            if key and key not in seen_titles:
                seen_titles.add(key)
                merged_topics.append(t)

    return ScanExamTopicOutput(
        suggested_title=results[0].suggested_title or f"{subject['name']} Prüfung",
        extracted_markdown="\n\n".join(md_parts),
        topics=merged_topics,
    )


def generate_interactive_practice(
    child: dict[str, Any],
    subject: dict[str, Any],
    exam: dict[str, Any] | None,
    focus_topics: list[dict[str, Any]],
    reinforcement_topics: list[dict[str, Any]],
    weaknesses: list[dict[str, Any]],
    materials_excerpt: str,
    practice_style: str,
    question_count: int,
) -> GeneratedPracticeSet:
    style_instructions = {
        "adaptive_mix": (
            "Wähle pro Aufgabe den fachlich besten Fragetyp aus: "
            "multiple_choice, fill_blank, matching, open oder math_step. "
            "Bei Mathe nutze bevorzugt math_step mit 2-3 schrittweisen Sokrates-Tipps. "
            "Bei Sachunterricht/Biologie/Grammatik nutze gerne fill_blank, matching und open."
        ),
        "math_steps": (
            "Erstelle Mathe-Aufgaben vom Typ 'math_step' (und optional 1 Textaufgabe als 'open'). "
            "Jede Aufgabe MUSS 2-3 aufbauende Sokrates-Hinweise in 'hints' enthalten, die beim Rechenweg helfen, "
            "ohne die Endlösung vorwegzunehmen."
        ),
        "dictation": (
            "Erstelle eine Deutsch-Diktat-Übung! Alle Aufgaben haben question_type='dictation'. "
            "In 'speech_text' steht genau der einzelne Satz (oder die Wortgruppe), der dem Kind vorgelesen wird "
            "(altersgerecht lang). In 'expected_answer' steht exakt derselbe korrekte Satz. "
            "In 'prompt' steht eine kurze Anweisung wie 'Höre gut zu und schreibe Satz 1 auf.' "
            "Baue gezielt Rechtschreib-Stolperfallen aus den Materialien und Schwachstellen ein."
        ),
        "cloze_match": (
            "Nutze ausschließlich 'fill_blank' (Lückentext mit '___' im prompt) und 'matching' (3-4 Paare in match_pairs)."
        ),
        "open_explain": (
            "Nutze ausschließlich 'open' Verständnisfragen ('Erkläre in eigenen Worten...', 'Warum...?', 'Wie funktioniert...?'). "
            "Gib in 'expected_answer' die wichtigsten Kernpunkte für die inhaltliche Bewertung an."
        ),
    }

    system = (
        "Du bist ein geduldiger, ermutigender Lern-Coach für Kinder. "
        "Erstelle exakt die gewünschte Anzahl abwechslungsreicher, altersgerechter Übungsaufgaben. "
        "Gewichte ca. 70% der Aufgaben auf die Fokus-Themen und offenen Schwachstellen (targets_weakness=true) "
        "und ca. 30% auf Festigungs-Themen (targets_weakness=false) für Erfolgserlebnisse. "
        "WICHTIG: Bei multiple_choice immer genau 4 eindeutige Optionen und expected_answer muss exakt einer Option entsprechen. "
        "Bei matching immer 3-4 eindeutige Paare in match_pairs."
    )

    context_payload = {
        "fach": subject["name"],
        "pruefung": exam["title"] if exam else "Allgemeines Fach-Training",
        "fokus_themen_70_prozent": [
            {"id": t["id"], "title": t["title"], "description": t["description"], "mastery": t["mastery_score"]}
            for t in focus_topics
        ],
        "festigung_themen_30_prozent": [
            {"id": t["id"], "title": t["title"], "description": t["description"], "mastery": t["mastery_score"]}
            for t in reinforcement_topics
        ],
        "offene_schwachstellen": [
            {"summary": w["summary"], "example": w["example_mistake"]} for w in weaknesses[:8]
        ],
        "gescannter_lernstoff": materials_excerpt[:5000],
    }

    prompt = (
        f"{_child_tone_instruction(child)}\n"
        f"Anzahl Aufgaben: {question_count}\n"
        f"Übungsmodus: {practice_style} -> {style_instructions.get(practice_style, style_instructions['adaptive_mix'])}\n\n"
        f"Lernkontext (JSON):\n{json.dumps(context_payload, ensure_ascii=False)}\n\n"
        "Falls topic_id bekannt ist, übernimm die exakte numerische topic_id aus dem Lernkontext."
    )
    return _call_structured(
        [prompt],
        GeneratedPracticeSet,
        system,
        tier="fast",
        temperature=0.45,
        low_thinking=True,
        label=f"generate_practice ({subject['name']})",
    )


def evaluate_open_answer(
    child: dict[str, Any],
    subject: dict[str, Any],
    question_type: str,
    prompt_text: str,
    expected_answer: str,
    user_answer: str,
) -> AnswerEvaluationOutput:
    system = (
        "Du bist ein fairer, ermutigender Lern-Coach. "
        "Bewerte die Antwort eines Kindes altersgerecht und inhaltlich fair (bei offenen Fragen zählt das Verständnis, nicht der exakte Wortlaut; "
        "bei Diktaten achte gezielt auf Rechtschreibung, Groß-/Kleinschreibung und Satzzeichen und benenne das Fehlermuster konkret; "
        "bei Mathe prüfe auch Rechenansätze). "
        "Trage nur dann eine weakness_summary ein, wenn wirklich ein konkretes fachliches oder orthografisches Muster erkennbar ist."
    )
    prompt = (
        f"Fach: {subject['name']}\n"
        f"Aufgabentyp: {question_type}\n"
        f"{_child_tone_instruction(child)}\n\n"
        f"Aufgabe: {prompt_text}\n"
        f"Musterlösung / Kernpunkte: {expected_answer}\n"
        f"Antwort des Kindes: {user_answer}\n\n"
        "Bewerte die Antwort nach dem vorgegebenen JSON-Schema."
    )
    return _call_structured(
        [prompt],
        AnswerEvaluationOutput,
        system,
        tier="fast",
        temperature=0.2,
        low_thinking=True,
        label=f"evaluate_answer ({subject['name']})",
    )


def generate_worksheet(
    child: dict[str, Any],
    subject: dict[str, Any],
    exam: dict[str, Any] | None,
    topics: list[dict[str, Any]],
    weaknesses: list[dict[str, Any]],
    vocab_items: list[dict[str, Any]],
    materials_excerpt: str,
    duration_minutes: int,
    focus_mode: str,
    question_count: int,
) -> GeneratedWorksheetOutput:
    system = (
        "Du erstellst realistische, sauber strukturierte deutsche Schul-Arbeitsblätter und Probearbeiten zum Ausdrucken auf Papier. "
        "Jede Aufgabe hat klare Punkte, genug Platz zum Handschreiben (answer_space_lines: 3-8) und eine vollständige Musterlösung (model_solution) inkl. Rechenweg für Eltern."
    )
    payload: dict[str, Any] = {
        "fach": subject["name"],
        "pruefung": exam["title"] if exam else None,
        "dauer_minuten": duration_minutes,
        "fokus": focus_mode,
        "anzahl_aufgaben": question_count,
        "themen": [
            {"id": t["id"], "title": t["title"], "description": (t.get("description") or "")[:160], "mastery": t["mastery_score"]}
            for t in topics[:12]
        ],
        "offene_schwachstellen": [
            {"summary": w["summary"], "example": (w.get("example_mistake") or "")[:120]} for w in weaknesses[:8]
        ],
    }
    if focus_mode == "vocab" or (subject.get("subject_type") == "language" and vocab_items):
        payload["vokabeln_wichtig"] = [
            {"foreign": v["term_foreign"], "german": v["term_german"], "article": v["article"], "box": v["box"]}
            for v in vocab_items[:18]
        ]
    if materials_excerpt.strip():
        payload["material_auszug"] = materials_excerpt[:2400]

    prompt = (
        f"{_child_tone_instruction(child)}\n"
        f"Erstelle ein druckfertiges Arbeitsblatt mit genau {question_count} Aufgaben (Nr. 1 bis {question_count}).\n"
        "Halte Aufgabenstellungen und Musterlösungen klar und prägnant (keine unnötigen Romane).\n"
        f"Wenn fokus='weaknesses', adressiere gezielt die offenen Schwachstellen und Themen mit niedrigem mastery-Wert.\n"
        f"Wenn fokus='vocab', erstelle abwechslungsreiche schriftliche Vokabel- & Satzbildungsaufgaben.\n"
        f"Kontext:\n{json.dumps(payload, ensure_ascii=False)}"
    )
    return _call_structured(
        [prompt],
        GeneratedWorksheetOutput,
        system,
        tier="fast",
        temperature=0.35,
        low_thinking=True,
        label=f"generate_worksheet ({subject['name']})",
    )


def grade_worksheet_photos(
    child: dict[str, Any],
    subject: dict[str, Any],
    worksheet: dict[str, Any],
    images: list[tuple[bytes, str]],
) -> GradedWorksheetOutput:
    system = (
        "Du bist ein sehr sorgfältiger, wohlwollender Lehrer, der handschriftlich ausgefüllte Kinder-Arbeitsblätter anhand von Fotos korrigiert. "
        "Lies die Kinderhandschrift genau, prüfe bei Mathe unbedingt den Rechenweg (Teilpunkte geben, wenn der Ansatz stimmt!) "
        "und vergleiche jede Aufgabe mit den vorgegebenen Originalaufgaben und Musterlösungen. "
        "Bleibe ermutigend, lobe was gut geklappt hat, und benenne echte Schwachstellen präzise."
    )
    questions = json.loads(worksheet["questions_json"] or "[]")
    prompt = (
        f"Fach: {subject['name']}\n"
        f"Arbeitsblatt: {worksheet['title']} (Code: {worksheet['code']})\n"
        f"{_child_tone_instruction(child)}\n\n"
        f"Originalaufgaben & Musterlösungen:\n{json.dumps(questions, ensure_ascii=False)}\n\n"
        "Korrigiere jede einzelne Aufgabe anhand der beigefügten Fotos des ausgefüllten Blatts. "
        "Wenn eine Aufgabe auf den Fotos leer oder nicht gelöst ist, setze status='missing' und points_awarded=0. "
        "Übernimm die exakte Aufgaben-Nummer (number) und topic_id aus den Originalaufgaben."
    )
    contents = [*_images_to_parts(images), prompt]
    return _call_structured(
        contents,
        GradedWorksheetOutput,
        system,
        tier="smart",
        temperature=0.15,
        low_thinking=False,
        label=f"grade_worksheet ({worksheet['code']}, {len(images)} Seiten)",
    )


def generate_parent_report(child: dict[str, Any], overview_data: dict[str, Any]) -> ParentReportOutput:
    system = (
        "Du schreibst eine klare, hilfreiche, empathische Lernstand-Zusammenfassung für Eltern auf Deutsch. "
        "Keine Floskeln, sondern konkrete Beobachtungen aus den Daten, echte Stärken, die wichtigsten Schwachstellen "
        "und 3 direkt umsetzbare Mini-Schritte für die nächsten Tage."
    )
    prompt = (
        f"Erstelle einen Elternbericht für {child['name']} ({child['age']} Jahre, {child['grade']}).\n"
        f"Aktuelle Lernstandsdaten:\n{json.dumps(overview_data, ensure_ascii=False)}"
    )
    return _call_structured(
        [prompt],
        ParentReportOutput,
        system,
        tier="smart",
        temperature=0.35,
        low_thinking=True,
        label=f"parent_report ({child['name']})",
    )
