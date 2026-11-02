from uuid import UUID

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import select

from app.api.deps import AppSettings, Current, Db, IfMatch, bump, check_version, client_ip, set_etag
from app.core.db import utcnow
from app.core.errors import ApiError
from app.models import Template
from app.repositories import access
from app.schemas.api import Page, PresetOut, TemplateFromBoard, TemplateOut, TemplatePreview, TemplateUpdate
from app.schemas.auth import Ok
from app.schemas.template import BoardTemplate
from app.services import presets
from app.services import templates as service
from app.services.audit import audit
from app.services.board_config import load_board
from app.services.json_import import parse_template

router = APIRouter(tags=["templates"])


def _out(template: Template) -> TemplateOut:
    return TemplateOut(
        id=template.id,
        name=template.name,
        description=template.description,
        version=template.version,
        created_at=template.created_at,
        updated_at=template.updated_at,
        data=BoardTemplate.model_validate(template.data),
    )


def _store(owner_id: UUID, template: BoardTemplate) -> Template:
    return Template(
        owner_id=owner_id,
        name=template.meta.name,
        description=template.meta.description,
        data=template.model_dump(mode="json", by_alias=True, exclude_none=True),
    )


@router.get("/presets")
async def list_presets(_: Current) -> list[PresetOut]:
    return [PresetOut(key=key, data=data) for key, data in presets.list_presets().items()]


@router.get("/presets/{key}")
async def get_preset(key: str, _: Current) -> PresetOut:
    return PresetOut(key=key, data=presets.get_preset(key))


@router.get("/templates/example")
async def example_template(_: Current) -> JSONResponse:
    return JSONResponse(
        presets.example_document(),
        headers={"Content-Disposition": 'attachment; filename="kanbanly-template-example.json"'},
    )


@router.get("/templates")
async def list_templates(
    current: Current,
    db: Db,
    cursor: UUID | None = None,
    limit: int = Query(default=100, ge=1, le=200),
) -> Page[TemplateOut]:
    statement = (
        select(Template)
        .where(Template.owner_id == current.id, Template.deleted_at.is_(None))
        .order_by(Template.id)
        .limit(limit + 1)
    )
    if cursor is not None:
        statement = statement.where(Template.id > cursor)
    rows = list((await db.execute(statement)).scalars().all())
    page = rows[:limit]
    return Page(
        items=[_out(row) for row in page],
        next_cursor=str(page[-1].id) if len(rows) > limit else None,
    )


@router.post("/templates/import/preview")
async def preview_import(request: Request, _: Current, settings: AppSettings) -> TemplatePreview:
    raw = await request.body()
    try:
        template, warnings = parse_template(raw, settings)
    except ApiError as exc:
        if exc.status == 413:
            raise
        details = exc.details if isinstance(exc.details, list) else [{"path": "", "message": exc.message}]
        return TemplatePreview(valid=False, errors=details)
    return TemplatePreview(
        valid=True, name=template.meta.name, warnings=warnings, counts=service.template_counts(template)
    )


@router.post("/templates/import", status_code=201)
async def import_template(request: Request, current: Current, db: Db, settings: AppSettings) -> TemplateOut:
    template, _ = parse_template(await request.body(), settings)
    stored = _store(current.id, template)
    db.add(stored)
    await db.flush()
    audit(
        db,
        current.id,
        "template.imported",
        ip=client_ip(request),
        target_type="template",
        target_id=stored.id,
    )
    return _out(stored)


@router.post("/templates/from-board", status_code=201)
async def template_from_board(payload: TemplateFromBoard, current: Current, db: Db) -> TemplateOut:
    await access.get_board(db, current.id, payload.board_id)
    board = await load_board(db, payload.board_id)
    template = await service.export_template(
        db, board, include_cards=payload.include_cards, author=current.user.display_name
    )
    template.meta.name = payload.name
    stored = _store(current.id, template)
    db.add(stored)
    await db.flush()
    return _out(stored)


@router.get("/templates/{template_id}")
async def get_template(template_id: UUID, current: Current, db: Db, response: Response) -> TemplateOut:
    template = await access.get_template(db, current.id, template_id)
    set_etag(response, template)
    return _out(template)


@router.get("/templates/{template_id}/download")
async def download_template(template_id: UUID, current: Current, db: Db) -> JSONResponse:
    template = await access.get_template(db, current.id, template_id)
    audit(db, current.id, "template.exported", target_type="template", target_id=template_id)
    return JSONResponse(
        template.data,
        headers={"Content-Disposition": f'attachment; filename="template-{template_id}.json"'},
    )


@router.patch("/templates/{template_id}")
async def update_template(
    template_id: UUID,
    payload: TemplateUpdate,
    current: Current,
    db: Db,
    response: Response,
    if_match: IfMatch = None,
) -> TemplateOut:
    template = await access.get_template(db, current.id, template_id)
    check_version(template, if_match)
    data = dict(template.data)
    meta = dict(data["meta"])
    if payload.name is not None:
        template.name = meta["name"] = payload.name
    if payload.description is not None:
        template.description = meta["description"] = payload.description
    data["meta"] = meta
    template.data = data
    bump(template, response)
    return _out(template)


@router.post("/templates/{template_id}/duplicate", status_code=201)
async def duplicate_template(template_id: UUID, current: Current, db: Db) -> TemplateOut:
    source = await access.get_template(db, current.id, template_id)
    data = dict(source.data)
    name = f"{source.name} (копия)"[:200]
    data["meta"] = {**data["meta"], "name": name}
    stored = Template(owner_id=current.id, name=name, description=source.description, data=data)
    db.add(stored)
    await db.flush()
    return _out(stored)


@router.delete("/templates/{template_id}")
async def delete_template(template_id: UUID, current: Current, db: Db) -> Ok:
    template = await access.get_template(db, current.id, template_id)
    template.deleted_at = utcnow()
    return Ok()


@router.post("/templates/{template_id}/restore")
async def restore_template(template_id: UUID, current: Current, db: Db) -> TemplateOut:
    template = await access.get_template(db, current.id, template_id, deleted=True)
    template.deleted_at = None
    return _out(template)
