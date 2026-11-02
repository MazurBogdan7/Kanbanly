"""Единственный путь к данным: каждая выборка ресурса идёт через проверку членства.

Чужой, удалённый и несуществующий ресурс неотличимы — всегда 404. Недостаточная роль при
видимом ресурсе — 403, потому что существование уже известно участнику проекта.
"""

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import forbidden, not_found
from app.models import (
    Attachment,
    Board,
    BoardView,
    Card,
    Checklist,
    ChecklistItem,
    Comment,
    Project,
    ProjectMember,
    Template,
)

Role = Literal["viewer", "editor", "owner"]
ROLE_RANK: dict[str, int] = {"viewer": 0, "editor": 1, "owner": 2}


@dataclass(slots=True)
class BoardAccess:
    board: Board
    role: str


@dataclass(slots=True)
class ProjectAccess:
    project: Project
    role: str


@dataclass(slots=True)
class CardAccess:
    card: Card
    board: Board
    role: str


def _require(role: str, minimum: Role) -> None:
    if ROLE_RANK[role] < ROLE_RANK[minimum]:
        raise forbidden()


def visible_projects(user_id: UUID) -> Select[Project, str]:
    return (
        select(Project, ProjectMember.role)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(ProjectMember.user_id == user_id, Project.deleted_at.is_(None))
    )


async def get_project(
    db: AsyncSession, user_id: UUID, project_id: UUID, minimum: Role = "viewer", *, deleted: bool = False
) -> ProjectAccess:
    statement = (
        select(Project, ProjectMember.role)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(ProjectMember.user_id == user_id, Project.id == project_id)
    )
    statement = statement.where(Project.deleted_at.is_not(None) if deleted else Project.deleted_at.is_(None))
    row = (await db.execute(statement)).first()
    if row is None:
        raise not_found()
    project, role = row
    _require(role, minimum)
    return ProjectAccess(project, role)


async def get_board(
    db: AsyncSession, user_id: UUID, board_id: UUID, minimum: Role = "viewer", *, deleted: bool = False
) -> BoardAccess:
    statement = (
        select(Board, ProjectMember.role)
        .join(Project, Project.id == Board.project_id)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(ProjectMember.user_id == user_id, Board.id == board_id, Project.deleted_at.is_(None))
    )
    statement = statement.where(Board.deleted_at.is_not(None) if deleted else Board.deleted_at.is_(None))
    row = (await db.execute(statement)).first()
    if row is None:
        raise not_found()
    board, role = row
    _require(role, minimum)
    return BoardAccess(board, role)


async def get_card(
    db: AsyncSession, user_id: UUID, card_id: UUID, minimum: Role = "viewer", *, deleted: bool = False
) -> CardAccess:
    statement = (
        select(Card, Board, ProjectMember.role)
        .join(Board, Board.id == Card.board_id)
        .join(Project, Project.id == Board.project_id)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(
            ProjectMember.user_id == user_id,
            Card.id == card_id,
            Board.deleted_at.is_(None),
            Project.deleted_at.is_(None),
        )
    )
    statement = statement.where(Card.deleted_at.is_not(None) if deleted else Card.deleted_at.is_(None))
    row = (await db.execute(statement)).first()
    if row is None:
        raise not_found()
    card, board, role = row
    _require(role, minimum)
    return CardAccess(card, board, role)


async def get_view(
    db: AsyncSession, user_id: UUID, view_id: UUID, minimum: Role = "viewer"
) -> tuple[BoardView, BoardAccess]:
    view = await db.get(BoardView, view_id)
    if view is None:
        raise not_found()
    return view, await get_board(db, user_id, view.board_id, minimum)


async def get_checklist(
    db: AsyncSession, user_id: UUID, checklist_id: UUID, minimum: Role = "viewer"
) -> tuple[Checklist, CardAccess]:
    checklist = await db.get(Checklist, checklist_id)
    if checklist is None:
        raise not_found()
    return checklist, await get_card(db, user_id, checklist.card_id, minimum)


async def get_checklist_item(
    db: AsyncSession, user_id: UUID, item_id: UUID, minimum: Role = "viewer"
) -> tuple[ChecklistItem, CardAccess]:
    item = await db.get(ChecklistItem, item_id)
    if item is None:
        raise not_found()
    _, access = await get_checklist(db, user_id, item.checklist_id, minimum)
    return item, access


async def get_comment(
    db: AsyncSession, user_id: UUID, comment_id: UUID, minimum: Role = "viewer"
) -> tuple[Comment, CardAccess]:
    comment = await db.get(Comment, comment_id)
    if comment is None:
        raise not_found()
    return comment, await get_card(db, user_id, comment.card_id, minimum)


async def get_attachment(
    db: AsyncSession, user_id: UUID, attachment_id: UUID, minimum: Role = "viewer"
) -> tuple[Attachment, CardAccess]:
    attachment = await db.get(Attachment, attachment_id)
    if attachment is None:
        raise not_found()
    return attachment, await get_card(db, user_id, attachment.card_id, minimum)


async def get_template(
    db: AsyncSession, user_id: UUID, template_id: UUID, *, deleted: bool = False
) -> Template:
    template = await db.get(Template, template_id)
    if template is None or template.owner_id != user_id or (template.deleted_at is not None) != deleted:
        raise not_found()
    return template
