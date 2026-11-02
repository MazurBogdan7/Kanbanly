from uuid import UUID

from fastapi import APIRouter, Query, Response
from sqlalchemy import select

from app.api.deps import Current, Db, IfMatch, Principal, bump, check_version, set_etag
from app.core.db import utcnow
from app.core.errors import forbidden
from app.models import Attachment, CardEvent, Checklist, ChecklistItem, Comment
from app.repositories import access
from app.schemas.api import (
    AttachmentCreate,
    AttachmentOut,
    CardCreate,
    CardDetail,
    CardEventOut,
    CardMove,
    CardOut,
    CardUpdate,
    ChecklistCreate,
    ChecklistItemCreate,
    ChecklistItemOut,
    ChecklistItemUpdate,
    ChecklistOut,
    ChecklistUpdate,
    CommentCreate,
    CommentOut,
    Page,
)
from app.schemas.auth import Ok
from app.services import cards as service
from app.services.board_config import load_board
from app.services.cards import build_index
from app.services.fractional import key_between

router = APIRouter(tags=["cards"])


def _actor(current: Principal) -> str:
    return current.user.display_name


async def _out(db: Db, card_id: UUID, board_id: UUID) -> CardOut:
    index = build_index(await load_board(db, board_id))
    card = await service.load_card(db, card_id)
    return (await service.serialize_many(db, [card], index))[0]


@router.post("/boards/{board_id}/cards", status_code=201)
async def create_card(board_id: UUID, payload: CardCreate, current: Current, db: Db) -> CardOut:
    await access.get_board(db, current.id, board_id, "editor")
    board = await load_board(db, board_id)
    card = await service.create(db, board, build_index(board), payload, current.id, _actor(current))
    return await _out(db, card.id, board_id)


@router.get("/cards/{card_id}")
async def get_card(card_id: UUID, current: Current, db: Db, response: Response) -> CardDetail:
    found = await access.get_card(db, current.id, card_id)
    set_etag(response, found.card)
    index = build_index(await load_board(db, found.board.id))
    return await service.detail(db, card_id, index)


@router.patch("/cards/{card_id}")
async def update_card(
    card_id: UUID,
    payload: CardUpdate,
    current: Current,
    db: Db,
    response: Response,
    if_match: IfMatch = None,
) -> CardOut:
    found = await access.get_card(db, current.id, card_id, "editor")
    check_version(found.card, if_match)
    board = await load_board(db, found.board.id)
    index = build_index(board)
    card = await service.load_card(db, card_id)
    changed = service.update(card, board, index, payload)
    if payload.column is not None and index.columns_by_id[card.column_id].key != payload.column:
        await service.move(db, board, index, card, CardMove(column=payload.column))
        changed.append("column")
    if changed:
        bump(card, response)
        service.record(db, card, current.id, _actor(current), "updated", fields=changed)
    else:
        set_etag(response, card)
    await db.flush()
    return await _out(db, card_id, board.id)


@router.post("/cards/{card_id}/move")
async def move_card(
    card_id: UUID, payload: CardMove, current: Current, db: Db, response: Response
) -> CardOut:
    found = await access.get_card(db, current.id, card_id, "editor")
    board = await load_board(db, found.board.id)
    card = await service.load_card(db, card_id)
    source, target = await service.move(db, board, build_index(board), card, payload)
    bump(card, response)
    if source != target:
        service.record(db, card, current.id, _actor(current), "moved", source=source, target=target)
    await db.flush()
    return await _out(db, card_id, board.id)


@router.delete("/cards/{card_id}")
async def delete_card(card_id: UUID, current: Current, db: Db) -> Ok:
    found = await access.get_card(db, current.id, card_id, "editor")
    found.card.deleted_at = utcnow()
    service.record(db, found.card, current.id, _actor(current), "deleted")
    return Ok()


@router.post("/cards/{card_id}/restore")
async def restore_card(card_id: UUID, current: Current, db: Db) -> CardOut:
    found = await access.get_card(db, current.id, card_id, "editor", deleted=True)
    found.card.deleted_at = None
    service.record(db, found.card, current.id, _actor(current), "restored")
    await db.flush()
    return await _out(db, card_id, found.board.id)


@router.get("/cards/{card_id}/activity")
async def card_activity(
    card_id: UUID,
    current: Current,
    db: Db,
    cursor: UUID | None = None,
    limit: int = Query(default=50, ge=1, le=200),
) -> Page[CardEventOut]:
    await access.get_card(db, current.id, card_id)
    statement = (
        select(CardEvent).where(CardEvent.card_id == card_id).order_by(CardEvent.id.desc()).limit(limit + 1)
    )
    if cursor is not None:
        statement = statement.where(CardEvent.id < cursor)
    rows = list((await db.execute(statement)).scalars().all())
    page = rows[:limit]
    return Page(
        items=[CardEventOut.model_validate(row) for row in page],
        next_cursor=str(page[-1].id) if len(rows) > limit else None,
    )


