"""Экспорт и восстановление данных пользователя.

Экспорт потоковый: документ собирается по одной доске, контрольная сумма считается на лету
и пишется последним полем. Импорт идёт в транзакции запроса: любая ошибка откатывает всё.
"""

import base64
import gzip
import hashlib
import json
import zlib
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import Settings
from app.core.db import utcnow
from app.core.errors import ApiError, format_validation_errors
from app.migrations_json import migrate
from app.models import (
    Attachment,
    BackupSnapshot,
    Board,
    Card,
    CardFieldValue,
    CardTag,
    Checklist,
    ChecklistItem,
    Comment,
    Document,
    DocumentComment,
    DocumentTag,
    DocumentVersion,
    Project,
    ProjectMember,
    ProjectTag,
    Template,
    User,
)
from app.repositories import access
from app.schemas.backup import (
    BACKUP_FORMAT,
    BACKUP_SCHEMA_URL,
    BACKUP_VERSION,
    ENCRYPTED_FORMAT,
    BackupBoard,
    BackupCard,
    BackupConflict,
    BackupDocument,
    BackupPreview,
    BackupProject,
    EncryptedBackup,
)
from app.security import backup_crypto
from app.services import cards as card_service
from app.services import documents
from app.services.board_config import apply_config, export_config, load_board
from app.services.cards import BoardIndex, build_index
from app.services.fractional import key_between, sequence
from app.services.json_import import check_depth, strip_extras

REPLACE_CONFIRMATION = "ЗАМЕНИТЬ"
GZIP_MAGIC = b"\x1f\x8b"


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def compute_checksum(data: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical(data)).hexdigest()


def backup_filename(now: datetime | None = None, *, suffix: str = ".json") -> str:
    stamp = (now or datetime.now(UTC)).strftime("%Y-%m-%d-%H%M")
    return f"kanbanly-backup-{stamp}{suffix}"


@dataclass(slots=True)
class Scope:
    type: str
    id: UUID | None = None

    @property
    def label(self) -> str:
        return self.type if self.id is None else f"{self.type}:{self.id}"


def parse_scope(value: str) -> Scope:
    kind, _, raw = value.partition(":")
    if kind == "account" and not raw:
        return Scope("account")
    if kind in {"project", "board"}:
        try:
            return Scope(kind, UUID(raw))
        except ValueError as exc:
            raise ApiError(422, "invalid_scope", "Некорректная область экспорта") from exc
    raise ApiError(422, "invalid_scope", "Некорректная область экспорта")


async def check_scope(db: AsyncSession, user_id: UUID, scope: Scope) -> None:
    if scope.type == "project" and scope.id is not None:
        await access.get_project(db, user_id, scope.id)
    elif scope.type == "board" and scope.id is not None:
        await access.get_board(db, user_id, scope.id)


async def _scope_contents(
    db: AsyncSession, user_id: UUID, scope: Scope
) -> tuple[list[Project], list[UUID], list[Template]]:
    if scope.type == "board" and scope.id is not None:
        found = await access.get_board(db, user_id, scope.id)
        project = await access.get_project(db, user_id, found.board.project_id)
        return [project.project], [found.board.id], []
    if scope.type == "project" and scope.id is not None:
        projects = [(await access.get_project(db, user_id, scope.id)).project]
    else:
        result = await db.execute(
            select(Project)
            .where(Project.owner_id == user_id, Project.deleted_at.is_(None))
            .order_by(Project.id)
        )
        projects = list(result.scalars().all())
    project_ids = [project.id for project in projects]
    boards = await db.execute(
        select(Board.id)
        .where(Board.project_id.in_(project_ids), Board.deleted_at.is_(None))
        .order_by(Board.id)
    )
    templates: list[Template] = []
    if scope.type == "account":
        stored = await db.execute(
            select(Template)
            .where(Template.owner_id == user_id, Template.deleted_at.is_(None))
            .order_by(Template.id)
        )
        templates = list(stored.scalars().all())
    return projects, list(boards.scalars().all()), templates


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _json_config(board: Board) -> dict[str, Any]:
    config: dict[str, Any] = export_config(board).model_dump(mode="json", by_alias=True, exclude_none=True)
    return config


