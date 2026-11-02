"""Схемы REST API."""

from datetime import date, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.template import BoardConfig, BoardTemplate, SafeUrl, ViewTemplate

Title = Annotated[str, Field(min_length=1, max_length=500)]
ProjectName = Annotated[str, Field(min_length=1, max_length=200)]
LongText = Annotated[str, Field(max_length=20000)]
KeyStr = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")]


class Page[T](BaseModel):
    items: list[T]
    next_cursor: str | None = None


class BoardSummary(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    is_favorite: bool
    column_count: int
    card_count: int
    colors: dict[str, str]
    last_opened_at: datetime | None
    updated_at: datetime


class ProjectOut(BaseModel):
    id: UUID
    name: str
    description: str
    role: str
    version: int
    created_at: datetime
    updated_at: datetime
    boards: list[BoardSummary] = []


class ProjectCreate(BaseModel):
    name: ProjectName
    description: LongText = ""


class ProjectUpdate(BaseModel):
    name: ProjectName | None = None
    description: LongText | None = None


class MemberOut(BaseModel):
    user_id: UUID
    display_name: str
    role: str


class BoardCreate(BaseModel):
    """Источник ровно один: preset, template_id, template (файл) или пустая доска."""

    name: ProjectName
    description: LongText = ""
    preset: KeyStr | None = None
    template_id: UUID | None = None
    template: dict[str, Any] | None = None
    include_samples: bool = True


class BoardUpdate(BaseModel):
    name: ProjectName | None = None
    description: LongText | None = None
    is_favorite: bool | None = None


class BoardOut(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    description: str
    version: int
    is_favorite: bool
    role: str
    has_source_template: bool
    source_template_name: str | None
    created_at: datetime
    updated_at: datetime
    config: BoardConfig
    warnings: list[str] = []


class CardOut(BaseModel):
    id: UUID
    board_id: UUID
    column: str
    title: str
    description: str
    position: str
    version: int
    due_date: date | None
    completed_at: datetime | None
    cover_url: str | None
    values: dict[str, list[str]]
    fields: dict[str, Any]
    checklist_done: int
    checklist_total: int
    comments_count: int
    attachments_count: int
    created_at: datetime
    updated_at: datetime


class CardCreate(BaseModel):
    column: KeyStr
    title: Title
    description: LongText = ""
    values: dict[KeyStr, KeyStr | list[KeyStr]] = {}
    fields: dict[KeyStr, Any] = {}
    due_date: date | None = None
    cover_url: SafeUrl | None = None
    # Размещение: сосед сверху; без него карточка идёт в конец колонки.
    after_id: UUID | None = None


class CardUpdate(BaseModel):
    title: Title | None = None
    description: LongText | None = None
    values: dict[KeyStr, KeyStr | list[KeyStr]] | None = None
    fields: dict[KeyStr, Any] | None = None
    due_date: date | None = None
    cover_url: SafeUrl | None = None
    column: KeyStr | None = None


class CardMove(BaseModel):
    column: KeyStr
    # Соседи после перемещения: before_id — карточка сверху, after_id — снизу.
    before_id: UUID | None = None
    after_id: UUID | None = None


class ChecklistItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    text: str
    done: bool
    position: str


class ChecklistOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    position: str
    items: list[ChecklistItemOut]


class CommentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    author_id: UUID | None
    author_name: str
    body: str
    created_at: datetime
    updated_at: datetime


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    url: str
    created_at: datetime


class CardEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    actor_name: str
    action: str
    data: dict[str, Any]
    created_at: datetime


class CardDetail(CardOut):
    checklists: list[ChecklistOut]
    comments: list[CommentOut]
    attachments: list[AttachmentOut]


class ChecklistCreate(BaseModel):
    title: Annotated[str, Field(min_length=1, max_length=200)]


class ChecklistUpdate(BaseModel):
    title: Annotated[str, Field(min_length=1, max_length=200)]


class ChecklistItemCreate(BaseModel):
    text: Annotated[str, Field(min_length=1, max_length=500)]


class ChecklistItemUpdate(BaseModel):
    text: Annotated[str, Field(min_length=1, max_length=500)] | None = None
    done: bool | None = None


class CommentCreate(BaseModel):
    body: Annotated[str, Field(min_length=1, max_length=20000)]


class AttachmentCreate(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=200)]
    url: SafeUrl


class ViewCreate(ViewTemplate):
    pass


class ViewOut(ViewTemplate):
    id: UUID


class TemplateOut(BaseModel):
    id: UUID
    name: str
    description: str
    version: int
    created_at: datetime
    updated_at: datetime
    data: BoardTemplate


class TemplateUpdate(BaseModel):
    name: ProjectName | None = None
    description: LongText | None = None


class TemplateFromBoard(BaseModel):
    board_id: UUID
    name: ProjectName
    include_cards: bool = False


class PresetOut(BaseModel):
    key: str
    data: BoardTemplate


class ValidationProblem(BaseModel):
    path: str
    message: str


class TemplatePreview(BaseModel):
    valid: bool
    name: str | None = None
    errors: list[ValidationProblem] = []
    warnings: list[str] = []
    counts: dict[str, int] = {}


class TemplateApply(BaseModel):
    """Частичный импорт: взять указанные разделы шаблона и наложить на доску."""

    template: dict[str, Any]
    parts: Annotated[list[str], Field(min_length=1, max_length=6)]


class BoardReset(BaseModel):
    cards: bool = False


class SearchHit(BaseModel):
    type: Literal["board", "card"]
    id: UUID
    board_id: UUID
    title: str
    subtitle: str


class TrashItem(BaseModel):
    type: Literal["project", "board", "card", "template"]
    id: UUID
    name: str
    deleted_at: datetime
    purge_at: datetime


class AuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    action: str
    target_type: str
    target_id: str
    meta: dict[str, Any]
    created_at: datetime
