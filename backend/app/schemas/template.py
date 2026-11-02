"""Формат kanbanly.board-template — единая правда о настройках доски.

Из этих моделей генерируются JSON Schema (docs/schemas) и TS-типы фронта. Тот же набор
моделей описывает Board.settings и конфигурацию доски в API. Движок рендера работает
с локальными ключами, поэтому шаблон, доска и live-preview конструктора — одна структура.
"""

import re
from datetime import date
from typing import Annotated, Any, Literal, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

TEMPLATE_FORMAT = "kanbanly.board-template"
TEMPLATE_VERSION = 1
TEMPLATE_SCHEMA_URL = "https://kanbanly.local/schemas/board-template.v1.json"

HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
TOKEN_REF_RE = re.compile(r"^\{([a-z][a-z0-9-]{0,39})\}$")
SAFE_URL_RE = re.compile(r"^https://[^\s\"'()<>\\]{1,1900}$")
NESTED_QUANTIFIER_RE = re.compile(r"\([^)]*[+*][^)]*\)[+*{]")

# Белый список: всё, что здесь перечислено, поставляется вместе с приложением.
FONTS: tuple[str, ...] = (
    "Inter",
    "Manrope",
    "IBM Plex Sans",
    "Roboto",
    "Nunito",
    "Space Grotesk",
    "Cormorant SC",
    "Playfair Display",
    "Lora",
    "PT Serif",
    "JetBrains Mono",
    "system-ui",
    "serif",
    "monospace",
)
BASE_TOKENS: tuple[str, ...] = (
    "bg",
    "surface",
    "surface-2",
    "border",
    "border-strong",
    "muted-strong",
    "accent",
    "accent-hover",
    "accent-soft",
    "accent-dim",
    "danger",
    "danger-hover",
    "text",
    "text-muted",
)
DEFAULT_TOKENS: dict[str, str] = {
    "bg": "#F6F7F9",
    "surface": "#FFFFFF",
    "surface-2": "#FFFFFF",
    "border": "#E3E6EB",
    "border-strong": "#C9CFD8",
    "muted-strong": "#6B7280",
    "accent": "#3B5BDB",
    "accent-hover": "#2F4AC0",
    "accent-soft": "#E7ECFF",
    "accent-dim": "#7C8FE0",
    "danger": "#C92A2A",
    "danger-hover": "#A61E1E",
    "text": "#1A1F2B",
    "text-muted": "#5B6472",
}


def _check_color(value: str) -> str:
    if not (HEX_RE.match(value) or TOKEN_REF_RE.match(value)):
        raise ValueError("неверный формат цвета")
    return value


def _check_hex(value: str) -> str:
    if not HEX_RE.match(value):
        raise ValueError("неверный формат цвета")
    return value


def _check_url(value: str) -> str:
    if not SAFE_URL_RE.match(value):
        raise ValueError("разрешены только адреса https://")
    return value


def _check_font(value: str) -> str:
    if value not in FONTS:
        raise ValueError("шрифт не из белого списка")
    return value


def _check_regex(value: str) -> str:
    try:
        re.compile(value)
    except re.error as exc:
        raise ValueError("некорректное регулярное выражение") from exc
    if NESTED_QUANTIFIER_RE.search(value):
        # Защита от катастрофического бэктрекинга на стороне сервера.
        raise ValueError("вложенные квантификаторы запрещены")
    return value


