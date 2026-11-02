"""Шаблон ⇄ доска: создание из шаблона, экспорт, частичное наложение."""

from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.models import (
    Board,
    Card,
    Checklist,
    ChecklistItem,
    Project,
)
from app.schemas.template import (
    TEMPLATE_PARTS,
    BoardConfig,
    BoardTemplate,
    ColumnTemplate,
    SampleCard,
    SampleChecklist,
    SampleChecklistItem,
    TemplateMeta,
)
from app.services import cards as card_service
from app.services.board_config import apply_config, export_config, load_board
from app.services.cards import BoardIndex, build_index
from app.services.fractional import sequence

CONFIG_KEYS = ("theme", "typography", "layout", "columns", "dimensions", "fields", "rules", "views")


def config_of(template: BoardTemplate) -> BoardConfig:
    return BoardConfig.model_validate(template.model_dump(by_alias=True, include=set(CONFIG_KEYS)))


def blank_template(name: str) -> BoardTemplate:
    return BoardTemplate(
        meta=TemplateMeta(name=name),
        columns=[
            ColumnTemplate(key="todo", name="К работе", kind="todo"),
            ColumnTemplate(key="doing", name="В работе", kind="in_progress"),
            ColumnTemplate(key="done", name="Готово", kind="done"),
        ],
    )


async def create_board(
    db: AsyncSession,
    project: Project,
    name: str,
    template: BoardTemplate,
    *,
    description: str = "",
    include_samples: bool = True,
    user_id: UUID | None = None,
) -> tuple[Board, list[str]]:
    board = Board(
        project_id=project.id,
        name=name,
        description=description,
        settings={},
        columns=[],
        dimensions=[],
        fields=[],
        views=[],
        source_template=template.model_dump(mode="json", by_alias=True, exclude_none=True),
    )
    db.add(board)
    await db.flush()
    warnings = await apply_config(db, board, config_of(template))
    board = await load_board(db, board.id)
    if include_samples and template.sample_cards:
        await create_sample_cards(db, board, build_index(board), template.sample_cards, user_id)
    return board, warnings


async def create_sample_cards(
    db: AsyncSession,
    board: Board,
    index: BoardIndex,
    samples: list[SampleCard],
    user_id: UUID | None,
) -> None:
    per_column: dict[str, list[SampleCard]] = {}
    for sample in samples:
        per_column.setdefault(sample.column, []).append(sample)
    for column_key, column_samples in per_column.items():
        column = index.columns_by_key[column_key]
        start = await card_service.last_position(db, board.id, column.id)
        for sample, position in zip(column_samples, sequence(len(column_samples), start), strict=True):
            card = Card(
                board_id=board.id,
                column_id=column.id,
                title=sample.title,
                description=sample.description,
                position=position,
                due_date=sample.due_date,
                cover_url=sample.cover_url,
                created_by=user_id,
                dimension_values=[],
                field_values=[],
                checklists=[],
            )
            card_service.set_values(card, index, card_service.apply_defaults(card, index, sample.values))
            card_service.set_fields(card, index, sample.fields)
            for checklist, key in zip(sample.checklists, sequence(len(sample.checklists)), strict=True):
                card.checklists.append(
                    Checklist(
                        title=checklist.title,
                        position=key,
                        items=[
                            ChecklistItem(text=item.text, done=item.done, position=item_key)
                            for item, item_key in zip(
                                checklist.items, sequence(len(checklist.items)), strict=True
                            )
                        ],
                    )
                )
            db.add(card)
    await db.flush()


async def board_cards(db: AsyncSession, board_id: UUID) -> list[Card]:
    statement = (
        card_service.card_query()
        .where(Card.board_id == board_id, Card.deleted_at.is_(None))
        .order_by(Card.position, Card.id)
    )
    result = await db.execute(statement)
    return list(result.scalars().all())


def export_samples(board: Board, cards: list[Card], index: BoardIndex) -> list[SampleCard]:
    ordered = sorted(
        cards,
        key=lambda c: (
            [c.key for c in board.columns].index(index.columns_by_id[c.column_id].key),
            c.position,
        ),
    )
    samples = []
    for number, card in enumerate(ordered, start=1):
        data = card_service.serialize(card, index)
        values: dict[str, str | list[str]] = {
            key: keys if index.dimensions_by_key[key].type == "multi_select" else keys[0]
            for key, keys in data.values.items()
            if keys
        }
        samples.append(
            SampleCard(
                key=f"c{number}",
                column=data.column,
                title=card.title,
                description=card.description,
                values=values,
                fields=data.fields,
                due_date=card.due_date,
                cover_url=card.cover_url,
                checklists=[
                    SampleChecklist(
                        title=c.title,
                        items=[SampleChecklistItem(text=i.text, done=i.done) for i in c.items],
                    )
                    for c in card.checklists
                ],
            )
        )
    return samples


