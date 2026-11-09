"""Теги проекта и документы: загрузка, версии, просмотр, комментарии."""

import asyncio
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, Path, Query, Request, Response
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.api.deps import AppSettings, Current, Db, Principal, client_ip
from app.core.db import utcnow
from app.core.errors import ApiError, forbidden, not_found
from app.models import Document, DocumentComment, DocumentTag, DocumentVersion, ProjectTag
from app.repositories import access
from app.schemas.api import (
    CommentCreate,
    DocumentCommentOut,
    DocumentDetail,
    DocumentOut,
    DocumentPreview,
    DocumentUpdate,
    DocumentVersionOut,
    TagCreate,
    TagOut,
    TagUpdate,
)
from app.schemas.auth import Ok
from app.services import cards as card_service
from app.services import documents as service
from app.services.audit import audit
from app.services.fractional import key_between

router = APIRouter(tags=["workspace"])

FileName = Annotated[str | None, Header(alias="X-File-Name", max_length=1024)]
Name = Annotated[str | None, Query(max_length=200)]
Description = Annotated[str, Query(max_length=20000)]


# ---------- теги ----------


async def project_tags(db: Db, project_id: UUID) -> list[ProjectTag]:
    rows = await db.execute(
        select(ProjectTag).where(ProjectTag.project_id == project_id).order_by(ProjectTag.position)
    )
    return list(rows.scalars().all())


@router.get("/projects/{project_id}/tags")
async def list_tags(project_id: UUID, current: Current, db: Db) -> list[TagOut]:
    await access.get_project(db, current.id, project_id)
    return [TagOut.model_validate(tag) for tag in await project_tags(db, project_id)]


@router.post("/projects/{project_id}/tags", status_code=201)
async def create_tag(project_id: UUID, payload: TagCreate, current: Current, db: Db) -> TagOut:
    await access.get_project(db, current.id, project_id, "editor")
    last = await db.scalar(
        select(ProjectTag.position)
        .where(ProjectTag.project_id == project_id)
        .order_by(ProjectTag.position.desc())
        .limit(1)
    )
    tag = ProjectTag(
        project_id=project_id,
        name=payload.name.strip(),
        color=payload.color.upper(),
        position=key_between(last, None),
    )
    db.add(tag)
    try:
        await db.flush()
    except IntegrityError as exc:
        raise ApiError(409, "duplicate_tag", "Тег с таким названием уже есть") from exc
    return TagOut.model_validate(tag)


@router.patch("/tags/{tag_id}")
async def update_tag(tag_id: UUID, payload: TagUpdate, current: Current, db: Db) -> TagOut:
    tag, _ = await access.get_tag(db, current.id, tag_id, "editor")
    if payload.name is not None:
        tag.name = payload.name.strip()
    if payload.color is not None:
        tag.color = payload.color.upper()
    try:
        await db.flush()
    except IntegrityError as exc:
        raise ApiError(409, "duplicate_tag", "Тег с таким названием уже есть") from exc
    return TagOut.model_validate(tag)


@router.delete("/tags/{tag_id}")
async def delete_tag(tag_id: UUID, current: Current, db: Db) -> Ok:
    tag, _ = await access.get_tag(db, current.id, tag_id, "editor")
    await db.delete(tag)
    return Ok()


# ---------- документы ----------


def _document_query() -> object:
    return select(Document).options(selectinload(Document.versions), selectinload(Document.comments))


async def _tag_ids(db: Db, document_ids: list[UUID]) -> dict[UUID, list[UUID]]:
    result: dict[UUID, list[UUID]] = {}
    if not document_ids:
        return result
    rows = await db.execute(
        select(DocumentTag.document_id, DocumentTag.tag_id).where(DocumentTag.document_id.in_(document_ids))
    )
    for document_id, tag_id in rows:
        result.setdefault(document_id, []).append(tag_id)
    return result


def _version_out(version: DocumentVersion) -> DocumentVersionOut:
    return DocumentVersionOut.model_validate(version)


def _document_out(document: Document, tags: list[UUID]) -> DocumentOut:
    return DocumentOut(
        id=document.id,
        project_id=document.project_id,
        name=document.name,
        description=document.description,
        tags=tags,
        current=_version_out(document.versions[-1]),
        versions_count=len(document.versions),
        comments_count=len(document.comments),
        created_at=document.created_at,
        updated_at=document.updated_at,
    )


async def _load(db: Db, document_id: UUID) -> Document:
    statement = (
        _document_query()
        .where(Document.id == document_id)  # type: ignore[attr-defined]
        .execution_options(populate_existing=True)
    )
    document: Document = (await db.execute(statement)).scalar_one()
    return document