@router.post("/cards/{card_id}/checklists", status_code=201)
async def create_checklist(card_id: UUID, payload: ChecklistCreate, current: Current, db: Db) -> ChecklistOut:
    await access.get_card(db, current.id, card_id, "editor")
    last = await db.execute(
        select(Checklist.position)
        .where(Checklist.card_id == card_id)
        .order_by(Checklist.position.desc())
        .limit(1)
    )
    checklist = Checklist(
        card_id=card_id,
        title=payload.title,
        position=key_between(last.scalar_one_or_none(), None),
        items=[],
    )
    db.add(checklist)
    await db.flush()
    return ChecklistOut.model_validate(checklist)


@router.patch("/checklists/{checklist_id}")
async def update_checklist(
    checklist_id: UUID, payload: ChecklistUpdate, current: Current, db: Db
) -> dict[str, bool]:
    checklist, _ = await access.get_checklist(db, current.id, checklist_id, "editor")
    checklist.title = payload.title
    return {"ok": True}


@router.delete("/checklists/{checklist_id}")
async def delete_checklist(checklist_id: UUID, current: Current, db: Db) -> Ok:
    checklist, _ = await access.get_checklist(db, current.id, checklist_id, "editor")
    await db.delete(checklist)
    return Ok()


@router.post("/checklists/{checklist_id}/items", status_code=201)
async def create_item(
    checklist_id: UUID, payload: ChecklistItemCreate, current: Current, db: Db
) -> ChecklistItemOut:
    await access.get_checklist(db, current.id, checklist_id, "editor")
    last = await db.execute(
        select(ChecklistItem.position)
        .where(ChecklistItem.checklist_id == checklist_id)
        .order_by(ChecklistItem.position.desc())
        .limit(1)
    )
    item = ChecklistItem(
        checklist_id=checklist_id,
        text=payload.text,
        position=key_between(last.scalar_one_or_none(), None),
    )
    db.add(item)
    await db.flush()
    return ChecklistItemOut.model_validate(item)


@router.patch("/checklist-items/{item_id}")
async def update_item(
    item_id: UUID, payload: ChecklistItemUpdate, current: Current, db: Db
) -> ChecklistItemOut:
    item, _ = await access.get_checklist_item(db, current.id, item_id, "editor")
    if payload.text is not None:
        item.text = payload.text
    if payload.done is not None:
        item.done = payload.done
    return ChecklistItemOut.model_validate(item)


@router.delete("/checklist-items/{item_id}")
async def delete_item(item_id: UUID, current: Current, db: Db) -> Ok:
    item, _ = await access.get_checklist_item(db, current.id, item_id, "editor")
    await db.delete(item)
    return Ok()


@router.post("/cards/{card_id}/comments", status_code=201)
async def create_comment(card_id: UUID, payload: CommentCreate, current: Current, db: Db) -> CommentOut:
    found = await access.get_card(db, current.id, card_id, "editor")
    comment = Comment(card_id=card_id, author_id=current.id, author_name=_actor(current), body=payload.body)
    db.add(comment)
    service.record(db, found.card, current.id, _actor(current), "commented")
    await db.flush()
    return CommentOut.model_validate(comment)


@router.patch("/comments/{comment_id}")
async def update_comment(comment_id: UUID, payload: CommentCreate, current: Current, db: Db) -> CommentOut:
    comment, _ = await access.get_comment(db, current.id, comment_id, "editor")
    if comment.author_id != current.id:
        raise forbidden("Редактировать можно только свои комментарии")
    comment.body = payload.body
    await db.flush()
    return CommentOut.model_validate(comment)


@router.delete("/comments/{comment_id}")
async def delete_comment(comment_id: UUID, current: Current, db: Db) -> Ok:
    comment, _ = await access.get_comment(db, current.id, comment_id, "editor")
    await db.delete(comment)
    return Ok()


@router.post("/cards/{card_id}/attachments", status_code=201)
async def create_attachment(
    card_id: UUID, payload: AttachmentCreate, current: Current, db: Db
) -> AttachmentOut:
    await access.get_card(db, current.id, card_id, "editor")
    attachment = Attachment(card_id=card_id, name=payload.name, url=payload.url)
    db.add(attachment)
    await db.flush()
    return AttachmentOut.model_validate(attachment)


@router.delete("/attachments/{attachment_id}")
async def delete_attachment(attachment_id: UUID, current: Current, db: Db) -> Ok:
    attachment, _ = await access.get_attachment(db, current.id, attachment_id, "editor")
    await db.delete(attachment)
    return Ok()
