"""Конфигурация доски ⇄ таблицы.

apply_config — единственный путь записи структуры: его используют создание из шаблона,
конструктор, частичный импорт и восстановление бэкапа. Сопоставление идёт по локальным ключам.
"""

from typing import Any
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.errors import not_found
from app.models import (
    Board,
    BoardColumn,
    BoardView,
    Card,
    Dimension,
    DimensionValue,
    FieldDefinition,
)
from app.schemas.template import (
    BadgeConfig,
    BoardConfig,
    BoardSettings,
    ColumnTemplate,
    DimensionRole,
    DimensionTemplate,
    DimensionValueTemplate,
    FieldTemplate,
    FilterBarWidget,
    FilterChipsWidget,
    LegendWidget,
    ProgressWidget,
    ViewTemplate,
)
from app.services.fractional import sequence

COLUMN_STYLE_FIELDS = ("color", "icon", "width", "collapsed", "empty_text", "header_style", "card_style")


def _dump(model: Any) -> Any:
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)


async def load_board(db: AsyncSession, board_id: UUID) -> Board:
    statement = (
        select(Board)
        .where(Board.id == board_id)
        .options(
            selectinload(Board.columns),
            selectinload(Board.dimensions).selectinload(Dimension.values),
            selectinload(Board.fields),
            selectinload(Board.views),
        )
        .execution_options(populate_existing=True)
    )
    board = (await db.execute(statement)).scalar_one_or_none()
    if board is None:
        raise not_found()
    return board


def dimension_roles(config: BoardConfig, key: str) -> list[DimensionRole]:
    """Роли вычисляются из раскладки: выключение роли убирает виджет, и наоборот."""
    layout = config.layout
    roles: list[DimensionRole] = []
    if layout.card.accent.source == f"dimension:{key}":
        roles.append("accent")
    if any(badge.dimension == key for badge in layout.card.badges):
        roles.append("badge")
    widgets = layout.header.widgets
    if any(isinstance(w, FilterBarWidget) and key in w.selects for w in widgets):
        roles.append("filter_select")
    if any(isinstance(w, FilterChipsWidget) and w.dimension == key for w in widgets):
        roles.append("filter_chips")
    if any(isinstance(w, ProgressWidget) and w.dimension == key for w in widgets):
        roles.append("progress")
    if layout.board.swimlanes == key:
        roles.append("swimlanes")
    if any(view.group_by == key for view in config.views):
        roles.append("table_group")
    if any(isinstance(w, LegendWidget) and w.dimension == key for w in widgets):
        roles.append("legend")
    return roles


def apply_declared_roles(config: BoardConfig) -> None:
    """Роли, объявленные в шаблоне, разворачиваются в раскладку (если их там ещё нет)."""
    layout = config.layout
    for dimension in config.dimensions:
        present = set(dimension_roles(config, dimension.key))
        for role in dimension.roles:
            if role in present:
                continue
            if role == "accent":
                layout.card.accent.source = f"dimension:{dimension.key}"
            elif role == "badge":
                layout.card.badges.append(BadgeConfig(dimension=dimension.key))
            elif role == "filter_select":
                bar = next((w for w in layout.header.widgets if isinstance(w, FilterBarWidget)), None)
                if bar is None:
                    bar = FilterBarWidget(type="filter_bar")
                    layout.header.widgets.append(bar)
                bar.selects.append(dimension.key)
            elif role == "filter_chips":
                layout.header.widgets.append(FilterChipsWidget(type="filter_chips", dimension=dimension.key))
            elif role == "progress":
                layout.header.widgets.append(
                    ProgressWidget(type="progress_by_dimension", dimension=dimension.key)
                )
            elif role == "swimlanes":
                layout.board.swimlanes = dimension.key
            elif role == "legend":
                layout.header.widgets.append(LegendWidget(type="legend", dimension=dimension.key))
            elif role == "table_group":
                config.views.append(
                    ViewTemplate(
                        key=f"table-{dimension.key}",
                        name=f"Таблица: {dimension.name}",
                        type="table",
                        group_by=dimension.key,
                    )
                )


def export_config(board: Board) -> BoardConfig:
    settings = BoardSettings.model_validate(board.settings or {})
    config = BoardConfig(
        theme=settings.theme,
        typography=settings.typography,
        layout=settings.layout,
        rules=settings.rules,
        columns=[_export_column(column) for column in board.columns],
        dimensions=[_export_dimension(dimension) for dimension in board.dimensions],
        fields=[_export_field(field) for field in board.fields],
        views=[_export_view(view) for view in board.views],
    )
    for dimension in config.dimensions:
        dimension.roles = dimension_roles(config, dimension.key)
    return config


def _export_column(column: BoardColumn) -> ColumnTemplate:
    return ColumnTemplate.model_validate(
        {
            "key": column.key,
            "name": column.name,
            "kind": column.kind,
            "wip_limit": column.wip_limit,
            **(column.style or {}),
        }
    )


def _export_dimension(dimension: Dimension) -> DimensionTemplate:
    return DimensionTemplate(
        key=dimension.key,
        name=dimension.name,
        type=dimension.type,
        required=dimension.required,
        default=dimension.default_key,
        empty_value=dimension.empty_key,
        hide_empty=dimension.hide_empty,
        values=[
            DimensionValueTemplate.model_validate(
                {
                    "key": value.key,
                    "name": value.name,
                    "short": value.short,
                    "hint": value.hint,
                    "color": value.color,
                    "icon": value.icon,
                    "badge": value.badge,
                }
            )
            for value in dimension.values
        ],
    )


