"""Участники проекта и приглашения.

Ссылку-приглашение принимает только пользователь с тем email, на который она выписана:
утёкшая ссылка не даёт доступа постороннему. Для всех остальных она выглядит как 404.
"""

import logging
from datetime import timedelta
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.db import utcnow
from app.core.errors import ApiError, forbidden, not_found
from app.models import Project, ProjectInvite, ProjectMember, User
from app.security.tokens import hash_token, new_token
from app.services.auth import normalize_email
from app.services.mailer import Mailer

logger = logging.getLogger(__name__)

INVITE_TTL_DAYS = 7
ASSIGNABLE_ROLES = ("editor", "viewer")


def invite_link(settings: Settings, token: str) -> str:
    return f"{settings.public_url}/invite/{token}"


async def list_members(db: AsyncSession, project_id: UUID) -> list[tuple[ProjectMember, User]]:
    rows = await db.execute(
        select(ProjectMember, User)
        .join(User, User.id == ProjectMember.user_id)
        .where(ProjectMember.project_id == project_id)
        .order_by(ProjectMember.id)
    )
    return [(member, user) for member, user in rows]


async def _member(db: AsyncSession, project_id: UUID, user_id: UUID) -> ProjectMember:
    member = (
        await db.execute(
            select(ProjectMember).where(
                ProjectMember.project_id == project_id, ProjectMember.user_id == user_id
            )
        )
    ).scalar_one_or_none()
    if member is None:
        raise not_found()
    return member


async def change_role(db: AsyncSession, project_id: UUID, user_id: UUID, role: str) -> ProjectMember:
    member = await _member(db, project_id, user_id)
    if member.role == "owner":
        raise ApiError(409, "owner_role_fixed", "Роль владельца проекта не меняется")
    member.role = role
    return member


async def remove_member(
    db: AsyncSession, project_id: UUID, user_id: UUID, actor_role: str, actor_id: UUID
) -> None:
    """Владелец удаляет любого участника, участник может только выйти сам."""
    if actor_role != "owner" and actor_id != user_id:
        raise forbidden()
    member = await _member(db, project_id, user_id)
    if member.role == "owner":
        raise ApiError(409, "owner_cannot_leave", "Владелец не может покинуть проект")
    await db.delete(member)


async def create_invite(
    db: AsyncSession,
    settings: Settings,
    mailer: Mailer,
    project: Project,
    inviter: User,
    email: str,
    role: str,
) -> tuple[ProjectInvite, str]:
    email = normalize_email(email)
    already = await db.execute(
        select(ProjectMember.id)
        .join(User, User.id == ProjectMember.user_id)
        .where(ProjectMember.project_id == project.id, User.email == email)
    )
    if already.first() is not None:
        raise ApiError(409, "already_member", "Этот пользователь уже участвует в проекте")
    # Новое приглашение заменяет прежнее на тот же адрес: действует только последняя ссылка.
    await db.execute(
        delete(ProjectInvite).where(
            ProjectInvite.project_id == project.id,
            ProjectInvite.email == email,
            ProjectInvite.accepted_at.is_(None),
        )
    )
    token = new_token()
    invite = ProjectInvite(
        project_id=project.id,
        email=email,
        role=role,
        token_hash=hash_token(token),
        expires_at=utcnow() + timedelta(days=INVITE_TTL_DAYS),
        invited_by=inviter.id,
    )
    db.add(invite)
    await db.flush()
    try:
        await mailer.send(
            email,
            f"Приглашение в проект «{project.name}»",
            f"{inviter.display_name} приглашает вас в проект «{project.name}» в Kanbanly.\n\n"
            f"Принять приглашение (ссылка действует {INVITE_TTL_DAYS} дней):\n"
            f"{invite_link(settings, token)}\n\n"
            "Войдите или зарегистрируйтесь с этим адресом email, чтобы принять приглашение.",
        )
    except Exception:
        # Ссылка всё равно показывается владельцу: её можно передать вручную.
        logger.error("Не удалось отправить письмо с приглашением")
    return invite, token


async def pending_invites(db: AsyncSession, project_id: UUID) -> list[ProjectInvite]:
    rows = await db.execute(
        select(ProjectInvite)
        .where(
            ProjectInvite.project_id == project_id,
            ProjectInvite.accepted_at.is_(None),
            ProjectInvite.expires_at > utcnow(),
        )
        .order_by(ProjectInvite.id)
    )
    return list(rows.scalars().all())


async def revoke_invite(db: AsyncSession, project_id: UUID, invite_id: UUID) -> None:
    result = await db.execute(
        delete(ProjectInvite).where(
            ProjectInvite.id == invite_id,
            ProjectInvite.project_id == project_id,
            ProjectInvite.accepted_at.is_(None),
        )
    )
    if result.rowcount == 0:  # type: ignore[attr-defined]
        raise not_found()


async def find_invite(db: AsyncSession, user: User, token: str) -> tuple[ProjectInvite, Project]:
    row = (
        await db.execute(
            select(ProjectInvite, Project)
            .join(Project, Project.id == ProjectInvite.project_id)
            .where(ProjectInvite.token_hash == hash_token(token), Project.deleted_at.is_(None))
        )
    ).first()
    if row is None:
        raise not_found()
    invite, project = row
    if (
        invite.accepted_at is not None
        or invite.expires_at < utcnow()
        or invite.email != normalize_email(user.email)
    ):
        raise not_found()
    return invite, project


async def accept_invite(db: AsyncSession, user: User, token: str) -> Project:
    invite, project = await find_invite(db, user, token)
    invite.accepted_at = utcnow()
    db.add(ProjectMember(project_id=project.id, user_id=user.id, role=invite.role))
    try:
        await db.flush()
    except IntegrityError as exc:
        raise ApiError(409, "already_member", "Вы уже участвуете в этом проекте") from exc
    return project
