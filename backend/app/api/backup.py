import gzip
import json
from collections.abc import AsyncIterator
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import select

from app.api.deps import AppSettings, Current, Db, client_ip
from app.core.errors import ApiError, not_found
from app.models import AuditLog, BackupSnapshot, User
from app.schemas.backup import (
    BackupExportIn,
    BackupHistory,
    BackupHistoryItem,
    BackupImportResult,
    BackupPreview,
    SnapshotOut,
)
from app.security import backup_crypto
from app.services import backup as service
from app.services import spreadsheet
from app.services.audit import audit

router = APIRouter(tags=["backup"])

BackupPassword = Annotated[str | None, Header(alias="X-Backup-Password", max_length=256)]


def _attachment(filename: str) -> dict[str, str]:
    return {"Content-Disposition": f'attachment; filename="{filename}"'}


@router.get("/export/backup")
async def export_backup(
    request: Request,
    current: Current,
    db: Db,
    scope: Annotated[str, Query(max_length=64)] = "account",
    compress: bool = False,
) -> StreamingResponse:
    parsed = service.parse_scope(scope)
    await service.check_scope(db, current.id, parsed)
    audit(db, current.id, "backup.exported", ip=client_ip(request), scope=parsed.type)
    await db.flush()
    factory = request.app.state.session_factory
    user_id = current.id

    async def stream() -> AsyncIterator[bytes]:
        # Запросная сессия к этому моменту закрыта: у стрима своя, на всё время передачи.
        async with factory() as session:
            user = await session.get(User, user_id)
            chunks = service.iter_backup(session, user, parsed, release=True)
            async for chunk in service.gzip_stream(chunks) if compress else chunks:
                yield chunk

    suffix = ".json.gz" if compress else ".json"
    media_type = "application/gzip" if compress else "application/json"
    return StreamingResponse(
        stream(), media_type=media_type, headers=_attachment(service.backup_filename(suffix=suffix))
    )


@router.post("/export/backup")
async def export_encrypted_backup(
    payload: BackupExportIn, request: Request, current: Current, db: Db
) -> Response:
    """Пароль только в теле запроса. Шифрование требует весь документ, поэтому не стрим."""
    parsed = service.parse_scope(payload.scope)
    await service.check_scope(db, current.id, parsed)
    raw = await service.collect(service.iter_backup(db, current.user, parsed))
    audit(
        db,
        current.id,
        "backup.exported",
        ip=client_ip(request),
        scope=parsed.type,
        encrypted=payload.password is not None,
    )
    if payload.gzip:
        raw = gzip.compress(raw)
    if payload.password is None:
        suffix = ".json.gz" if payload.gzip else ".json"
        return Response(
            raw, media_type="application/json", headers=_attachment(service.backup_filename(suffix=suffix))
        )
    body = json.dumps(backup_crypto.encrypt(raw, payload.password)).encode()
    filename = service.backup_filename(suffix=".enc.json")
    return Response(body, media_type="application/json", headers=_attachment(filename))


@router.get("/export/csv")
async def export_tables(
    request: Request,
    current: Current,
    db: Db,
    scope: Annotated[str, Query(max_length=64)] = "account",
) -> Response:
    """Таблицы Excel всех досок аккаунта, проекта или одной доски одним ZIP-архивом."""
    parsed = service.parse_scope(scope)
    archive = await spreadsheet.csv_archive(db, current.id, parsed)
    audit(db, current.id, "backup.exported", ip=client_ip(request), scope=parsed.type, format="csv")
    return Response(
        archive,
        media_type="application/zip",
        headers=_attachment(spreadsheet.archive_filename()),
    )


@router.post("/import/backup/preview")
async def preview_backup(
    request: Request,
    current: Current,
    db: Db,
    settings: AppSettings,
    password: BackupPassword = None,
) -> BackupPreview:
    raw = await request.body()
    try:
        parsed = service.read_backup(raw, settings, password)
    except ApiError as exc:
        if exc.code == "password_required":
            return BackupPreview(valid=False, encrypted=True, password_required=True)
        if exc.status == 413:
            raise
        details = exc.details if isinstance(exc.details, list) else [{"path": "", "message": exc.message}]
        wrong_password = exc.code == "wrong_password"
        return BackupPreview(
            valid=False, encrypted=wrong_password, password_required=wrong_password, errors=details
        )
    return await service.preview(db, current.id, parsed)


@router.post("/import/backup")
async def import_backup(
    request: Request,
    current: Current,
    db: Db,
    settings: AppSettings,
    mode: Literal["copy", "replace"] = "copy",
    confirm: Annotated[str | None, Query(max_length=32)] = None,
    password: BackupPassword = None,
) -> BackupImportResult:
    parsed = service.read_backup(await request.body(), settings, password)
    counts, warnings, snapshot_id = await service.restore(db, settings, current.user, parsed, mode, confirm)
    audit(db, current.id, "backup.imported", ip=client_ip(request), mode=mode, counts=counts)
    return BackupImportResult(mode=mode, counts=counts, warnings=warnings, snapshot_id=snapshot_id)


@router.get("/backups")
async def backup_history(current: Current, db: Db) -> BackupHistory:
    events = await db.execute(
        select(AuditLog)
        .where(
            AuditLog.user_id == current.id,
            AuditLog.action.in_(("backup.exported", "backup.imported")),
        )
        .order_by(AuditLog.id.desc())
        .limit(50)
    )
    snapshots = await db.execute(
        select(BackupSnapshot).where(BackupSnapshot.user_id == current.id).order_by(BackupSnapshot.id.desc())
    )
    return BackupHistory(
        events=[
            BackupHistoryItem(action=row.action, created_at=row.created_at, meta=row.meta)
            for row in events.scalars()
        ],
        snapshots=[
            SnapshotOut(id=s.id, filename=s.filename, reason=s.reason, size=s.size, created_at=s.created_at)
            for s in snapshots.scalars()
        ],
    )


@router.get("/backups/snapshots/{snapshot_id}")
async def download_snapshot(snapshot_id: UUID, current: Current, db: Db) -> Response:
    snapshot = await db.get(BackupSnapshot, snapshot_id)
    if snapshot is None or snapshot.user_id != current.id:
        raise not_found()
    return Response(snapshot.data_gz, media_type="application/gzip", headers=_attachment(snapshot.filename))
