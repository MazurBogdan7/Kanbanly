"""Участники проекта и приглашения.

Пригласить можно по email или нику. Зарегистрированному пользователю приглашение приходит
во входящие в приложении (принять или отклонить); незарегистрированному — письмо со ссылкой.
Ссылку принимает только владелец того email, на который она выписана: утёкшая ссылка не даёт
доступа постороннему. Отклонённое приглашение можно отправить снова.
"""

import logging
from datetime import timedelta
from uuid import UUID

from sqlalchemy import delete, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.db import utcnow
from app.core.errors import ApiError, forbidden, not_found
from app.models import Board, Card, Project, ProjectInvite, ProjectMember, User
from app.security.tokens import hash_token, new_token
from app.services.auth import normalize_email, normalize_username
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


async def is_member(db: AsyncSession, project_id: UUID, user_id: UUID) -> bool:
    found = await db.execute(
        select(ProjectMember.id).where(
            ProjectMember.project_id == project_id, ProjectMember.user_id == user_id
        )
    )
    return found.first() is not None


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
    # Бывший участник больше не исполнитель задач этого проекта.
    await db.execute(
        update(Card)
        .where(
            Card.assignee_id == user_id,
            Card.board_id.in_(select(Board.id).where(Board.project_id == project_id)),
        )
        .values(assignee_id=None)
    )


async def resolve_target(db: AsyncSession, target: str) -> tuple[str, User | None]:
    """Адресат приглашения: email (может быть ещё не зарегистрирован) или ник (@nick)."""
    value = target.strip()
    if "@" in value.lstrip("@"):
        email = normalize_email(value)
        user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
        return email, user
    username = normalize_username(value)
    user = (
        (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if username
        else None
    )
    if user is None:
        raise ApiError(404, "user_not_found", "Пользователь с таким ником не найден")
    return user.email, user


async def create_invite(
    db: AsyncSession,
    settings: Settings,
    mailer: Mailer,
    project: Project,
    inviter: User,
    target: str,
    role: str,
) -> tuple[ProjectInvite, str]:
    email, invitee = await resolve_target(db, target)
    already = await db.execute(
        select(ProjectMember.id)
        .join(User, User.id == ProjectMember.user_id)
        .where(ProjectMember.project_id == project.id, User.email == email)
    )
    if already.first() is not None:
        raise ApiError(409, "already_member", "Этот пользователь уже участвует в проекте")
    # Новое приглашение заменяет прежнее (в том числе отклонённое): действует только последнее.
    same_person = [ProjectInvite.email == email]
    if invitee is not None:
        same_person.append(ProjectInvite.invitee_id == invitee.id)
    await db.execute(
        delete(ProjectInvite).where(
            ProjectInvite.project_id == project.id,
            or_(*same_person),
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
        invitee_id=invitee.id if invitee else None,
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
            "Если у вас уже есть аккаунт, приглашение ждёт в Kanbanly: Профиль → Приглашения. "
            "Иначе зарегистрируйтесь с этим адресом email.",
        )
    except Exception:
        # Ссылка всё равно показывается владельцу: её можно передать вручную.
        logger.error("Не удалось отправить письмо с приглашением")
    return invite, token


async def project_invites(db: AsyncSession, project_id: UUID) -> list[tuple[ProjectInvite, User | None]]:
    """Для владельца: ожидающие и отклонённые (чтобы видеть отказ и пригласить снова)."""
    rows = await db.execute(
        select(ProjectInvite, User)
        .outerjoin(User, User.id == ProjectInvite.invitee_id)
        .where(
            ProjectInvite.project_id == project_id,
            ProjectInvite.accepted_at.is_(None),
            ProjectInvite.expires_at > utcnow(),
        )
        .order_by(ProjectInvite.id)
    )
    return [(invite, user) for invite, user in rows]


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


def _addressed_to(invite: ProjectInvite, user: User) -> bool:
    return (
        invite.accepted_at is None
        and invite.declined_at is None
        and invite.expires_at >= utcnow()
        and (invite.invitee_id == user.id or invite.email == normalize_email(user.email))
    )


async def find_invite(db: AsyncSession, user: User, token: str) -> tuple[ProjectInvite, Project]:
    row = (
        await db.execute(
            select(ProjectInvite, Project)
            .join(Project, Project.id == ProjectInvite.project_id)
            .where(ProjectInvite.token_hash == hash_token(token), Project.deleted_at.is_(None))
        )
    ).first()
    if row is None or not _addressed_to(row[0], user):
        raise not_found()
    return row[0], row[1]


async def inbox(db: AsyncSession, user: User) -> list[tuple[ProjectInvite, Project, User | None]]:
    """Входящие приглашения пользователя: по его id или по email, на который их выписали."""
    rows = await db.execute(
        select(ProjectInvite, Project, User)
        .join(Project, Project.id == ProjectInvite.project_id)
        .outerjoin(User, User.id == ProjectInvite.invited_by)
        .where(
            or_(
                ProjectInvite.invitee_id == user.id,
                ProjectInvite.email == normalize_email(user.email),
            ),
            ProjectInvite.accepted_at.is_(None),
            ProjectInvite.declined_at.is_(None),
            ProjectInvite.expires_at > utcnow(),
            Project.deleted_at.is_(None),
        )
        .order_by(ProjectInvite.id.desc())
    )
    return [(invite, project, inviter) for invite, project, inviter in rows]


async def _own_invite(db: AsyncSession, user: User, invite_id: UUID) -> tuple[ProjectInvite, Project]:
    row = (
        await db.execute(
            select(ProjectInvite, Project)
            .join(Project, Project.id == ProjectInvite.project_id)
            .where(ProjectInvite.id == invite_id, Project.deleted_at.is_(None))
        )
    ).first()
    if row is None or not _addressed_to(row[0], user):
        raise not_found()
    return row[0], row[1]


async def _join(db: AsyncSession, user: User, invite: ProjectInvite, project: Project) -> Project:
    invite.accepted_at = utcnow()
    invite.invitee_id = user.id
    db.add(ProjectMember(project_id=project.id, user_id=user.id, role=invite.role))
    try:
        await db.flush()
    except IntegrityError as exc:
        raise ApiError(409, "already_member", "Вы уже участвуете в этом проекте") from exc
    return project


async def accept_invite(db: AsyncSession, user: User, token: str) -> Project:
    invite, project = await find_invite(db, user, token)
    return await _join(db, user, invite, project)


async def accept_by_id(db: AsyncSession, user: User, invite_id: UUID) -> Project:
    invite, project = await _own_invite(db, user, invite_id)
    return await _join(db, user, invite, project)


async def decline_by_id(db: AsyncSession, user: User, invite_id: UUID) -> Project:
    invite, project = await _own_invite(db, user, invite_id)
    invite.declined_at = utcnow()
    invite.invitee_id = user.id
    return project
