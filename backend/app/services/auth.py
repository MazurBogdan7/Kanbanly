"""Аккаунты, сессии, 2FA и сброс пароля."""

import logging
import re
from datetime import timedelta
from uuid import UUID

import pyotp
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.db import utcnow
from app.core.errors import ApiError
from app.models import PasswordResetToken, RecoveryCode, User, UserSession
from app.schemas.auth import USERNAME_PATTERN
from app.security import passwords
from app.security.tokens import (
    decrypt_secret,
    encrypt_secret,
    hash_token,
    new_recovery_code,
    new_token,
)
from app.services import app_settings
from app.services.audit import audit
from app.services.mailer import Mailer

logger = logging.getLogger(__name__)

TOTP_ISSUER = "Kanbanly"
RECOVERY_CODE_COUNT = 10
SESSION_TOUCH_SECONDS = 60


def normalize_email(email: str) -> str:
    return email.strip().lower()


async def find_user(db: AsyncSession, email: str) -> User | None:
    result = await db.execute(select(User).where(User.email == normalize_email(email)))
    return result.scalar_one_or_none()


async def register(db: AsyncSession, email: str, password: str, display_name: str) -> User:
    first = (await db.scalar(select(func.count(User.id)))) == 0
    # Первый пользователь сервера — администратор, и для него регистрация открыта всегда.
    if not first and not await app_settings.get(db, "registration_open"):
        raise ApiError(403, "registration_closed", "Регистрация закрыта. Обратитесь к администратору.")
    passwords.validate_password(password)
    user = User(
        email=normalize_email(email),
        password_hash=passwords.hash_password(password),
        display_name=display_name.strip() or email.split("@")[0],
        is_admin=first,
    )
    db.add(user)
    try:
        await db.flush()
    except IntegrityError as exc:
        raise ApiError(409, "email_taken", "Аккаунт с таким email уже существует") from exc
    return user


async def authenticate(
    db: AsyncSession,
    settings: Settings,
    email: str,
    password: str,
    totp_code: str | None,
    recovery_code: str | None,
) -> User:
    user = await find_user(db, email)
    if user is None:
        passwords.burn_verification(password)
        raise ApiError(401, "invalid_credentials", "Неверный email или пароль")
    valid = passwords.verify_password(user.password_hash, password)
    if user.locked_at is not None:
        raise locked_error(settings)
    if not valid:
        await _register_failure(db, settings, user)
        raise ApiError(401, "invalid_credentials", "Неверный email или пароль")
    if not user.is_active:
        raise ApiError(403, "account_disabled", "Аккаунт отключён. Обратитесь к администратору.")
    if passwords.needs_rehash(user.password_hash):
        user.password_hash = passwords.hash_password(password)
    if user.totp_enabled:
        try:
            await _check_second_factor(db, settings, user, totp_code, recovery_code)
        except ApiError as exc:
            # Подбор кода второго фактора считается так же, как подбор пароля.
            if exc.code == "invalid_second_factor":
                await _register_failure(db, settings, user)
            raise
    user.failed_logins = 0
    user.last_login_at = utcnow()
    return user


def locked_error(settings: Settings) -> ApiError:
    return ApiError(
        423,
        "account_locked",
        f"Аккаунт заблокирован после {settings.login_lock_threshold} неудачных попыток входа. "
        "Обратитесь к администратору или восстановите пароль через «Забыли пароль?».",
    )


async def _register_failure(db: AsyncSession, settings: Settings, user: User) -> None:
    """Счётчик сохраняется сразу: ответ с ошибкой откатил бы транзакцию запроса."""
    user.failed_logins += 1
    lock = user.failed_logins >= settings.login_lock_threshold
    if lock:
        user.locked_at = utcnow()
        audit(db, user.id, "auth.locked", attempts=user.failed_logins)
    await db.commit()
    if lock:
        raise locked_error(settings)


def unlock(user: User) -> None:
    user.failed_logins = 0
    user.locked_at = None


async def _check_second_factor(
    db: AsyncSession, settings: Settings, user: User, totp_code: str | None, recovery_code: str | None
) -> None:
    if recovery_code:
        if await consume_recovery_code(db, user.id, recovery_code):
            return
        raise ApiError(401, "invalid_second_factor", "Неверный код")
    if not totp_code:
        raise ApiError(401, "totp_required", "Нужен код двухфакторной аутентификации")
    if not verify_totp(settings, user, totp_code):
        raise ApiError(401, "invalid_second_factor", "Неверный код")