async def export_template(
    db: AsyncSession, board: Board, *, include_cards: bool = False, author: str = ""
) -> BoardTemplate:
    config = export_config(board)
    samples: list[SampleCard] = []
    if include_cards:
        samples = export_samples(board, await board_cards(db, board.id), build_index(board))
    return BoardTemplate(
        meta=TemplateMeta(name=board.name, description=board.description[:2000], author=author),
        sample_cards=samples,
        **{key: getattr(config, key) for key in CONFIG_KEYS},
    )


def keep_parts(document: dict[str, Any], part: str) -> dict[str, Any]:
    """Частичный экспорт: остальные разделы заменяются пустыми значениями формата."""
    if part not in TEMPLATE_PARTS:
        raise ApiError(422, "unknown_part", f"Неизвестный раздел шаблона: {part}")
    keep = set(TEMPLATE_PARTS[part])
    result = {k: v for k, v in document.items() if k not in CONFIG_KEYS and k != "sample_cards"}
    for key in CONFIG_KEYS:
        if key in keep:
            result[key] = document[key]
    # Файл должен оставаться валидным шаблоном: раскладка ссылается на структуру.
    needed = ("columns", "dimensions", "fields") if part == "layout" else ("columns",)
    for key in needed:
        result.setdefault(key, document[key])
    return result


def template_counts(template: BoardTemplate) -> dict[str, int]:
    return {
        "columns": len(template.columns),
        "dimensions": len(template.dimensions),
        "dimension_values": sum(len(d.values) for d in template.dimensions),
        "fields": len(template.fields),
        "rules": len(template.rules),
        "views": len(template.views),
        "cards": len(template.sample_cards),
    }


def overlay(config: BoardConfig, template: BoardTemplate, parts: list[str]) -> BoardConfig:
    """Новая конфигурация: разделы parts — из шаблона, остальное — как было."""
    data: dict[str, Any] = {key: getattr(config, key) for key in CONFIG_KEYS}
    for part in parts:
        if part not in TEMPLATE_PARTS:
            raise ApiError(422, "unknown_part", f"Неизвестный раздел шаблона: {part}")
        for key in TEMPLATE_PARTS[part]:
            data[key] = getattr(template, key)
    if {"structure", "dimensions", "columns"} & set(parts) and "layout" not in parts:
        # Новая структура может не содержать измерений, на которые ссылается раскладка.
        data["layout"] = _prune_layout(data["layout"], data["dimensions"], data["fields"], data["columns"])
        data["views"] = [v for v in data["views"] if _view_ok(v, data["dimensions"])]
    # Токены чужой темы могли исчезнуть: проверка при валидации даст понятную ошибку.
    try:
        return BoardConfig.model_validate(
            {
                key: value.model_dump(by_alias=True)
                if hasattr(value, "model_dump")
                else [item.model_dump(by_alias=True) for item in value]
                for key, value in data.items()
            }
        )
    except ValueError as exc:
        raise ApiError(422, "incompatible_parts", f"Разделы несовместимы: {exc}") from exc


def _view_ok(view: Any, dimensions: list[Any]) -> bool:
    return view.group_by is None or any(d.key == view.group_by for d in dimensions)


def _prune_layout(layout: Any, dimensions: list[Any], fields: list[Any], columns: list[Any]) -> Any:
    keys = {d.key for d in dimensions}
    column_keys = {c.key for c in columns}
    result = layout.model_copy(deep=True)
    kept = []
    for widget in result.header.widgets:
        dimension = getattr(widget, "dimension", None)
        if dimension is not None and dimension not in keys:
            continue
        if getattr(widget, "type", "") == "filter_bar":
            widget.selects = [key for key in widget.selects if key in keys]
        rule = getattr(widget, "done_rule", "")
        if rule.startswith("column:") and rule.removeprefix("column:") not in column_keys:
            widget.done_rule = "column_kind:done"
        kept.append(widget)
    result.header.widgets = kept
    result.card.badges = [b for b in result.card.badges if b.dimension in keys]
    source = result.card.accent.source
    field_keys = {f.key for f in fields}
    if (source.startswith("dimension:") and source.removeprefix("dimension:") not in keys) or (
        source.startswith("field:") and source.removeprefix("field:") not in field_keys
    ):
        result.card.accent.source = "none"
    if result.board.swimlanes not in keys:
        result.board.swimlanes = None
    return result
