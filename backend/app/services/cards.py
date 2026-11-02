"""Карточки: значения измерений и полей, порядок, правила, история."""

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.db import utcnow
from app.core.errors import ApiError, not_found
from app.models import (
    Attachment,
    Board,
    BoardColumn,
    Card,
    CardDimensionValue,
    CardEvent,
    CardFieldValue,
    Checklist,
    Comment,
    Dimension,
    FieldDefinition,
)
from app.schemas.api import CardCreate, CardDetail, CardMove, CardOut, CardUpdate
from app.services.fractional import key_between

MAX_FIELD_TEXT = 20000


@dataclass(slots=True)
class BoardIndex:
    """Сопоставление локальных ключей и строк одной доски."""

    columns_by_key: dict[str, BoardColumn] = field(default_factory=dict)
    columns_by_id: dict[UUID, BoardColumn] = field(default_factory=dict)
    dimensions_by_key: dict[str, Dimension] = field(default_factory=dict)
    dimensions_by_id: dict[UUID, Dimension] = field(default_factory=dict)
    fields_by_key: dict[str, FieldDefinition] = field(default_factory=dict)
    fields_by_id: dict[UUID, FieldDefinition] = field(default_factory=dict)
    value_rank: dict[UUID, tuple[int, str]] = field(default_factory=dict)


def build_index(board: Board) -> BoardIndex:
    index = BoardIndex()
    for column in board.columns:
        index.columns_by_key[column.key] = column
        index.columns_by_id[column.id] = column
    for dimension in board.dimensions:
        index.dimensions_by_key[dimension.key] = dimension
        index.dimensions_by_id[dimension.id] = dimension
        for rank, value in enumerate(dimension.values):
            index.value_rank[value.id] = (rank, value.key)
    for definition in board.fields:
        index.fields_by_key[definition.key] = definition
        index.fields_by_id[definition.id] = definition
    return index


def card_query() -> Any:
    return select(Card).options(
        selectinload(Card.dimension_values),
        selectinload(Card.field_values),
        selectinload(Card.checklists).selectinload(Checklist.items),
    )


async def attachment_counts(
    db: AsyncSession, card_ids: list[UUID]
) -> tuple[dict[UUID, int], dict[UUID, int]]:
    if not card_ids:
        return {}, {}
    comments = await db.execute(
        select(Comment.card_id, func.count()).where(Comment.card_id.in_(card_ids)).group_by(Comment.card_id)
    )
    attachments = await db.execute(
        select(Attachment.card_id, func.count())
        .where(Attachment.card_id.in_(card_ids))
        .group_by(Attachment.card_id)
    )
    return {row[0]: row[1] for row in comments}, {row[0]: row[1] for row in attachments}


def serialize(card: Card, index: BoardIndex, comments: int = 0, attachments: int = 0) -> CardOut:
    values: dict[str, list[tuple[int, str]]] = {}
    for link in card.dimension_values:
        dimension = index.dimensions_by_id.get(link.dimension_id)
        rank = index.value_rank.get(link.value_id)
        if dimension is not None and rank is not None:
            values.setdefault(dimension.key, []).append(rank)
    items = [item for checklist in card.checklists for item in checklist.items]
    return CardOut(
        id=card.id,
        board_id=card.board_id,
        column=index.columns_by_id[card.column_id].key,
        title=card.title,
        description=card.description,
        position=card.position,
        version=card.version,
        due_date=card.due_date,
        completed_at=card.completed_at,
        cover_url=card.cover_url,
        values={key: [k for _, k in sorted(ranks)] for key, ranks in values.items()},
        fields={
            index.fields_by_id[row.field_id].key: row.value
            for row in card.field_values
            if row.field_id in index.fields_by_id
        },
        checklist_done=sum(1 for item in items if item.done),
        checklist_total=len(items),
        comments_count=comments,
        attachments_count=attachments,
        created_at=card.created_at,
        updated_at=card.updated_at,
    )


async def serialize_many(db: AsyncSession, cards: list[Card], index: BoardIndex) -> list[CardOut]:
    comments, attachments = await attachment_counts(db, [card.id for card in cards])
    return [serialize(c, index, comments.get(c.id, 0), attachments.get(c.id, 0)) for c in cards]


async def load_card(db: AsyncSession, card_id: UUID) -> Card:
    statement = card_query().where(Card.id == card_id).execution_options(populate_existing=True)
    card: Card | None = (await db.execute(statement)).scalar_one_or_none()
    if card is None:
        raise not_found()
    return card


