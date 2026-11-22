from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field


# --- Auth ---
class FamilyLoginRequest(BaseModel):
    password: str
    remember: bool = True


class ParentUnlockRequest(BaseModel):
    pin: str


# --- Child & Subject ---
class ChildUpdateRequest(BaseModel):
    name: str | None = None
    age: int | None = None
    grade: str | None = None
    avatar: str | None = None
    clear_avatar_image: bool = False
    ui_mode: Literal["junior", "standard"] | None = None
    settings: dict[str, Any] | None = None


class ChildSelfProfileUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=40)
    age: int | None = Field(default=None, ge=5, le=18)
    avatar: str | None = Field(default=None, min_length=1, max_length=16)
    clear_avatar_image: bool = False


class ChildSubjectsUpdateRequest(BaseModel):
    enabled_subject_ids: list[int]


# --- Vocab ---
class VocabItemIn(BaseModel):
    unit_name: str = "Allgemein"
    term_foreign: str
    term_german: str
    article: str = ""
    example_sentence: str = ""
    hint: str = ""


class VocabBulkCreateRequest(BaseModel):
    subject_id: int
    material_id: int | None = None
    items: list[VocabItemIn]


class VocabReviewRequest(BaseModel):
    vocab_id: int
    mode: Literal["flashcard", "multiple_choice", "typing"]
    user_input: str | None = None
    self_rating: Literal["correct", "almost", "wrong"] | None = None
    direction: Literal["de_to_foreign", "foreign_to_de"] = "de_to_foreign"


# --- Exams & Topics ---
class TopicIn(BaseModel):
    title: str
    description: str = ""
    key_concepts: list[str] = Field(default_factory=list)


class ExamCreateRequest(BaseModel):
    subject_id: int
    title: str
    exam_date: str | None = None
    notes: str = ""
    topics: list[TopicIn] = Field(default_factory=list)
    material_id: int | None = None


class ExamUpdateRequest(BaseModel):
    title: str | None = None
    exam_date: str | None = None
    notes: str | None = None
    status: Literal["active", "completed"] | None = None


class MaterialCommitRequest(BaseModel):
    subject_id: int
    material_type: Literal["vocab", "exam_topic"]
    title: str
    image_paths: list[str] = Field(default_factory=list)
    extracted_markdown: str = ""
    # For vocab:
    unit_name: str = "Scan"
    vocab_items: list[VocabItemIn] = Field(default_factory=list)
    # For exam_topic:
    exam_id: int | None = None
    new_exam_title: str | None = None
    new_exam_date: str | None = None
    topics: list[TopicIn] = Field(default_factory=list)


# --- Interactive Practice ---
class PracticeGenerateRequest(BaseModel):
    subject_id: int
    exam_id: int | None = None
    practice_style: Literal["adaptive_mix", "math_steps", "dictation", "cloze_match", "open_explain"] = "adaptive_mix"
    question_count: int = 6


class PracticeEvaluateAnswerRequest(BaseModel):
    subject_id: int
    exam_id: int | None = None
    topic_id: int | None = None
    question_type: str
    prompt: str
    expected_answer: str
    user_answer: str
    grading_rubric: str = ""


class PracticeFinishRequest(BaseModel):
    subject_id: int
    exam_id: int | None = None
    mode: str = "exam_interactive"
    score: int
    max_score: int
    topic_results: list[dict[str, Any]] = Field(default_factory=list)
    detected_weaknesses: list[dict[str, Any]] = Field(default_factory=list)


# --- Worksheets (Print + Photo Grading) ---
class WorksheetGenerateRequest(BaseModel):
    subject_id: int
    exam_id: int | None = None
    title: str | None = None
    duration_minutes: int = 15
    focus_mode: Literal["weaknesses", "mixed", "vocab"] = "weaknesses"
    question_count: int = 6


# --- Parent / Settings ---
class WeaknessUpdateRequest(BaseModel):
    resolved: bool | None = None
    severity: int | None = None


class AISettingsUpdateRequest(BaseModel):
    gemini_model_fast: str | None = None
    gemini_model_smart: str | None = None


# ============================================================
# Gemini Structured Output Schemas (used with response_schema)
# ============================================================

class ScannedVocabItem(BaseModel):
    term_foreign: str = Field(description="Wort in der Fremdsprache, ohne deutschen Text")
    term_german: str = Field(description="Deutsche Übersetzung")
    article: str = Field(default="", description="Optionaler Artikel (z.B. le, la, l', un, une bei Französisch)")
    example_sentence: str = Field(default="", description="Kurzer Beispielsatz falls vorhanden oder hilfreich")
    hint: str = Field(default="", description="Kurze Merkhilfe oder Stolperfalle (z.B. Akzent, unregelmäßige Form)")