async def consume_recovery_code(db: AsyncSession, user_id: UUID, code: str) -> bool:
    code_hash = hash_token(code.strip().upper())
    result = await db.execute(
        select(RecoveryCode).where(
            RecoveryCode.user_id == user_id,
            RecoveryCode.code_hash == code_hash,
            RecoveryCode.used_at.is_(None),
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        return False
    row.used_at = utcnow()
    return True


def verify_totp(settings: Settings, user: User, code: str) -> bool:
    if user.totp_secret is None:
        return False
    secret = decrypt_secret(settings.secret_key, user.totp_secret)
    return pyotp.TOTP(secret).verify(code.strip(), valid_window=1)


async def create_session(db: AsyncSession, user: User, user_agent: str, ip: str) -> str:
    token = new_token()
    db.add(UserSession(user_id=user.id, token_hash=hash_token(token), user_agent=user_agent[:255], ip=ip))
    return token


async def resolve_session(
    db: AsyncSession, settings: Settings, token: str
) -> tuple[User, UserSession, bool] | None:
    """Пользователь, сессия и признак продления (тогда cookie нужно выдать заново)."""
    result = await db.execute(
        select(User, UserSession)
        .join(UserSession, UserSession.user_id == User.id)
        .where(UserSession.token_hash == hash_token(token))
    )
    row = result.first()
    if row is None:
        return None
    user, session = row
    if not user.is_active:
        return None
    now = utcnow()
    if now - session.last_seen_at > timedelta(days=settings.session_idle_days):
        await db.delete(session)
        return None
    touched = (now - session.last_seen_at).total_seconds() > SESSION_TOUCH_SECONDS
    if touched:
        session.last_seen_at = now
    return user, session, touched


async def revoke_session_by_token(db: AsyncSession, token: str) -> None:
    await db.execute(delete(UserSession).where(UserSession.token_hash == hash_token(token)))


async def revoke_all_sessions(db: AsyncSession, user_id: UUID, except_id: UUID | None = None) -> None:
    statement = delete(UserSession).where(UserSession.user_id == user_id)
    if except_id is not None:
        statement = statement.where(UserSession.id != except_id)
    await db.execute(statement)


async def change_password(
    db: AsyncSession, user: User, current: str, new: str, session_id: UUID | None
) -> None:
    if not passwords.verify_password(user.password_hash, current):
        raise ApiError(400, "invalid_password", "Текущий пароль указан неверно")
    passwords.validate_password(new)
    user.password_hash = passwords.hash_password(new)
    await revoke_all_sessions(db, user.id, except_id=session_id)


async def request_password_reset(db: AsyncSession, settings: Settings, mailer: Mailer, email: str) -> None:
    user = await find_user(db, email)
    if user is None:
        return
    await db.execute(
        update(PasswordResetToken)
        .where(PasswordResetToken.user_id == user.id, PasswordResetToken.used_at.is_(None))
        .values(used_at=utcnow())
    )
    token = new_token()
    db.add(
        PasswordResetToken(
            user_id=user.id,
            token_hash=hash_token(token),
            expires_at=utcnow() + timedelta(minutes=settings.password_reset_ttl_minutes),
        )
    )
    link = f"{settings.public_url}/reset-password?token={token}"
    body = (
        f"Ссылка для сброса пароля (действует {settings.password_reset_ttl_minutes} минут):\n{link}\n\n"
        "Если вы не запрашивали сброс, просто проигнорируйте это письмо."
    )
    try:
        await mailer.send(user.email, "Сброс пароля Kanbanly", body)
    except Exception:
        # Ответ обязан быть одинаковым: ошибка почты не должна раскрывать наличие аккаунта.
        logger.error("Не удалось отправить письмо сброса пароля")


async def confirm_password_reset(db: AsyncSession, token: str, new_password: str) -> User:
    passwords.validate_password(new_password)
    result = await db.execute(
        select(PasswordResetToken).where(PasswordResetToken.token_hash == hash_token(token))
    )
    row = result.scalar_one_or_none()
    if row is None or row.used_at is not None or row.expires_at < utcnow():
        raise ApiError(400, "invalid_token", "Ссылка недействительна или устарела")
    user = await db.get(User, row.user_id)
    if user is None:
        raise ApiError(400, "invalid_token", "Ссылка недействительна или устарела")
    user.password_hash = passwords.hash_password(new_password)
    row.used_at = utcnow()
    # Владелец доказал доступ к почте: блокировка за подбор снимается.
    unlock(user)
    await revoke_all_sessions(db, user.id)
    return user


def begin_totp_setup(settings: Settings, user: User) -> tuple[str, str]:
    if user.totp_enabled:
        raise ApiError(409, "totp_already_enabled", "Двухфакторная аутентификация уже включена")
    secret = pyotp.random_base32()
    user.totp_secret = encrypt_secret(settings.secret_key, secret)
    uri = pyotp.TOTP(secret).provisioning_uri(name=user.email, issuer_name=TOTP_ISSUER)
    return secret, uri


async def enable_totp(db: AsyncSession, settings: Settings, user: User, code: str) -> list[str]:
    if user.totp_enabled or user.totp_secret is None:
        raise ApiError(409, "totp_not_pending", "Сначала начните настройку двухфакторной аутентификации")
    if not verify_totp(settings, user, code):
        raise ApiError(400, "invalid_second_factor", "Неверный код")
    user.totp_enabled = True
    codes = [new_recovery_code() for _ in range(RECOVERY_CODE_COUNT)]
    await db.execute(delete(RecoveryCode).where(RecoveryCode.user_id == user.id))
    db.add_all(RecoveryCode(user_id=user.id, code_hash=hash_token(code)) for code in codes)
    return codes


async def disable_totp(db: AsyncSession, user: User, password: str) -> None:
    if not passwords.verify_password(user.password_hash, password):
        raise ApiError(400, "invalid_password", "Пароль указан неверно")
    user.totp_enabled = False
    user.totp_secret = None
    await db.execute(delete(RecoveryCode).where(RecoveryCode.user_id == user.id))


async def delete_account(db: AsyncSession, user: User, password: str) -> None:
    if not passwords.verify_password(user.password_hash, password):
        raise ApiError(400, "invalid_password", "Пароль указан неверно")
    await db.execute(delete(User).where(User.id == user.id))


def normalize_username(value: str) -> str:
    return value.strip().removeprefix("@").lower()


async def set_username(db: AsyncSession, user: User, value: str) -> str | None:
    """Ник уникален без учёта регистра; занятый ник — 409, неверный формат — 422."""
    username = normalize_username(value)
    if not username:
        return None
    if not re.fullmatch(USERNAME_PATTERN, username):
        raise ApiError(
            422,
            "invalid_username",
            "Ник: от 3 до 32 символов — латинские буквы, цифры, «_», «.» или «-»",
        )
    taken = await db.execute(select(User.id).where(User.username == username, User.id != user.id))
    if taken.first() is not None:
        raise ApiError(409, "username_taken", "Этот ник уже занят")
    return username
