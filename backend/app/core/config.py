"""Настройки приложения: только из окружения, секретов в коде нет."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

INSECURE_DEV_KEY = "dev-only-insecure-secret-key-change-me-0123456789"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="KANBANLY_", env_file=".env", extra="ignore")

    env: Literal["dev", "test", "prod"] = "dev"
    database_url: str = "postgresql+asyncpg://kanbanly:kanbanly@localhost:5432/kanbanly"
    secret_key: str = Field(default=INSECURE_DEV_KEY, min_length=32)

    session_cookie: str = "kanbanly_session"
    csrf_cookie: str = "kanbanly_csrf"
    session_idle_days: int = 7
    cookie_secure: bool = True
    password_reset_ttl_minutes: int = 30

    # Общий барьер на IP+email в минуту: от массовых запросов, а не от подбора одного пароля.
    rate_limit_attempts: int = 30
    # После стольких неудачных входов подряд аккаунт блокируется до разблокировки.
    login_lock_threshold: int = 20
    rate_limit_window_seconds: int = 60

    template_max_bytes: int = 1_048_576
    # Бэкап включает документы проектов, поэтому лимит больше, чем у шаблона.
    backup_max_bytes: int = 209_715_200
    file_max_bytes: int = 26_214_400
    json_max_depth: int = 32
    trash_retention_days: int = 30

    smtp_host: str | None = None
    smtp_port: int = 1025
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_starttls: bool = False
    mail_from: str = "Kanbanly <no-reply@kanbanly.local>"
    dev_mail_dir: Path = Path("var/dev-mail")
    public_url: str = "http://localhost:8080"

    static_dir: Path | None = None

    @model_validator(mode="after")
    def _prod_requires_real_secrets(self) -> "Settings":
        if self.env == "prod":
            if self.secret_key == INSECURE_DEV_KEY or "replace-with" in self.secret_key:
                raise ValueError("KANBANLY_SECRET_KEY обязателен в prod")
            if "replace-with" in self.database_url:
                raise ValueError("Задайте пароль БД в KANBANLY_DATABASE_URL")
            if not self.cookie_secure:
                raise ValueError("В prod обязателен KANBANLY_COOKIE_SECURE=true")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
