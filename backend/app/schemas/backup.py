"""Формат kanbanly.backup — полный слепок данных пользователя."""

from datetime import date, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.template import BoardConfig, BoardTemplate, Node, SafeUrl

BACKUP_FORMAT = "kanbanly.backup"
ENCRYPTED_FORMAT = "kanbanly.backup.encrypted"
BACKUP_VERSION = 1
BACKUP_SCHEMA_URL = "https://kanbanly.local/schemas/backup.v1.json"


class BackupProfile(Node):
    email: Annotated[str, Field(max_length=254)] = ""
    display_name: Annotated[str, Field(max_length=120)] = ""
    locale: Annotated[str, Field(max_length=8)] = "ru"


class BackupChecklistItem(Node):
    text: Annotated[str, Field(min_length=1, max_length=500)]
    done: bool = False


class BackupChecklist(Node):
    title: Annotated[str, Field(min_length=1, max_length=200)]
    items: Annotated[list[BackupChecklistItem], Field(max_length=1000)] = []


class BackupComment(Node):
    author_name: Annotated[str, Field(max_length=120)] = ""
    body: Annotated[str, Field(min_length=1, max_length=20000)]
    created_at: datetime


class BackupAttachment(Node):
    name: Annotated[str, Field(min_length=1, max_length=200)]
    url: SafeUrl
    created_at: datetime


class BackupCard(Node):
    source_id: UUID
    column: Annotated[str, Field(max_length=64)]
    title: Annotated[str, Field(min_length=1, max_length=500)]
    description: Annotated[str, Field(max_length=200000)] = ""
    position: Annotated[str, Field(pattern=r"^[0-9A-Za-z]{2,128}$")]
    due_date: date | None = None
    completed_at: datetime | None = None
    cover_url: SafeUrl | None = None
    values: Annotated[dict[str, list[str]], Field(max_length=30)] = {}
    fields: Annotated[dict[str, Any], Field(max_length=100)] = {}
    checklists: Annotated[list[BackupChecklist], Field(max_length=100)] = []
    comments: Annotated[list[BackupComment], Field(max_length=5000)] = []
    attachments: Annotated[list[BackupAttachment], Field(max_length=500)] = []
    created_at: datetime
    updated_at: datetime


class BackupBoard(Node):
    source_id: UUID
    project_source_id: UUID
    name: Annotated[str, Field(min_length=1, max_length=200)]
    description: Annotated[str, Field(max_length=200000)] = ""
    is_favorite: bool = False
    source_template: dict[str, Any] | None = None
    config: BoardConfig
    cards: Annotated[list[BackupCard], Field(max_length=50000)] = []
    created_at: datetime
    updated_at: datetime


class BackupProject(Node):
    source_id: UUID
    name: Annotated[str, Field(min_length=1, max_length=200)]
    description: Annotated[str, Field(max_length=200000)] = ""
    created_at: datetime
    updated_at: datetime


class BackupTemplate(Node):
    source_id: UUID
    name: Annotated[str, Field(min_length=1, max_length=200)]
    description: Annotated[str, Field(max_length=200000)] = ""
    data: BoardTemplate
    created_at: datetime
    updated_at: datetime


class BackupData(Node):
    profile: BackupProfile = BackupProfile()
    projects: Annotated[list[BackupProject], Field(max_length=2000)] = []
    boards: Annotated[list[BackupBoard], Field(max_length=10000)] = []
    templates: Annotated[list[BackupTemplate], Field(max_length=5000)] = []


class BackupScope(Node):
    type: Literal["account", "project", "board"] = "account"
    id: UUID | None = None


class BackupDocument(Node):
    schema_: str = Field(default=BACKUP_SCHEMA_URL, alias="$schema", max_length=200)
    format: Literal["kanbanly.backup"] = "kanbanly.backup"
    version: Literal[1] = 1
    exported_at: datetime
    scope: BackupScope = BackupScope()
    data: BackupData
    checksum: Annotated[str, Field(pattern=r"^sha256:[0-9a-f]{64}$")]


class KdfParams(Node):
    algorithm: Literal["scrypt"] = "scrypt"
    n: Annotated[int, Field(ge=2, le=1 << 20)]
    r: Annotated[int, Field(ge=1, le=32)]
    p: Annotated[int, Field(ge=1, le=16)]


class EncryptedBackup(Node):
    format: Literal["kanbanly.backup.encrypted"] = "kanbanly.backup.encrypted"
    version: Literal[1] = 1
    cipher: Literal["AES-256-GCM"] = "AES-256-GCM"
    kdf_params: KdfParams
    salt: Annotated[str, Field(max_length=64)]
    nonce: Annotated[str, Field(max_length=64)]
    ciphertext: Annotated[str, Field(max_length=100_000_000)]


class BackupExportIn(BaseModel):
    scope: Annotated[str, Field(max_length=64)] = "account"
    password: Annotated[str, Field(min_length=8, max_length=256)] | None = None
    gzip: bool = False


class BackupConflict(BaseModel):
    type: Literal["project", "board", "template"]
    name: str


class BackupPreview(BaseModel):
    valid: bool
    encrypted: bool = False
    password_required: bool = False
    exported_at: datetime | None = None
    scope: str | None = None
    counts: dict[str, int] = {}
    conflicts: list[BackupConflict] = []
    warnings: list[str] = []
    errors: list[dict[str, str]] = []


class BackupImportResult(BaseModel):
    mode: Literal["copy", "replace"]
    counts: dict[str, int]
    warnings: list[str]
    snapshot_id: UUID | None = None


class SnapshotOut(BaseModel):
    id: UUID
    filename: str
    reason: str
    size: int
    created_at: datetime


class BackupHistoryItem(BaseModel):
    action: str
    created_at: datetime
    meta: dict[str, Any]


class BackupHistory(BaseModel):
    events: list[BackupHistoryItem]
    snapshots: list[SnapshotOut]
