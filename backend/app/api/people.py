"""Аватары: свой загружается уже обрезанным по кругу (кадрирование в браузере)."""

from uuid import UUID

from fastapi import APIRouter, Request, Response

from app.api.deps import Current, Db
from app.core.db import utcnow
from app.core.errors import not_found
from app.models import User, UserAvatar
from app.schemas.auth import UserOut
from app.services import people
from app.services.audit import audit

router = APIRouter(tags=["people"])


@router.put("/auth/me/avatar")
async def put_avatar(request: Request, current: Current, db: Db) -> UserOut:
    """Тело запроса — сама картинка (PNG, JPEG или WebP, до 1 МБ)."""
    data = await request.body()
    media_type = people.avatar_type(data)
    avatar = await db.get(UserAvatar, current.id)
    if avatar is None:
        db.add(UserAvatar(user_id=current.id, data=data, media_type=media_type, updated_at=utcnow()))
    else:
        avatar.data, avatar.media_type, avatar.updated_at = data, media_type, utcnow()
    current.user.avatar_version += 1
    audit(db, current.id, "profile.avatar_changed", target_type="user", target_id=current.id)
    await db.flush()
    return UserOut.model_validate(current.user)


@router.delete("/auth/me/avatar")
async def delete_avatar(current: Current, db: Db) -> UserOut:
    avatar = await db.get(UserAvatar, current.id)
    if avatar is not None:
        await db.delete(avatar)
    current.user.avatar_version = 0
    await db.flush()
    return UserOut.model_validate(current.user)


@router.get("/users/{user_id}/avatar")
async def get_avatar(user_id: UUID, current: Current, db: Db) -> Response:
    if not await people.shares_project(db, current.id, user_id) and not current.user.is_admin:
        raise not_found()
    avatar = await db.get(UserAvatar, user_id)
    owner = await db.get(User, user_id)
    if avatar is None or owner is None:
        raise not_found()
    return Response(
        avatar.data,
        media_type=avatar.media_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            # В адресе есть ?v=номер версии: новая картинка — новый адрес.
            "Cache-Control": "private, max-age=31536000, immutable",
        },
    )