async def _board_document(db: AsyncSession, board_id: UUID) -> dict[str, Any]:
    board = await load_board(db, board_id)
    index = build_index(board)
    statement = (
        card_service.card_query()
        .where(Card.board_id == board_id, Card.deleted_at.is_(None))
        .options(selectinload(Card.comments), selectinload(Card.attachments))
        .order_by(Card.position, Card.id)
    )
    cards = (await db.execute(statement)).scalars().all()
    tag_names = {tag.id: tag.name for tag in await _project_tags(db, board.project_id)}
    assignees = {card.assignee_id for card in cards if card.assignee_id}
    emails: dict[UUID, str] = {}
    if assignees:
        rows = await db.execute(select(User.id, User.email).where(User.id.in_(assignees)))
        for user_id, email in rows:
            emails[user_id] = email
    document = {
        "source_id": str(board.id),
        "project_source_id": str(board.project_id),
        "name": board.name,
        "description": board.description,
        "is_favorite": board.is_favorite,
        "source_template": board.source_template,
        "config": _json_config(board),
        "cards": [_card_document(card, index, tag_names, emails) for card in cards],
        "created_at": _iso(board.created_at),
        "updated_at": _iso(board.updated_at),
    }
    return document


async def _project_tags(db: AsyncSession, project_id: UUID) -> list[ProjectTag]:
    rows = await db.execute(
        select(ProjectTag).where(ProjectTag.project_id == project_id).order_by(ProjectTag.position)
    )
    return list(rows.scalars().all())


async def _project_document(db: AsyncSession, project: Project, *, with_documents: bool) -> dict[str, Any]:
    """Проект с тегами и документами. Документы идут во все бэкапы, кроме бэкапа одной доски."""
    tags = await _project_tags(db, project.id)
    names = {tag.id: tag.name for tag in tags}
    documents: list[dict[str, Any]] = []
    if with_documents:
        rows = await db.execute(
            select(Document)
            .where(Document.project_id == project.id, Document.deleted_at.is_(None))
            .options(selectinload(Document.versions), selectinload(Document.comments))
            .order_by(Document.id)
        )
        for item in rows.scalars():
            links = await db.execute(select(DocumentTag.tag_id).where(DocumentTag.document_id == item.id))
            documents.append(
                {
                    "source_id": str(item.id),
                    "name": item.name,
                    "description": item.description,
                    "tags": sorted(names[tag] for tag in links.scalars() if tag in names),
                    "versions": [
                        {
                            "number": version.number,
                            "filename": version.filename,
                            "data": base64.b64encode(version.data).decode(),
                            "uploader_name": version.uploader_name,
                            "created_at": _iso(version.created_at),
                        }
                        for version in item.versions
                    ],
                    "comments": [
                        {"author_name": c.author_name, "body": c.body, "created_at": _iso(c.created_at)}
                        for c in item.comments
                    ],
                    "created_at": _iso(item.created_at),
                    "updated_at": _iso(item.updated_at),
                }
            )
    return {
        "source_id": str(project.id),
        "name": project.name,
        "description": project.description,
        "tags": [{"name": tag.name, "color": tag.color} for tag in tags],
        "documents": documents,
        "created_at": _iso(project.created_at),
        "updated_at": _iso(project.updated_at),
    }


def _card_document(
    card: Card, index: BoardIndex, tag_names: dict[UUID, str], emails: dict[UUID, str]
) -> dict[str, Any]:
    data = card_service.serialize(card, index)
    return {
        "source_id": str(card.id),
        "color": card.color,
        "assignee_email": emails.get(card.assignee_id) if card.assignee_id else None,
        "tags": sorted(tag_names[link.tag_id] for link in card.tags if link.tag_id in tag_names),
        "column": data.column,
        "title": card.title,
        "description": card.description,
        "position": card.position,
        "due_date": card.due_date.isoformat() if card.due_date else None,
        "completed_at": _iso(card.completed_at),
        "cover_url": card.cover_url,
        "values": data.values,
        "fields": data.fields,
        "checklists": [
            {"title": c.title, "items": [{"text": i.text, "done": i.done} for i in c.items]}
            for c in card.checklists
        ],
        "comments": [
            {"author_name": c.author_name, "body": c.body, "created_at": _iso(c.created_at)}
            for c in sorted(card.comments, key=lambda comment: comment.id)
        ],
        "attachments": [
            {"name": a.name, "url": a.url, "created_at": _iso(a.created_at)}
            for a in sorted(card.attachments, key=lambda attachment: attachment.id)
        ],
        "created_at": _iso(card.created_at),
        "updated_at": _iso(card.updated_at),
    }