async def detail(db: AsyncSession, card_id: UUID, index: BoardIndex) -> CardDetail:
    statement = (
        card_query()
        .where(Card.id == card_id)
        .options(selectinload(Card.comments), selectinload(Card.attachments))
        .execution_options(populate_existing=True)
    )
    card: Card = (await db.execute(statement)).scalar_one()
    base = serialize(card, index, len(card.comments), len(card.attachments))
    return CardDetail(
        **base.model_dump(),
        checklists=card.checklists,
        comments=sorted(card.comments, key=lambda c: c.id),
        attachments=sorted(card.attachments, key=lambda a: a.id),
    )


def record(db: AsyncSession, card: Card, actor_id: UUID | None, actor: str, action: str, **data: Any) -> None:
    db.add(CardEvent(card_id=card.id, actor_id=actor_id, actor_name=actor, action=action, data=data))


def _as_list(value: str | list[str]) -> list[str]:
    return [value] if isinstance(value, str) else list(value)


def set_values(card: Card, index: BoardIndex, values: dict[str, str | list[str]]) -> None:
    """Заменяет значения только у перечисленных измерений."""
    for dimension_key, selection in values.items():
        dimension = index.dimensions_by_key.get(dimension_key)
        if dimension is None:
            raise ApiError(422, "unknown_dimension", f"Измерение «{dimension_key}» не найдено")
        keys = list(dict.fromkeys(_as_list(selection)))
        if len(keys) > 1 and dimension.type != "multi_select":
            raise ApiError(422, "single_value_only", f"«{dimension.name}» допускает одно значение")
        by_key = {value.key: value for value in dimension.values}
        unknown = [key for key in keys if key not in by_key]
        if unknown:
            raise ApiError(422, "unknown_value", f"Значение «{unknown[0]}» не найдено в «{dimension.name}»")
        card.dimension_values[:] = [
            link for link in card.dimension_values if link.dimension_id != dimension.id
        ]
        card.dimension_values.extend(
            CardDimensionValue(value_id=by_key[key].id, dimension_id=dimension.id) for key in keys
        )


def apply_defaults(
    card: Card, index: BoardIndex, values: dict[str, str | list[str]]
) -> dict[str, str | list[str]]:
    merged: dict[str, str | list[str]] = dict(values)
    for dimension in index.dimensions_by_key.values():
        if dimension.key not in merged and dimension.default_key:
            merged[dimension.key] = dimension.default_key
    return merged


def validate_field(definition: FieldDefinition, value: Any) -> None:
    rules = definition.validation or {}

    def fail(message: str) -> ApiError:
        return ApiError(422, "invalid_field", f"{definition.name}: {message}")

    kind = definition.type
    if value is None:
        if definition.required:
            raise fail("обязательное поле")
        return
    if kind in {"text", "long_text"}:
        if not isinstance(value, str) or len(value) > rules.get("max_length", MAX_FIELD_TEXT):
            raise fail("слишком длинный текст")
        regex = rules.get("regex")
        if regex and not re.fullmatch(regex, value):
            raise fail("значение не соответствует формату")
    elif kind in {"number", "rating", "progress"}:
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise fail("ожидается число")
        low = rules.get("min", 0 if kind in {"rating", "progress"} else None)
        high = rules.get("max", {"rating": 5, "progress": 100}.get(kind))
        if low is not None and value < low:
            raise fail(f"минимум {low}")
        if high is not None and value > high:
            raise fail(f"максимум {high}")
    elif kind == "checkbox":
        if not isinstance(value, bool):
            raise fail("ожидается да/нет")
    elif kind == "date":
        _parse_date(value, fail)
    elif kind == "date_range":
        if not isinstance(value, dict) or not {"start", "end"} <= set(value):
            raise fail("ожидается диапазон дат")
        if _parse_date(value["start"], fail) > _parse_date(value["end"], fail):
            raise fail("начало позже конца")
    elif kind in {"url", "attachment_link"}:
        target = value.get("url") if kind == "attachment_link" and isinstance(value, dict) else value
        if not _is_http_url(target):
            raise fail("разрешены ссылки http(s)")
    elif kind == "checklist" and not (
        isinstance(value, list) and all(isinstance(i, dict) and isinstance(i.get("text"), str) for i in value)
    ):
        raise fail("ожидается список пунктов")


def _parse_date(value: Any, fail: Any) -> date:
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise fail("ожидается дата") from exc


def _is_http_url(value: Any) -> bool:
    if not isinstance(value, str) or len(value) > 2000:
        return False
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def set_fields(card: Card, index: BoardIndex, fields: dict[str, Any]) -> None:
    for key, value in fields.items():
        definition = index.fields_by_key.get(key)
        if definition is None:
            raise ApiError(422, "unknown_field", f"Поле «{key}» не найдено")
        validate_field(definition, value)
        current = next((row for row in card.field_values if row.field_id == definition.id), None)
        if value is None:
            if current is not None:
                card.field_values.remove(current)
        elif current is not None:
            current.value = value
        else:
            card.field_values.append(CardFieldValue(field_id=definition.id, value=value))


