"""Панель администратора сервера.

Не-администратору все маршруты отвечают 404, как несуществующие. Содержимое чужих досок
администратор не видит: панель управляет учётными записями и сервером, а не данными.
"""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select

from app.api.deps import Current, Db, Principal, client_ip
from app.core.db import escape_like
from app.core.errors import ApiError, not_found
from app.models import (
    AuditLog,
    BackupSnapshot,
    Board,
    Card,
    Document,
    DocumentVersion,
    Project,
    User,
    UserSession,
)
from app.schemas.api import Page
from app.schemas.auth import Ok
from app.services import app_settings
from app.services import auth as auth_service
from app.services.audit import audit

router = APIRouter(prefix="/admin", tags=["admin"])


async def _admin(current: Current) -> Principal:
    if not current.user.is_admin:
        raise not_found()
    return current


Admin = Annotated[Principal, Depends(_admin)]


class AdminUser(BaseModel):
    id: UUID
    email: str
    display_name: str
    is_admin: bool
    is_active: bool
    locked: bool
    failed_logins: int
    created_at: datetime
    last_login_at: datetime | None
    projects: int
    is_you: bool


class AdminUserUpdate(BaseModel):
    is_active: bool | None = None
    is_admin: bool | None = None


class AdminDelete(BaseModel):
    confirm_email: Annotated[str, Field(max_length=254)]


class AdminStats(BaseModel):
    users: int
    active_users: int
    locked_users: int
    admins: int
    projects: int
    boards: int
    cards: int
    documents: int
    storage_bytes: int


class AdminEvent(BaseModel):
    id: UUID
    action: str
    email: str | None
    ip: str
    target_type: str
    created_at: datetime


class AdminSettings(BaseModel):
    registration_open: bool


async def _user(db: Db, user_id: UUID) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise not_found()
    return user


def _not_self(admin: Principal, user: User) -> None:
    # Иначе можно случайно лишить сервер последнего администратора.
    if admin.id == user.id:
        raise ApiError(409, "self_action", "Это действие нельзя выполнить над своим аккаунтом")


async def _out(db: Db, user: User, admin: Principal) -> AdminUser:
    projects = await db.scalar(
        select(func.count(Project.id)).where(Project.owner_id == user.id, Project.deleted_at.is_(None))
    )
    return AdminUser(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        is_admin=user.is_admin,
        is_active=user.is_active,
        locked=user.locked_at is not None,
        failed_logins=user.failed_logins,
        created_at=user.created_at,
        last_login_at=user.last_login_at,
        projects=projects or 0,
        is_you=user.id == admin.id,
    )


@router.get("/stats")
async def stats(_: Admin, db: Db) -> AdminStats:
    async def count(statement: object) -> int:
        return int(await db.scalar(statement) or 0)  # type: ignore[call-overload]

    storage = await count(select(func.coalesce(func.sum(DocumentVersion.size), 0)))
    snapshots = await count(select(func.coalesce(func.sum(BackupSnapshot.size), 0)))
    return AdminStats(
        users=await count(select(func.count(User.id))),
        active_users=await count(select(func.count(User.id)).where(User.is_active.is_(True))),
        locked_users=await count(select(func.count(User.id)).where(User.locked_at.is_not(None))),
        admins=await count(select(func.count(User.id)).where(User.is_admin.is_(True))),
        projects=await count(select(func.count(Project.id)).where(Project.deleted_at.is_(None))),
        boards=await count(select(func.count(Board.id)).where(Board.deleted_at.is_(None))),
        cards=await count(select(func.count(Card.id)).where(Card.deleted_at.is_(None))),
        documents=await count(select(func.count(Document.id)).where(Document.deleted_at.is_(None))),
        storage_bytes=storage + snapshots,
    )


