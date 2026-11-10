"""Аватары и статусы пользователей.

Статус как в мессенджерах: «онлайн» и «офлайн» определяются по активности (любой запрос
продлевает сеанс не чаще раза в минуту, а открытое приложение опрашивает сервер), «занят»
и «невидимка» пользователь выбирает сам. Невидимка всегда показывается офлайн.
"""

from datetime import datetime, timedelta
from typing import Literal
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.db import utcnow
from app.core.errors import ApiError
from app.models import ProjectMember, User, UserSession

ONLINE_WINDOW = timedelta(minutes=3)
AVATAR_MAX_BYTES = 1024 * 1024
AVATAR_TYPES = {
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"\xff\xd8\xff": "image/jpeg",
}

Status = Literal["online", "busy", "offline"]


def avatar_type(data: bytes) -> str:
    """Тип по содержимому: PNG, JPEG или WebP. Остальное отвергается."""
    if not data:
        raise ApiError(422, "empty_file", "Файл пустой")
    if len(data) > AVATAR_MAX_BYTES:
        raise ApiError(413, "payload_too_large", "Аватар больше 1 МБ")
    for magic, media_type in AVATAR_TYPES.items():
        if data.startswith(magic):
            return media_type
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    raise ApiError(422, "unsupported_image", "Аватар должен быть картинкой PNG, JPEG или WebP")


async def last_seen(db: AsyncSession, user_ids: list[UUID]) -> dict[UUID, datetime]:
    if not user_ids:
        return {}
    rows = await db.execute(
        select(UserSession.user_id, func.max(UserSession.last_seen_at))
        .where(UserSession.user_id.in_(user_ids))
        .group_by(UserSession.user_id)
    )
    seen: dict[UUID, datetime] = {}
    for user_id, moment in rows:
        if moment is not None:
            seen[user_id] = moment
    return seen


def status_of(user: User, seen: datetime | None, now: datetime | None = None) -> Status:
    if user.presence == "invisible" or seen is None:
        return "offline"
    if (now or utcnow()) - seen > ONLINE_WINDOW:
        return "offline"
    return "busy" if user.presence == "busy" else "online"


async def shares_project(db: AsyncSession, viewer_id: UUID, user_id: UUID) -> bool:
    """Аватар видят только те, с кем человек работает в одном проекте."""
    if viewer_id == user_id:
        return True
    other = aliased(ProjectMember)
    found = await db.execute(
        select(ProjectMember.id)
        .join(other, other.project_id == ProjectMember.project_id)
        .where(ProjectMember.user_id == viewer_id, other.user_id == user_id)
        .limit(1)
    )
    return found.first() is not None