async def _detail(db: Db, document_id: UUID, role: str) -> DocumentDetail:
    document = await _load(db, document_id)
    tags = (await _tag_ids(db, [document.id])).get(document.id, [])
    base = _document_out(document, tags)
    return DocumentDetail(
        **base.model_dump(),
        versions=[_version_out(version) for version in reversed(document.versions)],
        comments=[DocumentCommentOut.model_validate(comment) for comment in document.comments],
        role=role,
    )


def _actor(current: Principal) -> str:
    return current.user.display_name


@router.get("/projects/{project_id}/documents")
async def list_documents(project_id: UUID, current: Current, db: Db) -> list[DocumentOut]:
    await access.get_project(db, current.id, project_id)
    rows = await db.execute(
        _document_query()
        .where(Document.project_id == project_id, Document.deleted_at.is_(None))  # type: ignore[attr-defined]
        .order_by(Document.updated_at.desc())
    )
    documents = list(rows.scalars().all())
    tags = await _tag_ids(db, [document.id for document in documents])
    return [_document_out(document, tags.get(document.id, [])) for document in documents]


async def _new_version(
    db: Db, settings: AppSettings, document: Document, filename: str, data: bytes, current: Principal
) -> DocumentVersion:
    kind, digest, preview = await service.prepare(filename, data, settings.file_max_bytes)
    number = (
        await db.scalar(
            select(func.coalesce(func.max(DocumentVersion.number), 0)).where(
                DocumentVersion.document_id == document.id
            )
        )
        or 0
    ) + 1
    version = DocumentVersion(
        document_id=document.id,
        number=number,
        filename=filename,
        kind=kind,
        size=len(data),
        sha256=digest,
        data=data,
        preview=preview,
        uploaded_by=current.id,
        uploader_name=_actor(current),
    )
    db.add(version)
    document.updated_at = utcnow()
    await db.flush()
    return version


@router.post("/projects/{project_id}/documents", status_code=201)
async def upload_document(
    project_id: UUID,
    request: Request,
    current: Current,
    db: Db,
    settings: AppSettings,
    file_name: FileName = None,
    name: Name = None,
    description: Description = "",
) -> DocumentDetail:
    """Тело запроса — сам файл; имя приходит в X-File-Name (URL-кодированное)."""
    found = await access.get_project(db, current.id, project_id, "editor")
    filename = service.decode_filename(file_name)
    document = Document(
        project_id=project_id,
        name=(name or filename).strip()[:200] or filename,
        description=description,
        created_by=current.id,
    )
    db.add(document)
    await db.flush()
    await _new_version(db, settings, document, filename, await request.body(), current)
    audit(
        db,
        current.id,
        "document.uploaded",
        ip=client_ip(request),
        target_type="document",
        target_id=document.id,
    )
    return await _detail(db, document.id, found.role)


@router.get("/documents/{document_id}")
async def get_document(document_id: UUID, current: Current, db: Db) -> DocumentDetail:
    _, found = await access.get_document(db, current.id, document_id)
    return await _detail(db, document_id, found.role)


@router.patch("/documents/{document_id}")
async def update_document(
    document_id: UUID, payload: DocumentUpdate, current: Current, db: Db
) -> DocumentDetail:
    document, found = await access.get_document(db, current.id, document_id, "editor")
    if payload.name is not None:
        document.name = payload.name.strip() or document.name
    if payload.description is not None:
        document.description = payload.description
    if payload.tags is not None:
        tags = await card_service.resolve_tags(db, document.project_id, payload.tags)
        await db.execute(delete(DocumentTag).where(DocumentTag.document_id == document.id))
        db.add_all(DocumentTag(document_id=document.id, tag_id=tag) for tag in tags)
    document.updated_at = utcnow()
    await db.flush()
    return await _detail(db, document_id, found.role)


@router.delete("/documents/{document_id}")
async def delete_document(document_id: UUID, request: Request, current: Current, db: Db) -> Ok:
    document, _ = await access.get_document(db, current.id, document_id, "editor")
    document.deleted_at = utcnow()
    audit(
        db,
        current.id,
        "document.deleted",
        ip=client_ip(request),
        target_type="document",
        target_id=document.id,
    )
    return Ok()


@router.post("/documents/{document_id}/restore")
async def restore_document(document_id: UUID, current: Current, db: Db) -> DocumentDetail:
    document, found = await access.get_document(db, current.id, document_id, "editor", deleted=True)
    document.deleted_at = None
    await db.flush()
    return await _detail(db, document_id, found.role)