@router.get("/users")
async def list_users(
    admin: Admin,
    db: Db,
    q: Annotated[str, Query(max_length=120)] = "",
    cursor: UUID | None = None,
    limit: int = Query(default=50, ge=1, le=200),
) -> Page[AdminUser]:
    statement = select(User).order_by(User.id).limit(limit + 1)
    if q:
        pattern = f"%{escape_like(q.strip().lower())}%"
        statement = statement.where(
            or_(User.email.ilike(pattern, escape="\\"), User.display_name.ilike(pattern, escape="\\"))
        )
    if cursor is not None:
        statement = statement.where(User.id > cursor)
    rows = list((await db.execute(statement)).scalars().all())
    page = rows[:limit]
    return Page(
        items=[await _out(db, user, admin) for user in page],
        next_cursor=str(page[-1].id) if len(rows) > limit else None,
    )


@router.post("/users/{user_id}/unlock")
async def unlock_user(user_id: UUID, admin: Admin, request: Request, db: Db) -> AdminUser:
    user = await _user(db, user_id)
    auth_service.unlock(user)
    audit(db, admin.id, "admin.user_unlocked", ip=client_ip(request), target_type="user", target_id=user.id)
    return await _out(db, user, admin)


@router.patch("/users/{user_id}")
async def update_user(
    user_id: UUID, payload: AdminUserUpdate, admin: Admin, request: Request, db: Db
) -> AdminUser:
    user = await _user(db, user_id)
    _not_self(admin, user)
    if payload.is_active is not None:
        user.is_active = payload.is_active
        if not payload.is_active:
            await auth_service.revoke_all_sessions(db, user.id)
    if payload.is_admin is not None:
        user.is_admin = payload.is_admin
    audit(
        db,
        admin.id,
        "admin.user_updated",
        ip=client_ip(request),
        target_type="user",
        target_id=user.id,
        changes=payload.model_dump(exclude_none=True),
    )
    return await _out(db, user, admin)


@router.post("/users/{user_id}/logout-all")
async def logout_user(user_id: UUID, admin: Admin, request: Request, db: Db) -> Ok:
    user = await _user(db, user_id)
    await db.execute(delete(UserSession).where(UserSession.user_id == user.id))
    audit(db, admin.id, "admin.user_logged_out", ip=client_ip(request), target_type="user", target_id=user.id)
    return Ok()


@router.delete("/users/{user_id}")
async def delete_user(user_id: UUID, payload: AdminDelete, admin: Admin, request: Request, db: Db) -> Ok:
    user = await _user(db, user_id)
    _not_self(admin, user)
    if auth_service.normalize_email(payload.confirm_email) != user.email:
        raise ApiError(422, "confirmation_required", "Для подтверждения введите email пользователя")
    audit(db, admin.id, "admin.user_deleted", ip=client_ip(request), target_type="user", target_id=user.id)
    await db.execute(delete(User).where(User.id == user.id))
    return Ok()


@router.get("/audit")
async def audit_log(_: Admin, db: Db, limit: int = Query(default=100, ge=1, le=500)) -> list[AdminEvent]:
    rows = await db.execute(
        select(AuditLog, User.email)
        .outerjoin(User, User.id == AuditLog.user_id)
        .order_by(AuditLog.id.desc())
        .limit(limit)
    )
    return [
        AdminEvent(
            id=event.id,
            action=event.action,
            email=email,
            ip=event.ip,
            target_type=event.target_type,
            created_at=event.created_at,
        )
        for event, email in rows
    ]


@router.get("/settings")
async def get_settings(_: Admin, db: Db) -> AdminSettings:
    return AdminSettings.model_validate(await app_settings.all_settings(db))


@router.put("/settings")
async def put_settings(payload: AdminSettings, admin: Admin, request: Request, db: Db) -> AdminSettings:
    for key, value in payload.model_dump().items():
        await app_settings.put(db, key, value)
    audit(db, admin.id, "admin.settings_changed", ip=client_ip(request), **payload.model_dump())
    return payload
