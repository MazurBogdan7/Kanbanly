import json
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import select, update

from app.api.deps import AppSettings, Current, Db, IfMatch, bump, check_version, set_etag
from app.core.db import utcnow
from app.core.errors import ApiError
from app.models import Board, BoardView, Card, Template
from app.repositories import access
from app.schemas.api import (
    BoardCreate,
    BoardOut,
    BoardReset,
    BoardUpdate,
    CardOut,
    Page,
    TemplateApply,
    ViewCreate,
    ViewOut,
)
from app.schemas.auth import Ok
from app.schemas.template import BoardConfig, BoardTemplate, ViewTemplate
from app.services import cards as card_service
from app.services import presets
from app.services import templates as template_service
from app.services.audit import audit
from app.services.board_config import apply_config, export_config, load_board
from app.services.cards import build_index
from app.services.fractional import key_between
from app.services.json_import import check_depth, strip_extras, validate_template

router = APIRouter(tags=["boards"])


def board_out(board: Board, role: str, warnings: list[str] | None = None) -> BoardOut:
    source = board.source_template or {}
    return BoardOut(
        id=board.id,
        project_id=board.project_id,
        name=board.name,
        description=board.description,
        version=board.version,
        is_favorite=board.is_favorite,
        role=role,
        has_source_template=bool(source),
        source_template_name=source.get("meta", {}).get("name"),
        created_at=board.created_at,
        updated_at=board.updated_at,
        config=export_config(board),
        warnings=warnings or [],
    )


async def resolve_source(
    payload: BoardCreate, db: Db, user_id: UUID, settings: AppSettings
) -> tuple[BoardTemplate, list[str]]:
    sources = [s for s in (payload.preset, payload.template_id, payload.template) if s is not None]
    if len(sources) > 1:
        raise ApiError(422, "ambiguous_source", "Укажите один источник доски")
    if payload.preset is not None:
        return presets.get_preset(payload.preset), []
    if payload.template_id is not None:
        stored = await access.get_template(db, user_id, payload.template_id)
        return validate_template(stored.data)
    if payload.template is not None:
        size = len(json.dumps(payload.template, ensure_ascii=False).encode())
        if size > settings.template_max_bytes:
            raise ApiError(413, "payload_too_large", "Шаблон больше допустимого размера")
        check_depth(payload.template, settings.json_max_depth)
        return validate_template(payload.template)
    return template_service.blank_template(payload.name), []


@router.post("/projects/{project_id}/boards", status_code=201)
async def create_board(
    project_id: UUID, payload: BoardCreate, current: Current, db: Db, settings: AppSettings
) -> BoardOut:
    found = await access.get_project(db, current.id, project_id, "editor")
    template, warnings = await resolve_source(payload, db, current.id, settings)
    board, config_warnings = await template_service.create_board(
        db,
        found.project,
        payload.name,
        template,
        description=payload.description,
        include_samples=payload.include_samples,
        user_id=current.id,
    )
    return board_out(board, found.role, warnings + config_warnings)


@router.get("/boards/{board_id}")
async def get_board(board_id: UUID, current: Current, db: Db, response: Response) -> BoardOut:
    found = await access.get_board(db, current.id, board_id)
    board = await load_board(db, board_id)
    await db.execute(update(Board).where(Board.id == board_id).values(last_opened_at=utcnow()))
    set_etag(response, board)
    return board_out(board, found.role)


@router.patch("/boards/{board_id}")
async def update_board(
    board_id: UUID,
    payload: BoardUpdate,
    current: Current,
    db: Db,
    response: Response,
    if_match: IfMatch = None,
) -> BoardOut:
    found = await access.get_board(db, current.id, board_id, "editor")
    check_version(found.board, if_match)
    if payload.name is not None:
        found.board.name = payload.name
    if payload.description is not None:
        found.board.description = payload.description
    if payload.is_favorite is not None:
        found.board.is_favorite = payload.is_favorite
    bump(found.board, response)
    await db.flush()
    return board_out(await load_board(db, board_id), found.role)


