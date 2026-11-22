from __future__ import annotations

import os
import secrets
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


class Settings:
    def __init__(self) -> None:
        self.reload()

    def reload(self) -> None:
        load_dotenv(BASE_DIR / ".env", override=False)
        data_dir_env = os.getenv("DATA_DIR", "").strip()
        self.data_dir = Path(data_dir_env) if data_dir_env else BASE_DIR / "data"
        self.uploads_dir = self.data_dir / "uploads"
        self.db_path = self.data_dir / "lernbuddy.db"

        self.gemini_api_key = os.getenv("GEMINI_API_KEY", "").strip()
        self.gemini_model_fast = os.getenv("GEMINI_MODEL_FAST", "gemini-3.8-flash").strip()
        self.gemini_model_smart = os.getenv("GEMINI_MODEL_SMART", "gemini-4-hydrogen").strip()

        self.family_password = os.getenv("FAMILY_PASSWORD", "familie2026").strip()
        self.parent_pin = os.getenv("PARENT_PIN", "1234").strip()

        self.cookie_secure = os.getenv("COOKIE_SECURE", "false").lower() in ("1", "true", "yes")
        self.session_days = int(os.getenv("SESSION_DAYS", "30"))
        self.parent_session_minutes = int(os.getenv("PARENT_SESSION_MINUTES", "45"))
        self.port = int(os.getenv("PORT", "8000"))

        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.uploads_dir.mkdir(parents=True, exist_ok=True)

        secret_env = os.getenv("SESSION_SECRET", "").strip()
        if secret_env:
            self.session_secret = secret_env
        else:
            secret_file = self.data_dir / ".session_secret"
            if secret_file.exists():
                self.session_secret = secret_file.read_text(encoding="utf-8").strip()
            else:
                self.session_secret = secrets.token_hex(32)
                secret_file.write_text(self.session_secret, encoding="utf-8")

    @property
    def has_gemini_key(self) -> bool:
        return bool(self.gemini_api_key and self.gemini_api_key != "dein-gemini-api-key-hier")

    @property
    def using_default_credentials(self) -> bool:
        return self.family_password == "familie2026" or self.parent_pin == "1234"


settings = Settings()
