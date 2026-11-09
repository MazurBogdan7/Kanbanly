from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import ForeignKey, Index, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import (
    Base,
    IdMixin,
    JsonType,
    PositionType,
    SoftDeleteMixin,
    TimestampMixin,
    VersionMixin,
    utcnow,
)
from app.models.workspace import CardTag


class Project(IdMixin, TimestampMixin, SoftDeleteMixin, VersionMixin, Base):
    __tablename__ = "projects"

    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")

    members: Mapped[list["ProjectMember"]] = relationship(back_populates="project", cascade="all, delete")
    boards: Mapped[list["Board"]] = relationship(back_populates="project", cascade="all, delete")


class ProjectMember(IdMixin, TimestampMixin, Base):
    """Роли проекта. Владелец тоже хранится здесь — единый источник прав."""

    __tablename__ = "project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id"),)

    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16))

    project: Mapped[Project] = relationship(back_populates="members")


class ProjectInvite(IdMixin, TimestampMixin, Base):
    """Приглашение в проект. Ссылку может принять только владелец указанного email."""

    __tablename__ = "project_invites"

    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    email: Mapped[str] = mapped_column(String(254))
    role: Mapped[str] = mapped_column(String(16))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column()
    accepted_at: Mapped[datetime | None] = mapped_column(default=None)
    invited_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), default=None)


class Board(IdMixin, TimestampMixin, SoftDeleteMixin, VersionMixin, Base):
    __tablename__ = "boards"

    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    is_favorite: Mapped[bool] = mapped_column(default=False)
    last_opened_at: Mapped[datetime | None] = mapped_column(default=None)
    # Тема, типографика, раскладка и правила (модель BoardSettings).
    settings: Mapped[dict[str, Any]] = mapped_column(JsonType, default=dict)
    # Шаблон, из которого доска создана, — для «Сбросить к шаблону».
    source_template: Mapped[dict[str, Any] | None] = mapped_column(JsonType, default=None)

    project: Mapped[Project] = relationship(back_populates="boards")
    columns: Mapped[list["BoardColumn"]] = relationship(
        back_populates="board", cascade="all, delete-orphan", order_by="BoardColumn.position"
    )
    dimensions: Mapped[list["Dimension"]] = relationship(
        back_populates="board", cascade="all, delete-orphan", order_by="Dimension.position"
    )
    fields: Mapped[list["FieldDefinition"]] = relationship(
        back_populates="board", cascade="all, delete-orphan", order_by="FieldDefinition.position"
    )
    views: Mapped[list["BoardView"]] = relationship(
        back_populates="board", cascade="all, delete-orphan", order_by="BoardView.position"
    )
    cards: Mapped[list["Card"]] = relationship(back_populates="board", cascade="all, delete-orphan")


