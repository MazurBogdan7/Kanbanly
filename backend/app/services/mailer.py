"""Отправка писем. Письма содержат токены и email, поэтому в лог они не пишутся никогда."""

from datetime import UTC, datetime
from email.message import EmailMessage
from pathlib import Path
from typing import Protocol

import aiosmtplib

from app.core.config import Settings
from app.core.ids import uuid7


class Mailer(Protocol):
    async def send(self, to: str, subject: str, body: str) -> None: ...


class SmtpMailer:
    """MailHog в dev, настоящий SMTP в prod."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def send(self, to: str, subject: str, body: str) -> None:
        message = EmailMessage()
        message["From"] = self.settings.mail_from
        message["To"] = to
        message["Subject"] = subject
        message.set_content(body)
        await aiosmtplib.send(
            message,
            hostname=self.settings.smtp_host,
            port=self.settings.smtp_port,
            username=self.settings.smtp_username,
            password=self.settings.smtp_password,
            start_tls=self.settings.smtp_starttls,
        )


class FileMailer:
    """Для запуска без SMTP: письмо ложится файлом в каталог, закрытый в .gitignore."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory

    async def send(self, to: str, subject: str, body: str) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        path = self.directory / f"{stamp}-{uuid7().hex[:8]}.txt"
        path.write_text(f"To: {to}\nSubject: {subject}\n\n{body}\n", encoding="utf-8")


class MemoryMailer:
    """Для тестов."""

    def __init__(self) -> None:
        self.sent: list[dict[str, str]] = []

    async def send(self, to: str, subject: str, body: str) -> None:
        self.sent.append({"to": to, "subject": subject, "body": body})


def build_mailer(settings: Settings) -> Mailer:
    if settings.env == "test":
        return MemoryMailer()
    if settings.smtp_host:
        return SmtpMailer(settings)
    return FileMailer(settings.dev_mail_dir)