async def iter_backup(
    db: AsyncSession, user: User, scope: Scope, *, release: bool = False
) -> AsyncIterator[bytes]:
    """Чанки JSON. Ключи data идут по алфавиту — поток совпадает с каноническим видом.

    release=True сбрасывает загруженные доски после записи. Только для отдельной сессии стрима:
    в сессии запроса это отцепило бы объекты, которые запрос ещё меняет.
    """
    projects, board_ids, templates = await _scope_contents(db, user.id, scope)
    digest = hashlib.sha256()

    def emit(chunk: bytes) -> bytes:
        digest.update(chunk)
        return chunk

    header = {
        "$schema": BACKUP_SCHEMA_URL,
        "format": BACKUP_FORMAT,
        "version": BACKUP_VERSION,
        "exported_at": datetime.now(UTC).isoformat(),
        "scope": {"type": scope.type, "id": str(scope.id) if scope.id else None},
    }
    yield json.dumps(header, ensure_ascii=False)[:-1].encode() + b',"data":'
    yield emit(b'{"boards":[')
    for number, board_id in enumerate(board_ids):
        prefix = b"," if number else b""
        yield emit(prefix + canonical(await _board_document(db, board_id)))
        if release:
            # Освобождаем загруженные доски: иначе память растёт вместе с аккаунтом.
            db.expunge_all()
    profile = {"display_name": user.display_name, "email": user.email, "locale": user.locale}
    yield emit(b'],"profile":' + canonical(profile) + b',"projects":[')
    for number, project in enumerate(projects):
        prefix = b"," if number else b""
        yield emit(
            prefix + canonical(await _project_document(db, project, with_documents=scope.type != "board"))
        )
        if release:
            db.expunge_all()
    yield emit(b'],"templates":[')
    template_docs = [
        {
            "source_id": str(t.id),
            "name": t.name,
            "description": t.description,
            "data": t.data,
            "created_at": _iso(t.created_at),
            "updated_at": _iso(t.updated_at),
        }
        for t in templates
    ]
    yield emit(b",".join(canonical(doc) for doc in template_docs) + b"]}")
    yield f',"checksum":"sha256:{digest.hexdigest()}"}}'.encode()