async def _position_key(db: AsyncSession, card_id: UUID) -> str:
    return (await db.execute(select(Card.position).where(Card.id == card_id))).scalar_one()


async def last_position(db: AsyncSession, board_id: UUID, column_id: UUID) -> str | None:
    result = await db.execute(
        select(Card.position)
        .where(Card.board_id == board_id, Card.column_id == column_id, Card.deleted_at.is_(None))
        .order_by(Card.position.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def first_position(db: AsyncSession, board_id: UUID, column_id: UUID) -> str | None:
    result = await db.execute(
        select(Card.position)
        .where(Card.board_id == board_id, Card.column_id == column_id, Card.deleted_at.is_(None))
        .order_by(Card.position.asc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _neighbour(db: AsyncSession, board_id: UUID, column_id: UUID, card_id: UUID) -> str:
    result = await db.execute(
        select(Card.position).where(
            Card.id == card_id,
            Card.board_id == board_id,
            Card.column_id == column_id,
            Card.deleted_at.is_(None),
        )
    )
    position = result.scalar_one_or_none()
    if position is None:
        raise ApiError(409, "stale_position", "Порядок карточек изменился. Обновите доску.")
    return position


def active_rules(board: Board) -> list[dict[str, Any]]:
    rules: list[dict[str, Any]] = (board.settings or {}).get("rules", [])
    return [rule for rule in rules if rule.get("enabled", True)]


def apply_move_rules(card: Card, board: Board, column: BoardColumn) -> None:
    for rule in active_rules(board):
        if rule.get("type") == "set_completed_on_kind":
            if column.kind == rule.get("column_kind", "done"):
                card.completed_at = card.completed_at or utcnow()
            else:
                card.completed_at = None


async def create(
    db: AsyncSession, board: Board, index: BoardIndex, payload: CardCreate, user_id: UUID, actor: str
) -> Card:
    column = index.columns_by_key.get(payload.column)
    if column is None:
        raise ApiError(422, "unknown_column", "Колонка не найдена")
    if payload.after_id is not None:
        before = await _neighbour(db, board.id, column.id, payload.after_id)
        following = await db.execute(
            select(Card.position)
            .where(
                Card.board_id == board.id,
                Card.column_id == column.id,
                Card.deleted_at.is_(None),
                Card.position > before,
            )
            .order_by(Card.position.asc())
            .limit(1)
        )
        position = key_between(before, following.scalar_one_or_none())
    else:
        position = key_between(await last_position(db, board.id, column.id), None)
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=payload.title,
        description=payload.description,
        position=position,
        due_date=payload.due_date,
        cover_url=payload.cover_url,
        created_by=user_id,
        dimension_values=[],
        field_values=[],
        checklists=[],
    )
    set_values(card, index, apply_defaults(card, index, payload.values))
    fields = {d.key: d.default for d in index.fields_by_key.values() if d.default is not None}
    set_fields(card, index, {**fields, **payload.fields})
    apply_move_rules(card, board, column)
    db.add(card)
    await db.flush()
    record(db, card, user_id, actor, "created", title=card.title)
    return card


def update(card: Card, board: Board, index: BoardIndex, payload: CardUpdate) -> list[str]:
    data = payload.model_dump(exclude_unset=True)
    changed: list[str] = []
    for name in ("title", "description", "due_date", "cover_url"):
        if name in data and getattr(card, name) != data[name]:
            setattr(card, name, data[name])
            changed.append(name)
    if "values" in data and data["values"] is not None:
        set_values(card, index, data["values"])
        changed.append("values")
    if "fields" in data and data["fields"] is not None:
        set_fields(card, index, data["fields"])
        changed.append("fields")
    return changed


async def move(
    db: AsyncSession, board: Board, index: BoardIndex, card: Card, payload: CardMove
) -> tuple[str, str]:
    column = index.columns_by_key.get(payload.column)
    if column is None:
        raise ApiError(422, "unknown_column", "Колонка не найдена")
    source = index.columns_by_id[card.column_id]
    if card.id in {payload.before_id, payload.after_id}:
        raise ApiError(422, "invalid_move", "Карточка не может быть соседом самой себе")
    if payload.before_id is None and payload.after_id is None:
        low = await last_position(db, board.id, column.id)
        high = None
    else:
        low = await _neighbour(db, board.id, column.id, payload.before_id) if payload.before_id else None
        high = await _neighbour(db, board.id, column.id, payload.after_id) if payload.after_id else None
    if low is not None and high is not None and low >= high:
        raise ApiError(409, "stale_position", "Порядок карточек изменился. Обновите доску.")
    card.position = key_between(low, high)
    card.column_id = column.id
    apply_move_rules(card, board, column)
    return source.key, column.key
