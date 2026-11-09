"""Сквозные эндпоинты: поиск, корзина, журнал."""

from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import or_, select

from app.api.deps import AppSettings, Current, Db
from app.core.db import escape_like
from app.models import AuditLog, Board, Card, Document, Project, ProjectMember, Template
from app.schemas.api import AuditOut, SearchHit, TrashItem

router = APIRouter(tags=["misc"])


@router.get("/search")
async def search(
    current: Current,
    db: Db,
    q: Annotated[str, Query(min_length=1, max_length=120)],
    limit: int = Query(default=20, ge=1, le=50),
) -> list[SearchHit]:
    pattern = f"%{escape_like(q)}%"
    member = select(ProjectMember.project_id).where(ProjectMember.user_id == current.id).scalar_subquery()
    boards = await db.execute(
        select(Board, Project.name)
        .join(Project, Project.id == Board.project_id)
        .where(
            Board.project_id.in_(member),
            Board.deleted_at.is_(None),
            Project.deleted_at.is_(None),
            Board.name.ilike(pattern, escape="\\"),
        )
        .limit(limit)
    )
    hits = [
        SearchHit(type="board", id=board.id, board_id=board.id, title=board.name, subtitle=project)
        for board, project in boards
    ]
    cards = await db.execute(
        select(Card, Board.name)
        .join(Board, Board.id == Card.board_id)
        .join(Project, Project.id == Board.project_id)
        .where(
            Board.project_id.in_(member),
            Card.deleted_at.is_(None),
            Board.deleted_at.is_(None),
            Project.deleted_at.is_(None),
            or_(Card.title.ilike(pattern, escape="\\"), Card.description.ilike(pattern, escape="\\")),
        )
        .limit(limit)
    )
    hits += [
        SearchHit(type="card", id=card.id, board_id=card.board_id, title=card.title, subtitle=board)
        for card, board in cards
    ]
    return hits[:limit]


@router.get("/trash")
async def trash(current: Current, db: Db, settings: AppSettings) -> list[TrashItem]:
    keep = timedelta(days=settings.trash_retention_days)
    member = select(ProjectMember.project_id).where(ProjectMember.user_id == current.id).scalar_subquery()
    items: list[TrashItem] = []
    projects = await db.execute(
        select(Project).where(Project.id.in_(member), Project.deleted_at.is_not(None))
    )
    for project in projects.scalars():
        assert project.deleted_at is not None
        items.append(
            TrashItem(
                type="project",
                id=project.id,
                name=project.name,
                deleted_at=project.deleted_at,
                purge_at=project.deleted_at + keep,
            )
        )
    boards = await db.execute(
        select(Board).where(Board.project_id.in_(member), Board.deleted_at.is_not(None))
    )
    for board in boards.scalars():
        assert board.deleted_at is not None
        items.append(
            TrashItem(
                type="board",
                id=board.id,
                name=board.name,
                deleted_at=board.deleted_at,
                purge_at=board.deleted_at + keep,
            )
        )
    cards = await db.execute(
        select(Card)
        .join(Board, Board.id == Card.board_id)
        .where(Board.project_id.in_(member), Card.deleted_at.is_not(None), Board.deleted_at.is_(None))
        .order_by(Card.deleted_at.desc())
        .limit(500)
    )
    for card in cards.scalars():
        assert card.deleted_at is not None
        items.append(
            TrashItem(
                type="card",
                id=card.id,
                name=card.title,
                deleted_at=card.deleted_at,
                purge_at=card.deleted_at + keep,
            )
        )
    documents = await db.execute(
        select(Document)
        .join(Project, Project.id == Document.project_id)
        .where(
            Document.project_id.in_(member), Document.deleted_at.is_not(None), Project.deleted_at.is_(None)
        )
    )
    for document in documents.scalars():
        assert document.deleted_at is not None
        items.append(
            TrashItem(
                type="document",
                id=document.id,
                name=document.name,
                deleted_at=document.deleted_at,
                purge_at=document.deleted_at + keep,
            )
        )
    templates = await db.execute(
        select(Template).where(Template.owner_id == current.id, Template.deleted_at.is_not(None))
    )
    for template in templates.scalars():
        assert template.deleted_at is not None
        items.append(
            TrashItem(
                type="template",
                id=template.id,
                name=template.name,
                deleted_at=template.deleted_at,
                purge_at=template.deleted_at + keep,
            )
        )
    return sorted(items, key=lambda item: item.deleted_at, reverse=True)


@router.get("/audit")
async def audit_log(current: Current, db: Db, limit: int = Query(default=50, ge=1, le=200)) -> list[AuditOut]:
    rows = await db.execute(
        select(AuditLog).where(AuditLog.user_id == current.id).order_by(AuditLog.id.desc()).limit(limit)
    )
    return [AuditOut.model_validate(row) for row in rows.scalars()]