@router.post("/documents/{document_id}/versions", status_code=201)
async def upload_version(
    document_id: UUID,
    request: Request,
    current: Current,
    db: Db,
    settings: AppSettings,
    file_name: FileName = None,
) -> DocumentDetail:
    """Новая версия не затирает старые: история остаётся доступной для просмотра и скачивания."""
    document, found = await access.get_document(db, current.id, document_id, "editor")
    filename = service.decode_filename(file_name)
    await _new_version(db, settings, document, filename, await request.body(), current)
    audit(
        db,
        current.id,
        "document.version",
        ip=client_ip(request),
        target_type="document",
        target_id=document.id,
    )
    return await _detail(db, document_id, found.role)


async def _version(db: Db, current: Principal, document_id: UUID, number: int) -> DocumentVersion:
    await access.get_document(db, current.id, document_id)
    version = (
        await db.execute(
            select(DocumentVersion).where(
                DocumentVersion.document_id == document_id, DocumentVersion.number == number
            )
        )
    ).scalar_one_or_none()
    if version is None:
        raise not_found()
    return version


@router.get("/documents/{document_id}/versions/{number}/content")
async def version_content(
    document_id: UUID,
    number: Annotated[int, Path(ge=1, le=100000)],
    current: Current,
    db: Db,
    inline: bool = False,
) -> Response:
    version = await _version(db, current, document_id, number)
    media_type, headers = service.content_headers(version.filename, version.kind, inline)
    return Response(version.data, media_type=media_type, headers=headers)


@router.get("/documents/{document_id}/versions/{number}/preview")
async def version_preview(
    document_id: UUID, number: Annotated[int, Path(ge=1, le=100000)], current: Current, db: Db
) -> DocumentPreview:
    version = await _version(db, current, document_id, number)
    preview = version.preview or {"kind": "none", "reason": "unsupported"}
    # Word, загруженный до выноса картинок из HTML, пересобирается при первом открытии.
    if version.kind == "docx" and preview.get("format") != 2:
        preview = await asyncio.to_thread(service.build_preview, version.kind, version.data)
        version.preview = preview
    markup = preview.get("html")
    if markup:
        base = f"/api/v1/documents/{document_id}/versions/{number}/images/"
        preview = {**preview, "html": markup.replace(f'src="{service.IMAGE_SCHEME}:', f'src="{base}')}
    return DocumentPreview.model_validate(preview)


@router.get("/documents/{document_id}/versions/{number}/images/{index}")
async def version_image(
    document_id: UUID,
    number: Annotated[int, Path(ge=1, le=100000)],
    index: Annotated[int, Path(ge=0, le=10000)],
    current: Current,
    db: Db,
) -> Response:
    version = await _version(db, current, document_id, number)
    if version.kind != "docx":
        raise not_found()
    found = await asyncio.to_thread(service.docx_image, version.data, version.preview, index)
    if found is None:
        raise not_found()
    data, media_type = found
    return Response(
        data,
        media_type=media_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cache-Control": "private, max-age=86400",
        },
    )


@router.post("/documents/{document_id}/comments", status_code=201)
async def create_comment(
    document_id: UUID, payload: CommentCreate, current: Current, db: Db
) -> DocumentCommentOut:
    await access.get_document(db, current.id, document_id, "editor")
    comment = DocumentComment(
        document_id=document_id, author_id=current.id, author_name=_actor(current), body=payload.body
    )
    db.add(comment)
    await db.flush()
    return DocumentCommentOut.model_validate(comment)


@router.patch("/document-comments/{document_comment_id}")
async def update_comment(
    document_comment_id: UUID, payload: CommentCreate, current: Current, db: Db
) -> DocumentCommentOut:
    comment, _ = await access.get_document_comment(db, current.id, document_comment_id, "editor")
    if comment.author_id != current.id:
        raise forbidden("Редактировать можно только свои комментарии")
    comment.body = payload.body
    await db.flush()
    return DocumentCommentOut.model_validate(comment)


@router.delete("/document-comments/{document_comment_id}")
async def delete_comment(document_comment_id: UUID, current: Current, db: Db) -> Ok:
    comment, found = await access.get_document_comment(db, current.id, document_comment_id, "editor")
    # Чужой комментарий может убрать только владелец проекта.
    if comment.author_id != current.id and found.role != "owner":
        raise forbidden("Удалить можно только свой комментарий")
    await db.delete(comment)
    return Ok()