async def gzip_stream(chunks: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    compressor = zlib.compressobj(wbits=31)
    async for chunk in chunks:
        compressed = compressor.compress(chunk)
        if compressed:
            yield compressed
    yield compressor.flush()


async def collect(chunks: AsyncIterator[bytes]) -> bytes:
    return b"".join([chunk async for chunk in chunks])


def _gunzip(raw: bytes, limit: int) -> bytes:
    decompressor = zlib.decompressobj(wbits=31)
    try:
        result = decompressor.decompress(raw, limit + 1)
    except zlib.error as exc:
        raise ApiError(422, "corrupted_backup", "Файл бэкапа повреждён") from exc
    if len(result) > limit:
        # Защита от zip-бомбы: распаковка останавливается на лимите.
        raise ApiError(413, "payload_too_large", "Распакованный бэкап больше допустимого размера")
    return result


@dataclass(slots=True)
class ParsedBackup:
    document: BackupDocument
    warnings: list[str]
    encrypted: bool


def load_json(raw: bytes, settings: Settings) -> Any:
    limit = settings.backup_max_bytes
    if len(raw) > limit:
        raise ApiError(413, "payload_too_large", "Файл больше допустимого размера")
    if raw.startswith(GZIP_MAGIC):
        raw = _gunzip(raw, limit)
    try:
        document = json.loads(raw)
    except RecursionError as exc:
        raise ApiError(422, "too_deep", "Слишком глубокая вложенность JSON") from exc
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiError(422, "invalid_json", "Файл не является корректным JSON") from exc
    check_depth(document, settings.json_max_depth)
    return document


def read_backup(raw: bytes, settings: Settings, password: str | None) -> ParsedBackup:
    document = load_json(raw, settings)
    if not isinstance(document, dict):
        raise ApiError(422, "invalid_backup", "Ожидается JSON-объект бэкапа")
    encrypted = document.get("format") == ENCRYPTED_FORMAT
    if encrypted:
        if not password:
            raise ApiError(400, "password_required", "Бэкап зашифрован: укажите пароль")
        try:
            wrapper = EncryptedBackup.model_validate(document)
        except ValidationError as exc:
            problems = format_validation_errors(list(exc.errors()))
            raise ApiError(422, "corrupted_backup", "Файл бэкапа повреждён", problems) from exc
        document = load_json(backup_crypto.decrypt(wrapper, password), settings)
        if not isinstance(document, dict):
            raise ApiError(422, "invalid_backup", "Ожидается JSON-объект бэкапа")
    if document.get("format") != BACKUP_FORMAT:
        raise ApiError(
            422,
            "invalid_format",
            "Это не файл бэкапа Kanbanly",
            [{"path": "format", "message": "неверный формат"}],
        )
    migrated, notes = migrate(BACKUP_FORMAT, document)
    if "data" in migrated and migrated.get("checksum") != compute_checksum(migrated["data"]):
        raise ApiError(422, "checksum_mismatch", "Контрольная сумма не совпала: файл повреждён или изменён")
    try:
        parsed = BackupDocument.model_validate(migrated)
    except ValidationError as exc:
        problems = format_validation_errors(list(exc.errors()))
        raise ApiError(422, "invalid_backup", "Бэкап не прошёл проверку", problems) from exc
    _check_references(parsed)
    return ParsedBackup(parsed, notes + strip_extras(parsed), encrypted)


def _check_references(document: BackupDocument) -> None:
    projects = {project.source_id for project in document.data.projects}
    for index, board in enumerate(document.data.boards):
        if board.project_source_id not in projects:
            raise ApiError(
                422,
                "invalid_backup",
                "Бэкап не прошёл проверку",
                [{"path": f"data.boards[{index}].project_source_id", "message": "проект не найден"}],
            )


def counts(document: BackupDocument) -> dict[str, int]:
    data = document.data
    return {
        "projects": len(data.projects),
        "boards": len(data.boards),
        "cards": sum(len(board.cards) for board in data.boards),
        "templates": len(data.templates),
        "documents": sum(len(project.documents) for project in data.projects),
    }


async def _owned_projects(db: AsyncSession, user_id: UUID) -> list[Project]:
    result = await db.execute(
        select(Project).where(Project.owner_id == user_id, Project.deleted_at.is_(None))
    )
    return list(result.scalars().all())


def _match(items: list[Any], source_id: UUID, name: str) -> Any | None:
    return next((i for i in items if i.id == source_id), None) or next(
        (i for i in items if i.name == name), None
    )


async def find_conflicts(db: AsyncSession, user_id: UUID, document: BackupDocument) -> list[BackupConflict]:
    conflicts: list[BackupConflict] = []
    projects = await _owned_projects(db, user_id)
    for project in document.data.projects:
        if _match(projects, project.source_id, project.name):
            conflicts.append(BackupConflict(type="project", name=project.name))
    templates = await db.execute(
        select(Template).where(Template.owner_id == user_id, Template.deleted_at.is_(None))
    )
    stored = list(templates.scalars().all())
    for template in document.data.templates:
        if _match(stored, template.source_id, template.name):
            conflicts.append(BackupConflict(type="template", name=template.name))
    return conflicts


async def preview(db: AsyncSession, user_id: UUID, parsed: ParsedBackup) -> BackupPreview:
    document = parsed.document
    return BackupPreview(
        valid=True,
        encrypted=parsed.encrypted,
        exported_at=document.exported_at,
        scope=document.scope.type,
        counts=counts(document),
        conflicts=await find_conflicts(db, user_id, document),
        warnings=parsed.warnings,
    )


async def create_snapshot(db: AsyncSession, user: User) -> BackupSnapshot:
    raw = await collect(iter_backup(db, user, Scope("account")))
    snapshot = BackupSnapshot(
        user_id=user.id,
        filename=backup_filename(suffix=".json.gz"),
        size=len(raw),
        data_gz=gzip.compress(raw),
    )
    db.add(snapshot)
    await db.flush()
    return snapshot


async def _soft_delete_for_replace(
    db: AsyncSession, user_id: UUID, document: BackupDocument
) -> dict[UUID, Project]:
    """Удаляет (в корзину) то, что заменяется; возвращает проекты, куда ложатся доски."""
    now = utcnow()
    projects = await _owned_projects(db, user_id)
    scope = document.scope
    keep_projects: dict[UUID, Project] = {}
    if scope.type == "account":
        for project in projects:
            project.deleted_at = now
        templates = await db.execute(
            select(Template).where(Template.owner_id == user_id, Template.deleted_at.is_(None))
        )
        for template in templates.scalars():
            template.deleted_at = now
        return keep_projects
    for backup_project in document.data.projects:
        existing = _match(projects, backup_project.source_id, backup_project.name)
        if existing is None:
            continue
        if scope.type == "project":
            existing.deleted_at = now
            continue
        keep_projects[backup_project.source_id] = existing
        boards = await db.execute(
            select(Board).where(Board.project_id == existing.id, Board.deleted_at.is_(None))
        )
        current = list(boards.scalars().all())
        for backup_board in document.data.boards:
            match = _match(current, backup_board.source_id, backup_board.name)
            if match is not None:
                match.deleted_at = now
    return keep_projects


def _copy_name(name: str, taken: set[str]) -> str:
    if name not in taken:
        return name
    return f"{name[:190]} (копия)"


async def _restore_project(db: AsyncSession, user_id: UUID, source: BackupProject, name: str) -> Project:
    project = Project(
        owner_id=user_id,
        name=name,
        description=source.description,
        created_at=source.created_at,
        updated_at=source.updated_at,
    )
    db.add(project)
    await db.flush()
    db.add(ProjectMember(project_id=project.id, user_id=user_id, role="owner"))
    return project


async def ensure_tags(db: AsyncSession, project: Project, tags: list[Any]) -> dict[str, UUID]:
    """Теги проекта по именам: существующие используются, недостающие создаются."""
    existing = {tag.name: tag for tag in await _project_tags(db, project.id)}
    last = max((tag.position for tag in existing.values()), default=None)
    for source in tags:
        if source.name in existing:
            continue
        last = key_between(last, None)
        tag = ProjectTag(project_id=project.id, name=source.name, color=source.color, position=last)
        db.add(tag)
        existing[source.name] = tag
    await db.flush()
    return {name: tag.id for name, tag in existing.items()}


async def _restore_documents(
    db: AsyncSession, settings: Settings, project: Project, source: BackupProject, tags: dict[str, UUID]
) -> None:
    for item in source.documents:
        restored = Document(
            project_id=project.id,
            name=item.name,
            description=item.description,
            created_at=item.created_at,
            updated_at=item.updated_at,
        )
        db.add(restored)
        await db.flush()
        for version in item.versions:
            try:
                data = base64.b64decode(version.data, validate=True)
            except ValueError as exc:
                raise ApiError(422, "invalid_backup", f"Повреждён файл «{version.filename}»") from exc
            kind, digest, preview = await documents.prepare(version.filename, data, settings.file_max_bytes)
            db.add(
                DocumentVersion(
                    document_id=restored.id,
                    number=version.number,
                    filename=version.filename,
                    kind=kind,
                    size=len(data),
                    sha256=digest,
                    data=data,
                    preview=preview,
                    uploader_name=version.uploader_name,
                    created_at=version.created_at,
                )
            )
        db.add_all(
            DocumentComment(
                document_id=restored.id,
                author_name=comment.author_name,
                body=comment.body,
                created_at=comment.created_at,
                updated_at=comment.created_at,
            )
            for comment in item.comments
        )
        db.add_all(
            DocumentTag(document_id=restored.id, tag_id=tags[name]) for name in item.tags if name in tags
        )
    await db.flush()


async def project_people(db: AsyncSession, project_id: UUID) -> dict[str, UUID]:
    """Участники проекта по email: исполнители из бэкапа назначаются только им."""
    rows = await db.execute(
        select(User.email, User.id)
        .join(ProjectMember, ProjectMember.user_id == User.id)
        .where(ProjectMember.project_id == project_id)
    )
    people: dict[str, UUID] = {}
    for email, user_id in rows:
        people[email] = user_id
    return people


async def restore_board(
    db: AsyncSession,
    project: Project,
    source: BackupBoard,
    tags: dict[str, UUID],
    people: dict[str, UUID] | None = None,
) -> Board:
    board = Board(
        project_id=project.id,
        name=source.name,
        description=source.description,
        is_favorite=source.is_favorite,
        settings={},
        source_template=source.source_template,
        created_at=source.created_at,
        columns=[],
        dimensions=[],
        fields=[],
        views=[],
    )
    db.add(board)
    await db.flush()
    await apply_config(db, board, source.config)
    board = await load_board(db, board.id)
    index = build_index(board)
    people = people if people is not None else await project_people(db, project.id)
    for card in source.cards:
        db.add(_restore_card(board, index, card, tags, people))
    board.updated_at = source.updated_at
    await db.flush()
    return board


def _restore_card(
    board: Board,
    index: BoardIndex,
    source: BackupCard,
    tags: dict[str, UUID],
    people: dict[str, UUID],
) -> Card:
    column = index.columns_by_key.get(source.column)
    if column is None:
        raise ApiError(422, "invalid_backup", f"Колонка «{source.column}» не найдена в доске «{board.name}»")
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=source.title,
        description=source.description,
        position=source.position,
        due_date=source.due_date,
        completed_at=source.completed_at,
        cover_url=source.cover_url,
        color=source.color,
        assignee_id=people.get(source.assignee_email) if source.assignee_email else None,
        created_at=source.created_at,
        updated_at=source.updated_at,
        tags=[CardTag(tag_id=tags[name]) for name in dict.fromkeys(source.tags) if name in tags],
        dimension_values=[],
        field_values=[],
        checklists=[],
        comments=[],
        attachments=[],
    )
    card_service.set_values(card, index, dict(source.values))
    _restore_fields(card, index, source.fields)
    for checklist, position in zip(source.checklists, sequence(len(source.checklists)), strict=True):
        card.checklists.append(
            Checklist(
                title=checklist.title,
                position=position,
                items=[
                    ChecklistItem(text=item.text, done=item.done, position=item_position)
                    for item, item_position in zip(
                        checklist.items, sequence(len(checklist.items)), strict=True
                    )
                ],
            )
        )
    card.comments.extend(
        Comment(author_name=c.author_name, body=c.body, created_at=c.created_at, updated_at=c.created_at)
        for c in source.comments
    )
    card.attachments.extend(
        Attachment(name=a.name, url=a.url, created_at=a.created_at, updated_at=a.created_at)
        for a in source.attachments
    )
    return card


