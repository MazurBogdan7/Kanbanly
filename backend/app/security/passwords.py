"""Хэширование Argon2id и парольная политика."""

import gzip
from functools import lru_cache
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.core.errors import ApiError

MIN_LENGTH = 10
MAX_LENGTH = 256
BREACHED_FILE = Path(__file__).parent / "data" / "breached-top-100k.txt.gz"

_hasher = PasswordHasher()
# Проверка фиктивного хэша уравнивает время ответа для несуществующего email.
_DUMMY_HASH = _hasher.hash("kanbanly-dummy-password-for-timing")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def burn_verification(password: str) -> None:
    verify_password(_DUMMY_HASH, password)


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


@lru_cache(maxsize=1)
def _breached() -> frozenset[str]:
    with gzip.open(BREACHED_FILE, "rt", encoding="utf-8", errors="ignore") as handle:
        return frozenset(line.strip().lower() for line in handle if line.strip())


def is_breached(password: str) -> bool:
    return password.lower() in _breached()


def validate_password(password: str) -> None:
    if len(password) < MIN_LENGTH:
        raise ApiError(422, "weak_password", f"Пароль должен быть не короче {MIN_LENGTH} символов")
    if len(password) > MAX_LENGTH:
        raise ApiError(422, "weak_password", f"Пароль должен быть не длиннее {MAX_LENGTH} символов")
    if is_breached(password):
        raise ApiError(422, "breached_password", "Этот пароль есть в списках утечек. Выберите другой.")