def _export_field(field: FieldDefinition) -> FieldTemplate:
    return FieldTemplate.model_validate(
        {
            "key": field.key,
            "name": field.name,
            "type": field.type,
            "required": field.required,
            "default": field.default,
            "validation": field.validation or None,
            "show_on_face": field.show_on_face,
            "format": field.format,
        }
    )


def _export_view(view: BoardView) -> ViewTemplate:
    return ViewTemplate.model_validate(
        {
            "key": view.key,
            "name": view.name,
            "type": view.type,
            "filters": view.filters,
            "sort": view.sort,
            "group_by": view.group_by,
            "is_default": view.is_default,
        }
    )


async def apply_config(db: AsyncSession, board: Board, config: BoardConfig) -> list[str]:
    """Приводит таблицы доски к конфигурации. Возвращает предупреждения для пользователя."""
    apply_declared_roles(config)
    board.settings = _dump(
        BoardSettings(
            theme=config.theme, typography=config.typography, layout=config.layout, rules=config.rules
        )
    )
    warnings = await _sync_columns(db, board, config.columns)
    await _sync_dimensions(board, config.dimensions)
    _sync_fields(board, config.fields)
    _sync_views(board, config.views)
    await db.flush()
    return warnings


async def _sync_columns(db: AsyncSession, board: Board, columns: list[ColumnTemplate]) -> list[str]:
    warnings: list[str] = []
    existing = {column.key: column for column in board.columns}
    positions = sequence(len(columns))
    keep: list[BoardColumn] = []
    for template, position in zip(columns, positions, strict=True):
        row = existing.pop(template.key, None) or BoardColumn(key=template.key, position=position)
        row.name = template.name
        row.kind = template.kind
        row.position = position
        row.wip_limit = template.wip_limit
        row.style = _dump(template.model_copy(update={"wip_limit": None}))
        for field in ("key", "name", "kind"):
            row.style.pop(field, None)
        row.style = {k: v for k, v in row.style.items() if k in COLUMN_STYLE_FIELDS and v is not False}
        keep.append(row)
    # Сначала новые строки и перенос карточек, иначе delete-orphan снимет колонку с карточками.
    board.columns[:] = keep + list(existing.values())
    await db.flush()
    if existing:
        fallback = keep[0]
        for removed in existing.values():
            result = await db.execute(
                update(Card).where(Card.column_id == removed.id).values(column_id=fallback.id)
            )
            moved = int(result.rowcount)  # type: ignore[attr-defined]
            if moved:
                warnings.append(
                    f"Карточки из колонки «{removed.name}» перенесены в «{fallback.name}»: {moved}"
                )
    board.columns[:] = keep
    await db.flush()
    return warnings


async def _sync_dimensions(board: Board, dimensions: list[DimensionTemplate]) -> None:
    existing = {dimension.key: dimension for dimension in board.dimensions}
    keep: list[Dimension] = []
    for template, position in zip(dimensions, sequence(len(dimensions)), strict=True):
        row = existing.pop(template.key, None) or Dimension(key=template.key, position=position, values=[])
        row.name = template.name
        row.type = template.type
        row.required = template.required
        row.default_key = template.default
        row.empty_key = template.empty_value
        row.hide_empty = template.hide_empty
        row.position = position
        _sync_values(row, template.values)
        keep.append(row)
    board.dimensions[:] = keep


def _sync_values(dimension: Dimension, values: list[DimensionValueTemplate]) -> None:
    existing = {value.key: value for value in dimension.values}
    keep: list[DimensionValue] = []
    for template, position in zip(values, sequence(len(values)), strict=True):
        row = existing.pop(template.key, None) or DimensionValue(key=template.key, position=position)
        row.name = template.name
        row.short = template.short
        row.hint = template.hint
        row.color = template.color
        row.icon = template.icon
        row.badge = _dump(template.badge) if template.badge else None
        row.position = position
        keep.append(row)
    dimension.values[:] = keep


def _sync_fields(board: Board, fields: list[FieldTemplate]) -> None:
    existing = {field.key: field for field in board.fields}
    keep: list[FieldDefinition] = []
    for template, position in zip(fields, sequence(len(fields)), strict=True):
        row = existing.pop(template.key, None) or FieldDefinition(key=template.key, position=position)
        row.name = template.name
        row.type = template.type
        row.required = template.required
        row.default = template.default
        row.validation = _dump(template.validation) if template.validation else {}
        row.show_on_face = template.show_on_face
        row.format = template.format
        row.position = position
        keep.append(row)
    board.fields[:] = keep


def _sync_views(board: Board, views: list[ViewTemplate]) -> None:
    existing = {view.key: view for view in board.views}
    keep: list[BoardView] = []
    for template, position in zip(views, sequence(len(views)), strict=True):
        row = existing.pop(template.key, None) or BoardView(key=template.key, position=position)
        row.name = template.name
        row.type = template.type
        row.filters = _dump(template.filters)
        row.sort = _dump(template.sort) if template.sort else None
        row.group_by = template.group_by
        row.is_default = template.is_default
        row.position = position
        keep.append(row)
    board.views[:] = keep
