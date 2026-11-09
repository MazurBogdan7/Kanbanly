"""Общее пространство проекта: теги и документы с версиями и комментариями."""

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import ForeignKey, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, IdMixin, JsonType, PositionType, SoftDeleteMixin, TimestampMixin, utcnow


class ProjectTag(IdMixin, TimestampMixin, Base):
    """Тег проекта: общий для всех карточек и документов проекта."""

    __tablename__ = "project_tags"
    __table_args__ = (UniqueConstraint("project_id", "name"),)

    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(60))
    color: Mapped[str] = mapped_column(String(9))
    position: Mapped[str] = mapped_column(PositionType)


class CardTag(Base):
    __tablename__ = "card_tags"

    card_id: Mapped[UUID] = mapped_column(ForeignKey("cards.id", ondelete="CASCADE"), primary_key=True)
    tag_id: Mapped[UUID] = mapped_column(
        ForeignKey("project_tags.id", ondelete="CASCADE"), primary_key=True, index=True
    )


class Document(IdMixin, TimestampMixin, SoftDeleteMixin, Base):
    """Файл проекта (ТЗ, диздок…). Содержимое — в версиях: новая загрузка не затирает старую."""

    __tablename__ = "documents"

    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), default=None)

    versions: Mapped[list["DocumentVersion"]] = relationship(
        back_populates="document", cascade="all, delete-orphan", order_by="DocumentVersion.number"
    )
    comments: Mapped[list["DocumentComment"]] = relationship(
        back_populates="document", cascade="all, delete-orphan", order_by="DocumentComment.id"
    )


class DocumentVersion(IdMixin, Base):
    __tablename__ = "document_versions"
    __table_args__ = (UniqueConstraint("document_id", "number"),)

    document_id: Mapped[UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    number: Mapped[int] = mapped_column()
    filename: Mapped[str] = mapped_column(String(255))
    # Вид определяется по содержимому файла, а не по заявленному браузером типу.
    kind: Mapped[str] = mapped_column(String(16))
    size: Mapped[int] = mapped_column()
    sha256: Mapped[str] = mapped_column(String(64))
    data: Mapped[bytes] = mapped_column(LargeBinary)
    # Подготовленный безопасный просмотр (HTML для docx/xlsx), чтобы не разбирать файл на каждый показ.
    preview: Mapped[dict[str, Any] | None] = mapped_column(JsonType, default=None)
    uploaded_by: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), default=None
    )
    uploader_name: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    document: Mapped[Document] = relationship(back_populates="versions")


class DocumentTag(Base):
    __tablename__ = "document_tags"

    document_id: Mapped[UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[UUID] = mapped_column(
        ForeignKey("project_tags.id", ondelete="CASCADE"), primary_key=True, index=True
    )


class DocumentComment(IdMixin, TimestampMixin, Base):
    __tablename__ = "document_comments"

    document_id: Mapped[UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), default=None)
    author_name: Mapped[str] = mapped_column(String(120), default="")
    body: Mapped[str] = mapped_column(Text)

    document: Mapped[Document] = relationship(back_populates="comments")


class AppSetting(Base):
    """Настройки сервера, которые меняет администратор (например, открыта ли регистрация)."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JsonType)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)
