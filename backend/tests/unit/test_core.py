import logging
import uuid

import pytest

from app.core.errors import ApiError, format_loc
from app.core.ids import uuid7
from app.core.logging import RedactingFilter, redact
from app.core.ratelimit import RateLimiter
from app.security import passwords
from app.security.tokens import decrypt_secret, encrypt_secret, hash_token, new_recovery_code


def test_uuid7_is_time_ordered_and_valid() -> None:
    ids = [uuid7() for _ in range(5000)]
    assert ids == sorted(ids)
    assert len(set(ids)) == 5000
    assert all(value.version == 7 and value.variant == uuid.RFC_4122 for value in ids[:50])


def test_format_loc() -> None:
    assert format_loc(("columns", 3, "color")) == "columns[3].color"
    assert format_loc(("meta", "name")) == "meta.name"


def test_password_policy() -> None:
    with pytest.raises(ApiError) as short:
        passwords.validate_password("short")
    assert short.value.code == "weak_password"
    with pytest.raises(ApiError) as breached:
        passwords.validate_password("qwertyuiop123")
    assert breached.value.code == "breached_password"
    passwords.validate_password("my very own long phrase 42")


def test_argon2id_hash_format() -> None:
    hashed = passwords.hash_password("some-password-123")
    assert hashed.startswith("$argon2id$")
    assert passwords.verify_password(hashed, "some-password-123")
    assert not passwords.verify_password(hashed, "wrong")
    assert not passwords.verify_password("not-a-hash", "x")


def test_secret_encryption_round_trip() -> None:
    sealed = encrypt_secret("k" * 40, "JBSWY3DPEHPK3PXP")
    assert "JBSWY3" not in sealed
    assert decrypt_secret("k" * 40, sealed) == "JBSWY3DPEHPK3PXP"


def test_recovery_code_shape_and_token_hash() -> None:
    assert len(new_recovery_code()) == 11
    assert hash_token("a") != hash_token("b")


@pytest.mark.parametrize(
    "line",
    [
        "login alice@example.com failed",
        "password=hunter2 ok",
        '{"password": "hunter2"}',
        "token: abcdef",
        "cookie=kanbanly_session=zzz",
        "reset " + "A" * 43,
    ],
)
def test_redaction_removes_secrets(line: str) -> None:
    cleaned = redact(line)
    for secret in ("alice@example.com", "hunter2", "abcdef", "zzz", "A" * 43):
        assert secret not in cleaned


def test_redacting_filter_formats_args() -> None:
    record = logging.LogRecord("x", logging.INFO, "f", 1, "user %s", ("bob@example.com",), None)
    assert RedactingFilter().filter(record)
    assert "bob@example.com" not in record.getMessage()


class FakeClock:
    now = 0.0

    def __call__(self) -> float:
        return self.now


def test_rate_limit_exponential_lock() -> None:
    clock = FakeClock()
    limiter = RateLimiter(5, 60, clock)
    key = limiter.key("login", "1.1.1.1", "A@b.c")
    assert key == limiter.key("login", "1.1.1.1", "a@b.c ")
    for _ in range(5):
        limiter.hit(key)
    with pytest.raises(ApiError) as first:
        limiter.hit(key)
    assert first.value.details == {"retry_after": 60}
    clock.now = 61
    for _ in range(5):
        limiter.hit(key)
    with pytest.raises(ApiError) as second:
        limiter.hit(key)
    assert second.value.details == {"retry_after": 120}
    with pytest.raises(ApiError):
        limiter.hit(key)


def test_rate_limit_window_slides() -> None:
    clock = FakeClock()
    limiter = RateLimiter(2, 10, clock)
    limiter.hit("k")
    limiter.hit("k")
    clock.now = 11
    limiter.hit("k")