class ScanVocabOutput(BaseModel):
    suggested_title: str
    unit_name: str
    extracted_markdown: str = Field(description="Saubere Markdown-Zusammenfassung der gescannten Seite")
    items: list[ScannedVocabItem]


class ScannedTopic(BaseModel):
    title: str
    description: str
    key_concepts: list[str] = Field(default_factory=list)


class ScanExamTopicOutput(BaseModel):
    suggested_title: str
    extracted_markdown: str = Field(description="Vollständige strukturierte Zusammenfassung der Buch-/Heftseite(n)")
    topics: list[ScannedTopic]


class MatchPair(BaseModel):
    left: str
    right: str


class GeneratedQuestion(BaseModel):
    id: str
    topic_id: int | None = None
    topic_title: str = ""
    question_type: Literal["multiple_choice", "fill_blank", "matching", "open", "math_step", "dictation"]
    prompt: str = Field(description="Klare, altersgerechte Aufgabenstellung")
    speech_text: str = Field(default="", description="Bei Diktat: der vorzulesende Satz/Text; sonst optional")
    options: list[str] = Field(default_factory=list, description="Bei multiple_choice: 4 Antwortmöglichkeiten")
    match_pairs: list[MatchPair] = Field(default_factory=list, description="Bei matching: 3-4 zusammengehörige Paare")
    hints: list[str] = Field(default_factory=list, description="1-3 schrittweise Sokrates-Tipps ohne die Endlösung sofort zu verraten")
    expected_answer: str = Field(description="Musterlösung / erwartete Antwort")
    explanation: str = Field(description="Kurze, kindgerechte Erklärung der Lösung")
    points: int = 2
    targets_weakness: bool = False


class GeneratedPracticeSet(BaseModel):
    title: str
    intro_message: str
    questions: list[GeneratedQuestion]


class AnswerEvaluationOutput(BaseModel):
    is_correct: bool
    partial_credit: bool = False
    score_ratio: float = Field(ge=0.0, le=1.0)
    feedback: str = Field(description="Ermutigendes, altersgerechtes Feedback auf Deutsch")
    next_hint: str = Field(default="", description="Kleiner Hinweis falls nicht richtig")
    weakness_summary: str = Field(default="", description="Kurze konkrete Schwachstellen-Diagnose nur wenn ein klarer Fehler/Verständnisproblem vorliegt, sonst leer")
    weakness_example: str = Field(default="", description="Konkretes Fehlerbeispiel falls Schwachstelle erkannt")
    weakness_recommendation: str = Field(default="", description="Konkreter Übungstipp falls Schwachstelle erkannt")


class WorksheetQuestion(BaseModel):
    number: int
    topic_id: int | None = None
    topic_title: str = ""
    prompt: str
    sub_items: list[str] = Field(default_factory=list, description="Optional a), b), c) Teilaufgaben")
    answer_space_lines: int = Field(default=4, description="Empfohlene Anzahl Schreiblinien oder Kästchen-Zeilen")
    points: int = 2
    model_solution: str = Field(description="Vollständige Musterlösung inkl. Rechenweg")
    grading_notes: str = Field(default="", description="Worauf bei der Korrektur zu achten ist")


class GeneratedWorksheetOutput(BaseModel):
    title: str
    instructions: str
    questions: list[WorksheetQuestion]


class GradedWorksheetItem(BaseModel):
    number: int
    topic_id: int | None = None
    transcribed_answer: str = Field(description="Was das Kind handschriftlich geschrieben hat")
    points_awarded: int
    max_points: int
    status: Literal["correct", "partial", "wrong", "missing"]
    feedback: str = Field(description="Freundliche, klare Erklärung inkl. Rechenweg-Feedback")
    detected_weakness: str = Field(default="", description="Konkrete Schwachstelle falls erkennbar, sonst leer")
    weakness_recommendation: str = Field(default="", description="Kurzer Übungstipp falls Schwachstelle erkannt")


class GradedWorksheetOutput(BaseModel):
    overall_feedback: str
    praise: str
    total_points: int
    max_points: int
    items: list[GradedWorksheetItem]


class ParentReportOutput(BaseModel):
    headline: str
    overall_summary: str
    strengths: list[str]
    top_weaknesses: list[str]
    concrete_next_steps: list[str]
    motivation_tip: str