class BoardColumn(IdMixin, TimestampMixin, Base):
    __tablename__ = "board_columns"
    __table_args__ = (UniqueConstraint("board_id", "key"),)

    board_id: Mapped[UUID] = mapped_column(ForeignKey("boards.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(16), default="custom")
    position: Mapped[str] = mapped_column(PositionType)
    wip_limit: Mapped[int | None] = mapped_column(default=None)
    # Оформление колонки (цвет, ширина, стиль карточек) — по нему не фильтруют.
    style: Mapped[dict[str, Any]] = mapped_column(JsonType, default=dict)

    board: Mapped[Board] = relationship(back_populates="columns")


class Dimension(IdMixin, TimestampMixin, Base):
    __tablename__ = "dimensions"
    __table_args__ = (UniqueConstraint("board_id", "key"),)

    board_id: Mapped[UUID] = mapped_column(ForeignKey("boards.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(120))
    type: Mapped[str] = mapped_column(String(16), default="select")
    required: Mapped[bool] = mapped_column(default=False)
    default_key: Mapped[str | None] = mapped_column(String(64), default=None)
    empty_key: Mapped[str | None] = mapped_column(String(64), default=None)
    hide_empty: Mapped[bool] = mapped_column(default=False)
    position: Mapped[str] = mapped_column(PositionType)

    board: Mapped[Board] = relationship(back_populates="dimensions")
    values: Mapped[list["DimensionValue"]] = relationship(
        back_populates="dimension", cascade="all, delete-orphan", order_by="DimensionValue.position"
    )


class DimensionValue(IdMixin, TimestampMixin, Base):
    __tablename__ = "dimension_values"
    __table_args__ = (UniqueConstraint("dimension_id", "key"),)

    dimension_id: Mapped[UUID] = mapped_column(ForeignKey("dimensions.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(120))
    short: Mapped[str | None] = mapped_column(String(32), default=None)
    hint: Mapped[str | None] = mapped_column(String(300), default=None)
    color: Mapped[str | None] = mapped_column(String(48), default=None)
    icon: Mapped[str | None] = mapped_column(String(32), default=None)
    badge: Mapped[dict[str, Any] | None] = mapped_column(JsonType, default=None)
    position: Mapped[str] = mapped_column(PositionType)

    dimension: Mapped[Dimension] = relationship(back_populates="values")


class FieldDefinition(IdMixin, TimestampMixin, Base):
    __tablename__ = "field_definitions"
    __table_args__ = (UniqueConstraint("board_id", "key"),)

    board_id: Mapped[UUID] = mapped_column(ForeignKey("boards.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(120))
    type: Mapped[str] = mapped_column(String(24))
    required: Mapped[bool] = mapped_column(default=False)
    default: Mapped[Any] = mapped_column(JsonType, default=None)
    validation: Mapped[dict[str, Any]] = mapped_column(JsonType, default=dict)
    show_on_face: Mapped[bool] = mapped_column(default=False)
    format: Mapped[str | None] = mapped_column(String(32), default=None)
    position: Mapped[str] = mapped_column(PositionType)

    board: Mapped[Board] = relationship(back_populates="fields")


class BoardView(IdMixin, TimestampMixin, Base):
    __tablename__ = "board_views"
    __table_args__ = (UniqueConstraint("board_id", "key"),)

    board_id: Mapped[UUID] = mapped_column(ForeignKey("boards.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(120))
    type: Mapped[str] = mapped_column(String(16), default="kanban")
    filters: Mapped[dict[str, Any]] = mapped_column(JsonType, default=dict)
    sort: Mapped[dict[str, Any] | None] = mapped_column(JsonType, default=None)
    group_by: Mapped[str | None] = mapped_column(String(64), default=None)
    is_default: Mapped[bool] = mapped_column(default=False)
    position: Mapped[str] = mapped_column(PositionType)

    board: Mapped[Board] = relationship(back_populates="views")


class Card(IdMixin, TimestampMixin, SoftDeleteMixin, VersionMixin, Base):
    __tablename__ = "cards"
    __table_args__ = (Index("ix_cards_board_column_position", "board_id", "column_id", "position"),)

    board_id: Mapped[UUID] = mapped_column(ForeignKey("boards.id", ondelete="CASCADE"), index=True)
    # NO ACTION, а не RESTRICT: каскад удаления доски снимает колонки и карточки одним запросом.
    column_id: Mapped[UUID] = mapped_column(ForeignKey("board_columns.id"), index=True)
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str] = mapped_column(Text, default="")
    position: Mapped[str] = mapped_column(PositionType)
    due_date: Mapped[date | None] = mapped_column(default=None)
    completed_at: Mapped[datetime | None] = mapped_column(default=None)
    cover_url: Mapped[str | None] = mapped_column(String(2000), default=None)
    # Цвет карточки (#RRGGBB). Текст на нём подбирается под контраст при рендере.
    color: Mapped[str | None] = mapped_column(String(9), default=None)
    created_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), default=None)

    board: Mapped[Board] = relationship(back_populates="cards")
    column: Mapped[BoardColumn] = relationship()
    dimension_values: Mapped[list["CardDimensionValue"]] = relationship(
        cascade="all, delete-orphan", back_populates="card"
    )
    field_values: Mapped[list["CardFieldValue"]] = relationship(
        cascade="all, delete-orphan", back_populates="card"
    )
    checklists: Mapped[list["Checklist"]] = relationship(
        cascade="all, delete-orphan", back_populates="card", order_by="Checklist.position"
    )
    comments: Mapped[list["Comment"]] = relationship(cascade="all, delete-orphan", back_populates="card")
    tags: Mapped[list["CardTag"]] = relationship(cascade="all, delete-orphan")
    attachments: Mapped[list["Attachment"]] = relationship(
        cascade="all, delete-orphan", back_populates="card"
    )


class CardDimensionValue(Base):
    __tablename__ = "card_dimension_values"

    card_id: Mapped[UUID] = mapped_column(ForeignKey("cards.id", ondelete="CASCADE"), primary_key=True)
    value_id: Mapped[UUID] = mapped_column(
        ForeignKey("dimension_values.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    dimension_id: Mapped[UUID] = mapped_column(ForeignKey("dimensions.id", ondelete="CASCADE"), index=True)

    card: Mapped[Card] = relationship(back_populates="dimension_values")
    value: Mapped[DimensionValue] = relationship()


class CardFieldValue(Base):
    __tablename__ = "card_field_values"

    card_id: Mapped[UUID] = mapped_column(ForeignKey("cards.id", ondelete="CASCADE"), primary_key=True)
    field_id: Mapped[UUID] = mapped_column(
        ForeignKey("field_definitions.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    value: Mapped[Any] = mapped_column(JsonType)

    card: Mapped[Card] = relationship(back_populates="field_values")
    field: Mapped[FieldDefinition] = relationship()


class Checklist(IdMixin, TimestampMixin, Base):
    __tablename__ = "checklists"

    card_id: Mapped[UUID] = mapped_column(ForeignKey("cards.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    position: Mapped[str] = mapped_column(PositionType)

    card: Mapped[Card] = relationship(back_populates="checklists")
    items: Mapped[list["ChecklistItem"]] = relationship(
        cascade="all, delete-orphan", back_populates="checklist", order_by="ChecklistItem.position"
    )


class ChecklistItem(IdMixin, TimestampMixin, Base):
    __tablename__ = "checklist_items"

    checklist_id: Mapped[UUID] = mapped_column(ForeignKey("checklists.id", ondelete="CASCADE"), index=True)
    text: Mapped[str] = mapped_column(String(500))
    done: Mapped[bool] = mapped_column(default=False)
    position: Mapped[str] = mapped_column(PositionType)

    checklist: Mapped[Checklist] = relationship(back_populates="items")


class Comment(IdMixin, TimestampMixin, Base):
    __tablename__ = "comments"

    card_id: Mapped[UUID] = mapped_column(ForeignKey("cards.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), default=None)
    author_name: Mapped[str] = mapped_column(String(120), default="")
    body: Mapped[str] = mapped_column(Text)

    card: Mapped[Card] = relationship(back_populates="comments")


class Attachment(IdMixin, TimestampMixin, Base):
    """Вложения — ссылки; загрузка файлов опциональна по ТЗ и не реализована."""

    __tablename__ = "attachments"

    card_id: Mapped[UUID] = mapped_column(ForeignKey("cards.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    url: Mapped[str] = mapped_column(String(2000))

    card: Mapped[Card] = relationship(back_populates="attachments")


class CardEvent(IdMixin, Base):
    """История изменений карточки."""

    __tablename__ = "card_events"

    card_id: Mapped[UUID] = mapped_column(ForeignKey("cards.id", ondelete="CASCADE"), index=True)
    actor_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), default=None)
    actor_name: Mapped[str] = mapped_column(String(120), default="")
    action: Mapped[str] = mapped_column(String(32))
    data: Mapped[dict[str, Any]] = mapped_column(JsonType, default=dict)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class Template(IdMixin, TimestampMixin, SoftDeleteMixin, VersionMixin, Base):
    __tablename__ = "templates"

    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[dict[str, Any]] = mapped_column(JsonType)


class BackupSnapshot(IdMixin, Base):
    """Автоматический снимок перед заменой данных при восстановлении."""

    __tablename__ = "backup_snapshots"

    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(120))
    reason: Mapped[str] = mapped_column(String(32), default="before_replace")
    size: Mapped[int] = mapped_column(default=0)
    data_gz: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