@router.put("/boards/{board_id}/config")
async def put_config(
    board_id: UUID,
    config: BoardConfig,
    current: Current,
    db: Db,
    response: Response,
    if_match: IfMatch = None,
) -> BoardOut:
    found = await access.get_board(db, current.id, board_id, "editor")
    check_version(found.board, if_match)
    warnings = strip_extras(config)
    board = await load_board(db, board_id)
    warnings += await apply_config(db, board, config)
    bump(board, response)
    await db.flush()
    return board_out(await load_board(db, board_id), found.role, warnings)


@router.post("/boards/{board_id}/template/apply")
async def apply_template_parts(
    board_id: UUID,
    payload: TemplateApply,
    current: Current,
    db: Db,
    response: Response,
    settings: AppSettings,
) -> BoardOut:
    found = await access.get_board(db, current.id, board_id, "editor")
    check_depth(payload.template, settings.json_max_depth)
    template, warnings = validate_template(payload.template)
    board = await load_board(db, board_id)
    config = template_service.overlay(export_config(board), template, payload.parts)
    warnings += await apply_config(db, board, config)
    bump(board, response)
    audit(db, current.id, "template.applied", target_type="board", target_id=board_id, parts=payload.parts)
    await db.flush()
    return board_out(await load_board(db, board_id), found.role, warnings)


@router.post("/boards/{board_id}/reset")
async def reset_board(
    board_id: UUID, payload: BoardReset, current: Current, db: Db, response: Response
) -> BoardOut:
    found = await access.get_board(db, current.id, board_id, "editor")
    board = await load_board(db, board_id)
    if not board.source_template:
        raise ApiError(409, "no_source_template", "Доска создана без шаблона")
    template, _ = validate_template(board.source_template)
    if payload.cards:
        await db.execute(
            update(Card)
            .where(Card.board_id == board_id, Card.deleted_at.is_(None))
            .values(deleted_at=utcnow())
        )
    warnings = await apply_config(db, board, template_service.config_of(template))
    board = await load_board(db, board_id)
    if payload.cards and template.sample_cards:
        await template_service.create_sample_cards(
            db, board, build_index(board), template.sample_cards, current.id
        )
    bump(board, response)
    await db.flush()
    return board_out(await load_board(db, board_id), found.role, warnings)


@router.delete("/boards/{board_id}")
async def delete_board(board_id: UUID, current: Current, db: Db) -> Ok:
    found = await access.get_board(db, current.id, board_id, "editor")
    found.board.deleted_at = utcnow()
    audit(db, current.id, "board.deleted", target_type="board", target_id=board_id, name=found.board.name)
    return Ok()


@router.post("/boards/{board_id}/restore")
async def restore_board(board_id: UUID, current: Current, db: Db) -> BoardOut:
    found = await access.get_board(db, current.id, board_id, "editor", deleted=True)
    found.board.deleted_at = None
    await db.flush()
    return board_out(await load_board(db, board_id), found.role)


@router.get("/boards/{board_id}/cards")
async def list_cards(
    board_id: UUID,
    current: Current,
    db: Db,
    cursor: UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 500,
) -> Page[CardOut]:
    await access.get_board(db, current.id, board_id)
    board = await load_board(db, board_id)
    statement = (
        card_service.card_query()
        .where(Card.board_id == board_id, Card.deleted_at.is_(None))
        .order_by(Card.id)
        .limit(limit + 1)
    )
    if cursor is not None:
        statement = statement.where(Card.id > cursor)
    rows = list((await db.execute(statement)).scalars().all())
    page = rows[:limit]
    return Page(
        items=await card_service.serialize_many(db, page, build_index(board)),
        next_cursor=str(page[-1].id) if len(rows) > limit else None,
    )