Color = Annotated[
    str,
    Field(
        max_length=48,
        json_schema_extra={"pattern": r"^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|\{[a-z][a-z0-9-]{0,39}\})$"},
    ),
    AfterValidator(_check_color),
]
HexColor = Annotated[
    str,
    Field(max_length=9, json_schema_extra={"pattern": r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$"}),
    AfterValidator(_check_hex),
]
Key = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")]
TokenName = Annotated[str, Field(pattern=r"^[a-z][a-z0-9-]{0,39}$")]
SafeUrl = Annotated[str, Field(max_length=1950), AfterValidator(_check_url)]
FontName = Annotated[str, Field(max_length=40), AfterValidator(_check_font)]
Name = Annotated[str, Field(min_length=1, max_length=120)]
ShortText = Annotated[str, Field(max_length=300)]
Icon = Annotated[str, Field(max_length=32)]


class Node(BaseModel):
    """Лишние поля принимаются и затем вычищаются с предупреждением (§7.3)."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)


# ---------- meta / theme ----------


class TemplateMeta(Node):
    name: Annotated[str, Field(min_length=1, max_length=200)]
    description: Annotated[str, Field(max_length=2000)] = ""
    author: Annotated[str, Field(max_length=120)] = ""
    tags: Annotated[list[Annotated[str, Field(max_length=40)]], Field(max_length=20)] = []


class ColorBackground(Node):
    type: Literal["color"]
    value: Color


class LinearGradientBackground(Node):
    type: Literal["linear-gradient"]
    angle: Annotated[float, Field(ge=0, le=360)] = 180
    stops: Annotated[list[Color], Field(min_length=2, max_length=8)]


class RadialGradientBackground(Node):
    type: Literal["radial-gradient"]
    stops: Annotated[list[Color], Field(min_length=2, max_length=8)]


class ImageBackground(Node):
    type: Literal["image"]
    url: SafeUrl
    overlay: Color = "#000000"
    overlay_opacity: Annotated[float, Field(ge=0, le=1)] = 0.4


Background = Annotated[
    ColorBackground | LinearGradientBackground | RadialGradientBackground | ImageBackground,
    Field(discriminator="type"),
]
ThemeMode = Literal["light", "dark", "both"]
Density = Literal["compact", "comfortable", "spacious"]


class Theme(Node):
    mode: ThemeMode = "light"
    # tokens — основная палитра; alt_tokens — вторая для режима both.
    tokens: Annotated[dict[TokenName, HexColor], Field(max_length=64)] = {}
    alt_tokens: Annotated[dict[TokenName, HexColor], Field(max_length=64)] = {}
    density: Density = "comfortable"
    header_background: Background | None = None
    board_background: Background | None = None
    # Фоны второй палитры (режим both); без них используются основные.
    alt_header_background: Background | None = None
    alt_board_background: Background | None = None


# ---------- типографика ----------

TextCase = Literal["as_is", "upper", "lower", "capitalize"]


class TypeRole(Node):
    font: FontName | None = None
    weight: Annotated[int, Field(ge=100, le=900)] | None = None
    size: Annotated[float, Field(ge=8, le=72)] | None = None
    letter_spacing: Annotated[float, Field(ge=-0.2, le=1)] | None = None
    line_height: Annotated[float, Field(ge=0.8, le=3)] | None = None
    case: TextCase | None = None
    color: Color | None = None
    line_clamp: Annotated[int, Field(ge=1, le=20)] | None = None


class Typography(Node):
    board_title: TypeRole = TypeRole()
    board_subtitle: TypeRole = TypeRole()
    column_title: TypeRole = TypeRole()
    card_title: TypeRole = TypeRole()
    card_body: TypeRole = TypeRole()
    badge: TypeRole = TypeRole()
    base: TypeRole = TypeRole()


# ---------- шапка ----------


class WidgetBase(Node):
    enabled: bool = True


class TitleWidget(WidgetBase):
    type: Literal["title"]


class ActionsWidget(WidgetBase):
    type: Literal["actions"]
    add_card: bool = True
    export: bool = True
    import_: bool = Field(default=True, alias="import")
    reset: bool = True


class ProgressWidget(WidgetBase):
    type: Literal["progress_by_dimension"]
    dimension: Key
    done_rule: Annotated[str, Field(pattern=r"^(column_kind:[a-z_]+|column:[A-Za-z0-9_-]+)$")] = (
        "column_kind:done"
    )
    show_hint: bool = True
    show_counter: bool = True
    bar_color: Color = "{accent}"


class FilterBarWidget(WidgetBase):
    type: Literal["filter_bar"]
    search: bool = True
    selects: Annotated[list[Key], Field(max_length=20)] = []


ChipStyle = Literal["left-border-color", "filled", "dot"]


class FilterChipsWidget(WidgetBase):
    type: Literal["filter_chips"]
    dimension: Key
    multi: bool = True
    chip_style: ChipStyle = "left-border-color"


StatMetric = Literal["total", "in_progress", "overdue", "wip_exceeded"]


class StatsWidget(WidgetBase):
    type: Literal["stats"]
    metrics: Annotated[list[StatMetric], Field(max_length=4)] = ["total", "in_progress"]


class NoteWidget(WidgetBase):
    type: Literal["note"]
    text: Annotated[str, Field(max_length=1000)]


class LegendWidget(WidgetBase):
    type: Literal["legend"]
    dimension: Key


Widget = Annotated[
    TitleWidget
    | ActionsWidget
    | ProgressWidget
    | FilterBarWidget
    | FilterChipsWidget
    | StatsWidget
    | NoteWidget
    | LegendWidget,
    Field(discriminator="type"),
]


class HeaderLayout(Node):
    subtitle: ShortText = ""
    widgets: Annotated[list[Widget], Field(max_length=20)] = []


# ---------- колонки ----------

ColumnHeaderStyle = Literal["flat-with-divider", "pill", "color-bar"]


class ColumnLayout(Node):
    min_width: Annotated[int, Field(ge=120, le=800)] = 280
    fixed_width: Annotated[int, Field(ge=120, le=800)] | None = None
    radius: Annotated[int, Field(ge=0, le=32)] = 10
    header_style: ColumnHeaderStyle = "flat-with-divider"
    show_count: bool = True
    show_wip: bool = True
    collapsible: bool = False
    empty_text: ShortText = "Пусто"


# ---------- карточка ----------

FaceSlot = Literal[
    "title",
    "description",
    "badges",
    "fields",
    "cover",
    "assignees",
    "due_date",
    "checklist_progress",
    "comments_count",
    "custom_text",
]
AccentStyle = Literal["left-border", "top-border", "background-tint", "dot", "full-border"]
BadgeDisplay = Literal["name", "short", "icon", "icon+name"]
BadgeStyle = Literal["per-value", "neutral", "outlined", "filled", "dot"]
BadgeSize = Literal["sm", "md"]
CardShadow = Literal["none", "sm", "md"]
CardHover = Literal["none", "border", "lift", "glow"]


class CardAccent(Node):
    # none | column | dimension:<key> | field:<key>
    source: Annotated[
        str, Field(pattern=r"^(none|column|dimension:[A-Za-z0-9_-]+|field:[A-Za-z0-9_-]+)$")
    ] = "none"
    style: AccentStyle = "left-border"
    width: Annotated[int, Field(ge=1, le=12)] = 3


class BadgeConfig(Node):
    dimension: Key
    display: BadgeDisplay = "name"
    style: BadgeStyle = "neutral"
    radius: Annotated[int, Field(ge=0, le=999)] | None = None
    size: BadgeSize = "sm"
    hide_values: Annotated[list[Annotated[str, Field(max_length=120)]], Field(max_length=50)] = []


class CardLayout(Node):
    radius: Annotated[int, Field(ge=0, le=32)] = 8
    padding: Annotated[list[Annotated[int, Field(ge=0, le=48)]], Field(min_length=2, max_length=2)] = [10, 12]
    gap: Annotated[int, Field(ge=0, le=48)] = 8
    shadow: CardShadow = "none"
    border: bool = True
    hover: CardHover = "border"
    accent: CardAccent = CardAccent()
    face: Annotated[list[FaceSlot], Field(max_length=10)] = ["title", "description", "badges"]
    badges: Annotated[list[BadgeConfig], Field(max_length=20)] = []
    custom_text: ShortText = ""


class EditorLayout(Node):
    type: Literal["modal", "drawer"] = "drawer"
    fields_grid: Literal[1, 2] = 1
    fields: Annotated[list[Annotated[str, Field(max_length=64)]], Field(max_length=120)] = []


class BoardLayout(Node):
    swimlanes: Key | None = None


class Layout(Node):
    header: HeaderLayout = HeaderLayout()
    footer_note: Annotated[str, Field(max_length=1000)] = ""
    board: BoardLayout = BoardLayout()
    column: ColumnLayout = ColumnLayout()
    card: CardLayout = CardLayout()
    editor: EditorLayout = EditorLayout()


# ---------- структура ----------

ColumnKind = Literal["backlog", "todo", "in_progress", "review", "done", "custom"]


class ColumnCardStyle(Node):
    opacity: Annotated[float, Field(ge=0.1, le=1)] | None = None
    title_strikethrough: bool = False
    strikethrough_color: Color | None = None
    mute_badges: bool = False
    # Переопределение стиля акцента карточек этой колонки.
    accent_style: AccentStyle | None = None


class ColumnTemplate(Node):
    key: Key
    name: Name
    kind: ColumnKind = "custom"
    color: Color | None = None
    icon: Icon | None = None
    wip_limit: Annotated[int, Field(ge=1, le=999)] | None = None
    width: Annotated[int, Field(ge=120, le=800)] | None = None
    collapsed: bool = False
    empty_text: ShortText | None = None
    header_style: ColumnHeaderStyle | None = None
    card_style: ColumnCardStyle | None = None


class BadgeStyleOverride(Node):
    bg: Color | None = None
    fg: Color | None = None
    border: Color | None = None


class DimensionValueTemplate(Node):
    key: Key
    name: Name
    short: Annotated[str, Field(max_length=32)] | None = None
    hint: ShortText | None = None
    color: Color | None = None
    icon: Icon | None = None
    badge: BadgeStyleOverride | None = None


DimensionType = Literal["select", "multi_select", "ordered_select", "user"]
DimensionRole = Literal[
    "accent", "badge", "filter_select", "filter_chips", "progress", "swimlanes", "table_group", "legend"
]


class DimensionTemplate(Node):
    key: Key
    name: Name
    type: DimensionType = "select"
    # Сокращение формата: type=select + ordered=true то же, что ordered_select.
    ordered: bool = False
    required: bool = False
    default: Key | None = None
    empty_value: Key | None = None
    hide_empty: bool = False
    roles: Annotated[list[DimensionRole], Field(max_length=8)] = []
    values: Annotated[list[DimensionValueTemplate], Field(max_length=200)] = []

    @model_validator(mode="after")
    def _normalize(self) -> Self:
        if self.ordered and self.type == "select":
            self.type = "ordered_select"
        self.ordered = False
        keys = [value.key for value in self.values]
        _require_unique(keys, "values")
        for ref, name in ((self.default, "default"), (self.empty_value, "empty_value")):
            if ref is not None and ref not in keys:
                raise ValueError(f"{name}: значение «{ref}» не найдено в измерении")
        return self


FieldType = Literal[
    "text",
    "long_text",
    "number",
    "date",
    "date_range",
    "checkbox",
    "url",
    "rating",
    "progress",
    "checklist",
    "attachment_link",
]


class FieldValidation(Node):
    min: float | None = None
    max: float | None = None
    regex: Annotated[str, Field(max_length=200), AfterValidator(_check_regex)] | None = None
    max_length: Annotated[int, Field(ge=1, le=20000)] | None = None


class FieldTemplate(Node):
    key: Key
    name: Name
    type: FieldType
    required: bool = False
    default: Any = None
    validation: FieldValidation | None = None
    show_on_face: bool = False
    format: Annotated[str, Field(max_length=32)] | None = None


class RuleBase(Node):
    key: Key
    enabled: bool = True


class SetCompletedRule(RuleBase):
    """При переносе в колонку данного вида — проставить дату завершения."""

    type: Literal["set_completed_on_kind"]
    column_kind: ColumnKind = "done"


class HighlightWipRule(RuleBase):
    type: Literal["highlight_wip_exceeded"]


class WarnMissingRule(RuleBase):
    type: Literal["warn_missing_required"]


Rule = Annotated[SetCompletedRule | HighlightWipRule | WarnMissingRule, Field(discriminator="type")]
ViewType = Literal["kanban", "table", "calendar", "timeline"]


class ViewFilters(Node):
    search: Annotated[str, Field(max_length=200)] = ""
    dimensions: Annotated[dict[Key, Annotated[list[Key], Field(max_length=200)]], Field(max_length=30)] = {}


class ViewSort(Node):
    # title | due_date | created_at | dimension:<key> | field:<key>
    by: Annotated[str, Field(pattern=r"^(title|due_date|created_at|(dimension|field):[A-Za-z0-9_-]+)$")]
    direction: Literal["asc", "desc"] = "asc"


class ViewTemplate(Node):
    key: Key
    name: Name
    type: ViewType = "kanban"
    filters: ViewFilters = ViewFilters()
    sort: ViewSort | None = None
    group_by: Key | None = None
    is_default: bool = False


FieldScalar = str | float | bool | None


class SampleChecklistItem(Node):
    text: Annotated[str, Field(min_length=1, max_length=500)]
    done: bool = False


class SampleChecklist(Node):
    title: Annotated[str, Field(min_length=1, max_length=200)]
    items: Annotated[list[SampleChecklistItem], Field(max_length=200)] = []


class SampleCard(Node):
    key: Key
    column: Key
    title: Annotated[str, Field(min_length=1, max_length=500)]
    description: Annotated[str, Field(max_length=20000)] = ""
    values: Annotated[dict[Key, Key | list[Key]], Field(max_length=30)] = {}
    fields: Annotated[dict[Key, Any], Field(max_length=100)] = {}
    due_date: date | None = None
    cover_url: SafeUrl | None = None
    checklists: Annotated[list[SampleChecklist], Field(max_length=20)] = []


class BoardConfig(Node):
    """Всё, что настраивается в конструкторе доски (шаблон без meta и карточек)."""

    theme: Theme = Theme()
    typography: Typography = Typography()
    layout: Layout = Layout()
    columns: Annotated[list[ColumnTemplate], Field(min_length=1, max_length=50)]
    dimensions: Annotated[list[DimensionTemplate], Field(max_length=30)] = []
    fields: Annotated[list[FieldTemplate], Field(max_length=100)] = []
    rules: Annotated[list[Rule], Field(max_length=50)] = []
    views: Annotated[list[ViewTemplate], Field(max_length=50)] = []

    @model_validator(mode="after")
    def _check_references(self) -> Self:
        _require_unique([c.key for c in self.columns], "columns")
        _require_unique([d.key for d in self.dimensions], "dimensions")
        _require_unique([f.key for f in self.fields], "fields")
        _require_unique([r.key for r in self.rules], "rules")
        _require_unique([v.key for v in self.views], "views")
        self._check_layout_refs()
        self._check_tokens()
        return self

    def _check_layout_refs(self) -> None:
        dimensions = {d.key for d in self.dimensions}
        columns = {c.key for c in self.columns}
        fields = {f.key for f in self.fields}

        def require(key: str, path: str) -> None:
            if key not in dimensions:
                raise ValueError(f"{path}: измерение «{key}» не найдено")

        for index, widget in enumerate(self.layout.header.widgets):
            path = f"layout.header.widgets[{index}]"
            if isinstance(widget, ProgressWidget | FilterChipsWidget | LegendWidget):
                require(widget.dimension, path)
            if isinstance(widget, FilterBarWidget):
                for key in widget.selects:
                    require(key, path)
            if isinstance(widget, ProgressWidget) and widget.done_rule.startswith("column:"):
                column = widget.done_rule.removeprefix("column:")
                if column not in columns:
                    raise ValueError(f"{path}: колонка «{column}» не найдена")
        for index, badge in enumerate(self.layout.card.badges):
            require(badge.dimension, f"layout.card.badges[{index}]")
        source = self.layout.card.accent.source
        if source.startswith("dimension:"):
            require(source.removeprefix("dimension:"), "layout.card.accent")
        if source.startswith("field:") and source.removeprefix("field:") not in fields:
            raise ValueError("layout.card.accent: поле не найдено")
        if self.layout.board.swimlanes is not None:
            require(self.layout.board.swimlanes, "layout.board.swimlanes")
        for index, view in enumerate(self.views):
            if view.group_by is not None:
                require(view.group_by, f"views[{index}]")

    def _check_tokens(self) -> None:
        known = set(BASE_TOKENS) | set(self.theme.tokens) | set(self.theme.alt_tokens)
        for path, value in iter_strings(self.model_dump(by_alias=True, exclude={"views"})):
            match = TOKEN_REF_RE.match(value)
            if match and match.group(1) not in known and _is_color_path(path):
                raise ValueError(f"{path}: неизвестный токен «{value}»")


class BoardTemplate(BoardConfig):
    schema_: str = Field(default=TEMPLATE_SCHEMA_URL, alias="$schema", max_length=200)
    format: Literal["kanbanly.board-template"] = "kanbanly.board-template"
    version: Literal[1] = 1
    meta: TemplateMeta
    sample_cards: Annotated[list[SampleCard], Field(max_length=5000)] = []

    @model_validator(mode="after")
    def _check_samples(self) -> Self:
        _require_unique([c.key for c in self.sample_cards], "sample_cards")
        columns = {c.key for c in self.columns}
        values = {d.key: {v.key for v in d.values} for d in self.dimensions}
        fields = {f.key for f in self.fields}
        for index, card in enumerate(self.sample_cards):
            path = f"sample_cards[{index}]"
            if card.column not in columns:
                raise ValueError(f"{path}.column: колонка «{card.column}» не найдена")
            for dimension, selected in card.values.items():
                if dimension not in values:
                    raise ValueError(f"{path}.values: измерение «{dimension}» не найдено")
                for key in [selected] if isinstance(selected, str) else selected:
                    if key not in values[dimension]:
                        raise ValueError(f"{path}.values.{dimension}: значение «{key}» не найдено")
            for field in card.fields:
                if field not in fields:
                    raise ValueError(f"{path}.fields: поле «{field}» не найдено")
        return self


class BoardSettings(Node):
    """Содержимое Board.settings: JSONB с версией, остальное — нормальные таблицы."""

    schema_version: Literal[1] = 1
    theme: Theme = Theme()
    typography: Typography = Typography()
    layout: Layout = Layout()
    rules: list[Rule] = []


def _require_unique(keys: list[str], path: str) -> None:
    seen: set[str] = set()
    for key in keys:
        if key in seen:
            raise ValueError(f"{path}: повторяющийся ключ «{key}»")
        seen.add(key)


def _is_color_path(path: str) -> bool:
    leaf = path.rsplit(".", 1)[-1].split("[")[0]
    return leaf in {
        "value",
        "stops",
        "overlay",
        "color",
        "bar_color",
        "strikethrough_color",
        "bg",
        "fg",
        "border",
    }


def iter_strings(value: Any, path: str = "") -> Any:
    if isinstance(value, dict):
        for key, item in value.items():
            yield from iter_strings(item, f"{path}.{key}" if path else str(key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from iter_strings(item, f"{path}[{index}]")
    elif isinstance(value, str):
        yield path, value


TEMPLATE_PARTS: dict[str, tuple[str, ...]] = {
    "theme": ("theme",),
    "typography": ("typography",),
    "layout": ("layout",),
    "structure": ("columns", "dimensions", "fields"),
    # Точечные разделы для смешивания шаблонов (§5.9).
    "columns": ("columns",),
    "dimensions": ("dimensions",),
}