def _restore_fields(card: Card, index: BoardIndex, fields: dict[str, Any]) -> None:
    for key, value in fields.items():
        definition = index.fields_by_key.get(key)
        if definition is None:
            raise ApiError(422, "invalid_backup", f"Поле «{key}» не найдено")
        card.field_values.append(CardFieldValue(field_id=definition.id, value=value))


async def restore(
    db: AsyncSession,
    settings: Settings,
    user: User,
    parsed: ParsedBackup,
    mode: str,
    confirmation: str | None,
) -> tuple[dict[str, int], list[str], UUID | None]:
    """Все id создаются заново; владелец — только текущий пользователь."""
    document = parsed.document
    snapshot_id: UUID | None = None
    target_projects: dict[UUID, Project] = {}
    if mode == "replace":
        if confirmation != REPLACE_CONFIRMATION:
            raise ApiError(422, "confirmation_required", f"Подтвердите замену словом {REPLACE_CONFIRMATION}")
        snapshot_id = (await create_snapshot(db, user)).id
        target_projects = await _soft_delete_for_replace(db, user.id, document)
        await db.flush()

    taken = {project.name for project in await _owned_projects(db, user.id)}
    created: dict[UUID, Project] = dict(target_projects)
    for source in document.data.projects:
        if source.source_id in created:
            continue
        name = _copy_name(source.name, taken)
        taken.add(name)
        created[source.source_id] = await _restore_project(db, user.id, source, name)
    tag_maps: dict[UUID, dict[str, UUID]] = {}
    for source in document.data.projects:
        project = created[source.source_id]
        tag_maps[source.source_id] = await ensure_tags(db, project, source.tags)
        await _restore_documents(db, settings, project, source, tag_maps[source.source_id])
    for board in document.data.boards:
        await restore_board(db, created[board.project_source_id], board, tag_maps[board.project_source_id])
    existing_templates = await db.execute(
        select(Template.name).where(Template.owner_id == user.id, Template.deleted_at.is_(None))
    )
    template_names = set(existing_templates.scalars().all())
    for template in document.data.templates:
        name = _copy_name(template.name, template_names)
        template_names.add(name)
        data = template.data.model_dump(mode="json", by_alias=True, exclude_none=True)
        data["meta"]["name"] = name
        db.add(
            Template(
                owner_id=user.id,
                name=name,
                description=template.description,
                data=data,
                created_at=template.created_at,
                updated_at=template.updated_at,
            )
        )
    await db.flush()
    return counts(document), parsed.warnings, snapshot_id