@router.get("/boards/{board_id}/template")
async def download_template(
    board_id: UUID,
    current: Current,
    db: Db,
    include_cards: bool = False,
    part: Annotated[str | None, Query(max_length=20)] = None,
) -> JSONResponse:
    await access.get_board(db, current.id, board_id)
    board = await load_board(db, board_id)
    template = await template_service.export_template(
        db, board, include_cards=include_cards, author=current.user.display_name
    )
    document = template.model_dump(mode="json", by_alias=True, exclude_none=True)
    audit(db, current.id, "template.exported", target_type="board", target_id=board_id)
    if part is not None:
        document = template_service.keep_parts(document, part)
    return JSONResponse(
        document,
        headers={"Content-Disposition": f'attachment; filename="board-{board_id}.template.json"'},
    )


@router.post("/boards/{board_id}/template/save", status_code=201)
async def save_as_template(
    board_id: UUID, request: Request, current: Current, db: Db, include_cards: bool = False
) -> dict[str, str]:
    await access.get_board(db, current.id, board_id)
    board = await load_board(db, board_id)
    template = await template_service.export_template(
        db, board, include_cards=include_cards, author=current.user.display_name
    )
    name = request.query_params.get("name") or board.name
    template.meta.name = name[:200]
    stored = Template(
        owner_id=current.id,
        name=template.meta.name,
        description=template.meta.description,
        data=template.model_dump(mode="json", by_alias=True, exclude_none=True),
    )
    db.add(stored)
    await db.flush()
    return {"id": str(stored.id)}


def _view_out(view: BoardView) -> ViewOut:
    return ViewOut.model_validate(
        {
            "id": view.id,
            "key": view.key,
            "name": view.name,
            "type": view.type,
            "filters": view.filters,
            "sort": view.sort,
            "group_by": view.group_by,
            "is_default": view.is_default,
        }
    )


@router.get("/boards/{board_id}/views")
async def list_views(board_id: UUID, current: Current, db: Db) -> list[ViewOut]:
    await access.get_board(db, current.id, board_id)
    rows = await db.execute(
        select(BoardView).where(BoardView.board_id == board_id).order_by(BoardView.position)
    )
    return [_view_out(view) for view in rows.scalars()]


async def _clear_default(db: Db, board_id: UUID) -> None:
    await db.execute(update(BoardView).where(BoardView.board_id == board_id).values(is_default=False))


@router.post("/boards/{board_id}/views", status_code=201)
async def create_view(board_id: UUID, payload: ViewCreate, current: Current, db: Db) -> ViewOut:
    await access.get_board(db, current.id, board_id, "editor")
    exists = await db.execute(
        select(BoardView.id).where(BoardView.board_id == board_id, BoardView.key == payload.key)
    )
    if exists.first() is not None:
        raise ApiError(409, "duplicate_key", "Представление с таким ключом уже есть")
    last = await db.execute(
        select(BoardView.position)
        .where(BoardView.board_id == board_id)
        .order_by(BoardView.position.desc())
        .limit(1)
    )
    if payload.is_default:
        await _clear_default(db, board_id)
    view = BoardView(
        board_id=board_id,
        key=payload.key,
        name=payload.name,
        type=payload.type,
        filters=payload.filters.model_dump(mode="json"),
        sort=payload.sort.model_dump(mode="json") if payload.sort else None,
        group_by=payload.group_by,
        is_default=payload.is_default,
        position=key_between(last.scalar_one_or_none(), None),
    )
    db.add(view)
    await db.flush()
    return _view_out(view)


@router.patch("/views/{view_id}")
async def update_view(view_id: UUID, payload: ViewTemplate, current: Current, db: Db) -> ViewOut:
    view, found = await access.get_view(db, current.id, view_id, "editor")
    if payload.is_default:
        await _clear_default(db, found.board.id)
    view.name = payload.name
    view.type = payload.type
    view.filters = payload.filters.model_dump(mode="json")
    view.sort = payload.sort.model_dump(mode="json") if payload.sort else None
    view.group_by = payload.group_by
    view.is_default = payload.is_default
    await db.flush()
    return _view_out(view)


@router.delete("/views/{view_id}")
async def delete_view(view_id: UUID, current: Current, db: Db) -> Ok:
    view, _ = await access.get_view(db, current.id, view_id, "editor")
    await db.delete(view)
    return Ok()
