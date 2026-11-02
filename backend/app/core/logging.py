"""Логирование с фильтром секретов: email, токены и пароли не должны попасть в лог."""

import logging
import re

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
SECRET_PAIR_RE = re.compile(
    r"(?i)\b(password|passwd|pwd|token|secret|session|csrf|cookie|authorization|totp_code|recovery_code)"
    r"(['\"]?\s*[:=]\s*['\"]?)([^\s'\",;&}]+)"
)
LONG_TOKEN_RE = re.compile(r"\b[A-Za-z0-9_\-]{40,}\b")
MASK = "***"


def redact(text: str) -> str:
    text = SECRET_PAIR_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{MASK}", text)
    text = EMAIL_RE.sub(MASK, text)
    return LONG_TOKEN_RE.sub(MASK, text)


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        record.msg = redact(message)
        record.args = None
        return True


def configure_logging(level: int = logging.INFO) -> None:
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    install_redaction(root)


def install_redaction(logger: logging.Logger) -> None:
    for handler in logger.handlers:
        if not any(isinstance(f, RedactingFilter) for f in handler.filters):
            handler.addFilter(RedactingFilter())
    if not any(isinstance(f, RedactingFilter) for f in logger.filters):
        logger.addFilter(RedactingFilter())
    for name in ("uvicorn.access", "uvicorn.error", "sqlalchemy.engine"):
        named = logging.getLogger(name)
        if not any(isinstance(f, RedactingFilter) for f in named.filters):
            named.addFilter(RedactingFilter())
