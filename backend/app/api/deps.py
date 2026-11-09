"""Зависимости запроса: БД, текущий пользователь, версии для оптимистической блокировки."""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Annotated, Protocol
from uuid import UUID

from fastapi import Depends, Header, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.db import session_scope
from app.core.errors import ApiError, conflict, unauthorized
from app.core.ratelimit import RateLimiter
from app.models import User
from app.services import auth as auth_service
from app.services.mailer import Mailer


async def _get_db(request: Request) -> AsyncIterator[AsyncSession]:
    async for session in session_scope(request.app.state.session_factory):
        yield session


# scope="function": commit выполняется до отправки ответа, а не после.
Db = Annotated[AsyncSession, Depends(_get_db, scope="function")]


def _get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def _get_limiter(request: Request) -> RateLimiter:
    limiter: RateLimiter = request.app.state.limiter
    return limiter


def _get_mailer(request: Request) -> Mailer:
    mailer: Mailer = request.app.state.mailer
    return mailer


AppSettings = Annotated[Settings, Depends(_get_settings)]
Limiter = Annotated[RateLimiter, Depends(_get_limiter)]
AppMailer = Annotated[Mailer, Depends(_get_mailer)]


@dataclass(slots=True)
class Principal:
    user: User
    session_id: UUID
    token: str

    @property
    def id(self) -> UUID:
        return self.user.id


async def _current(request: Request, response: Response, db: Db, settings: AppSettings) -> Principal:
    token = request.cookies.get(settings.session_cookie)
    if not token:
        raise unauthorized()
    resolved = await auth_service.resolve_session(db, settings, token)
    if resolved is None:
        raise unauthorized("Сессия истекла, войдите снова")
    user, session, touched = resolved
    if touched:
        # Срок cookie сдвигается вместе с сессией: активного пользователя не выкидывает через 7 дней.
        set_session_cookie(response, settings, token)
    return Principal(user, session.id, token)


Current = Annotated[Principal, Depends(_current)]


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def set_session_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(
        settings.session_cookie,
        token,
        max_age=settings.session_idle_days * 86400,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(settings.session_cookie, path="/")


def set_csrf_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(
        settings.csrf_cookie,
        token,
        max_age=settings.session_idle_days * 86400,
        httponly=False,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


IfMatch = Annotated[str | None, Header(alias="If-Match")]


class Versioned(Protocol):
    version: int


def check_version(entity: Versioned, if_match: str | None) -> None:
    """If-Match опционален: заголовок передаёт клиент, которому важен конфликт правок."""
    if if_match is None:
        return
    expected = if_match.strip().strip('"')
    if expected == "*":
        return
    if not expected.isdigit():
        raise ApiError(400, "invalid_if_match", "Некорректный заголовок If-Match")
    if int(expected) != entity.version:
        raise conflict(entity.version)


def bump(entity: Versioned, response: Response | None = None) -> None:
    entity.version += 1
    if response is not None:
        set_etag(response, entity)


def set_etag(response: Response, entity: Versioned) -> None:
    response.headers["ETag"] = f'"{entity.version}"'
