"""Формат шаблона: пресеты, полнота примера, вредоносные значения."""

import json
import types
import typing
from pathlib import Path
from typing import Any, Literal

import pytest
from pydantic import BaseModel

from app.core.config import Settings
from app.core.errors import ApiError
from app.migrations_json import CURRENT, MIGRANTS, migrate, register
from app.schemas import template as schema
from app.schemas.template import BoardTemplate, Node
from app.services import presets
from app.services.board_config import dimension_roles
from app.services.json_import import parse_json, parse_template, validate_template

ZIF_PATH = Path(presets.PRESETS_DIR) / "preset-zif-gamedev.json"


def minimal() -> dict[str, Any]:
    return {
        "format": "kanbanly.board-template",
        "version": 1,
        "meta": {"name": "T"},
        "columns": [{"key": "a", "name": "A"}],
    }


def problems(document: Any) -> list[dict[str, str]]:
    with pytest.raises(ApiError) as caught:
        validate_template(document)
    return caught.value.details


def test_zif_preset_imports_unmodified() -> None:
    template, warnings = validate_template(json.loads(ZIF_PATH.read_text(encoding="utf-8")))
    assert warnings == []
    assert len(template.sample_cards) == 153
    assert [c.key for c in template.columns] == ["backlog", "todo", "doing", "review", "done"]
    assert len(template.dimensions[0].values) == 15
    assert template.dimensions[1].type == "ordered_select"


def test_all_presets_are_diverse() -> None:
    all_presets = presets.list_presets()
    assert set(all_presets) == {"zif-gamedev", "design-studio", "scrum-lite", "personal", "content-plan"}
    assert len({t.typography.board_title.font for t in all_presets.values()}) >= 4
    assert len({t.theme.density for t in all_presets.values()}) == 3
    assert {t.theme.mode for t in all_presets.values()} == {"light", "dark", "both"}


def test_design_studio_matches_spec() -> None:
    studio = presets.get_preset("design-studio")
    assert [c.name for c in studio.columns] == [
        "Бриф",
        "Референсы",
        "Скетчи",
        "Дизайн",
        "Ревью",
        "Правки",
        "Передано",
    ]
    assert {c.name: c.wip_limit for c in studio.columns if c.wip_limit} == {"Дизайн": 4, "Ревью": 3}
    assert [d.name for d in studio.dimensions] == ["Тип работ", "Платформа", "Клиент"]
    assert {f.name: f.type for f in studio.fields} == {
        "Figma": "url",
        "Дедлайн": "date",
        "Раунд правок": "number",
    }


def iter_models(model: type[BaseModel], seen: set[type]) -> typing.Iterator[type[BaseModel]]:
    if model in seen:
        return
    seen.add(model)
    yield model
    for field in model.model_fields.values():
        for nested in annotation_models(field.annotation):
            yield from iter_models(nested, seen)


def annotation_models(annotation: Any) -> typing.Iterator[type[BaseModel]]:
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        yield annotation
    for argument in typing.get_args(annotation):
        yield from annotation_models(argument)


def literal_values(annotation: Any) -> set[Any]:
    origin = typing.get_origin(annotation)
    if origin is Literal:
        return set(typing.get_args(annotation))
    if origin is typing.Annotated or origin in (list, dict, typing.Union, types.UnionType):
        return {value for a in typing.get_args(annotation) for value in literal_values(a)}
    return set()


def collect_usage(value: Any, usage: dict[str, set[Any]], used_keys: set[str]) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            used_keys.add(key)
            usage.setdefault(key, set())
            if isinstance(item, list | dict):
                collect_usage(item, usage, used_keys)
                if isinstance(item, list):
                    usage[key].update(x for x in item if not isinstance(x, list | dict))
            else:
                usage[key].add(item)
    elif isinstance(value, list):
        for item in value:
            collect_usage(item, usage, used_keys)


SAME_OPTION = {"accent_style": "style", "style": "accent_style", "column_kind": "kind"}
SINGLE_CHOICE = {
    ("Theme", "mode"),
    ("Theme", "density"),
    ("CardLayout", "shadow"),
    ("CardLayout", "hover"),
    ("EditorLayout", "type"),
    ("EditorLayout", "fields_grid"),
}


def test_example_is_valid_and_warning_free() -> None:
    template, warnings = validate_template(presets.example_document())
    assert warnings == []
    assert template.sample_cards


def test_example_uses_every_option() -> None:
    """Падает, если в схему добавили опцию, а в пример — нет."""
    document = presets.example_document()
    usage: dict[str, set[Any]] = {}
    used_keys: set[str] = set()
    collect_usage(document, usage, used_keys)

    missing_fields: list[str] = []
    missing_values: list[str] = []
    comments = " ".join(str(value) for value in usage["_comment"])
    for model in iter_models(BoardTemplate, set()):
        for name, field in model.model_fields.items():
            key = field.alias or name
            if key not in used_keys:
                missing_fields.append(f"{model.__name__}.{key}")
            used = usage.get(key, set()) | usage.get(SAME_OPTION.get(key, ""), set())
            for value in literal_values(field.annotation):
                if (model.__name__, key) in SINGLE_CHOICE:
                    # Одно значение на доску: остальные варианты описаны в комментарии.
                    if str(value) not in comments:
                        missing_values.append(f"{model.__name__}.{key}={value} (нет в _comment)")
                elif value not in used:
                    missing_values.append(f"{model.__name__}.{key}={value}")
    assert missing_fields == []
    assert missing_values == []


def test_example_covers_every_font_role_and_token() -> None:
    document = presets.example_document()
    assert set(document["typography"]) - {"_comment"} == set(schema.Typography.model_fields)
    assert set(schema.BASE_TOKENS) < set(document["theme"]["tokens"])
    template, _ = validate_template(document)
    from app.services.templates import config_of

    config = config_of(template)
    roles = {role for d in config.dimensions for role in dimension_roles(config, d.key)}
    assert roles == set(typing.get_args(schema.DimensionRole))


@pytest.mark.parametrize("value", ["red", "#12", "#GGGGGG", "url(javascript:alert(1))", "#123456;}", ""])
def test_bad_colors_rejected_with_path(value: str) -> None:
    document = minimal()
    document["columns"].append({"key": "b", "name": "B"})
    document["columns"].append({"key": "c", "name": "C"})
    document["columns"].append({"key": "d", "name": "D", "color": value})
    assert {"path": "columns[3].color", "message": "неверный формат цвета"} in problems(document)


def test_unknown_token_reference_rejected() -> None:
    document = minimal()
    document["columns"][0]["color"] = "{nope}"
    assert any("неизвестный токен" in p["message"] for p in problems(document))


@pytest.mark.parametrize("font", ["Comic Sans", "Inter;} body{display:none", "url(evil)"])
def test_fonts_are_whitelisted(font: str) -> None:
    document = minimal()
    document["typography"] = {"base": {"font": font}}
    assert problems(document)[0]["message"] == "шрифт не из белого списка"


@pytest.mark.parametrize(
    "url", ["http://x.test/a.png", "javascript:alert(1)", "data:text/html,x", "https://x.test/a)b"]
)
def test_background_url_must_be_https(url: str) -> None:
    document = minimal()
    document["theme"] = {"header_background": {"type": "image", "url": url}}
    assert problems(document)


def test_unknown_fields_warn_and_comment_is_silent() -> None:
    document = minimal()
    document["_comment"] = "тихо"
    document["__proto__"] = {"polluted": True}
    document["meta"]["unknown"] = 1
    document["columns"][0]["surprise"] = {"deep": True}
    template, warnings = validate_template(document)
    assert sorted(warnings) == [
        "Неизвестное поле проигнорировано: __proto__",
        "Неизвестное поле проигнорировано: columns[0].surprise",
        "Неизвестное поле проигнорировано: meta.unknown",
    ]
    dumped = template.model_dump(by_alias=True)
    assert "__proto__" not in dumped and "surprise" not in dumped["columns"][0]


@pytest.mark.parametrize(
    ("mutate", "path"),
    [
        (lambda d: d["columns"].append({"key": "a", "name": "дубль"}), "columns"),
        (
            lambda d: d.update(sample_cards=[{"key": "x", "column": "zz", "title": "t"}]),
            "sample_cards[0].column",
        ),
        (lambda d: d.update(layout={"card": {"accent": {"source": "dimension:zz"}}}), "layout.card.accent"),
        (
            lambda d: d.update(layout={"header": {"widgets": [{"type": "filter_chips", "dimension": "zz"}]}}),
            "layout.header.widgets[0]",
        ),
    ],
)
def test_reference_errors_have_paths(mutate: Any, path: str) -> None:
    document = minimal()
    mutate(document)
    assert problems(document)[0]["path"] == path


def test_string_length_limits() -> None:
    document = minimal()
    document["columns"][0]["name"] = "x" * 121
    assert problems(document)[0]["path"] == "columns[0].name"


def test_catastrophic_regex_rejected() -> None:
    document = minimal()
    document["fields"] = [{"key": "f", "name": "F", "type": "text", "validation": {"regex": "(a+)+$"}}]
    assert problems(document)[0]["message"] == "вложенные квантификаторы запрещены"


def test_parse_json_limits() -> None:
    with pytest.raises(ApiError) as big:
        parse_json(b" " * 11, 10, 32)
    assert big.value.status == 413
    with pytest.raises(ApiError) as deep:
        parse_json(b"[" * 100 + b"]" * 100, 1000, 32)
    assert deep.value.code == "too_deep"
    with pytest.raises(ApiError) as very_deep:
        parse_json(b"[" * 200000 + b"]" * 200000, 10_000_000, 32)
    assert very_deep.value.code == "too_deep"
    with pytest.raises(ApiError) as bad:
        parse_json(b"{not json", 1000, 32)
    assert bad.value.code == "invalid_json"


def test_parse_template_end_to_end() -> None:
    settings = Settings(_env_file=None, env="test")
    template, _ = parse_template(json.dumps(minimal()).encode(), settings)
    assert template.meta.name == "T"


def test_non_object_and_wrong_format() -> None:
    with pytest.raises(ApiError):
        validate_template([])
    with pytest.raises(ApiError) as caught:
        validate_template({**minimal(), "format": "kanbanly.backup"})
    assert caught.value.code == "invalid_format"


def test_migrations_chain(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(CURRENT, "kanbanly.board-template", 3)
    monkeypatch.setattr("app.migrations_json.MIGRANTS", dict(MIGRANTS))

    @register("kanbanly.board-template", 1)
    def one_to_two(document: dict[str, Any]) -> dict[str, Any]:
        return {"version": document["version"], "title": document["name"]}

    @register("kanbanly.board-template", 2)
    def two_to_three(document: dict[str, Any]) -> dict[str, Any]:
        return {"version": document["version"], "heading": document["title"]}

    migrated, notes = migrate("kanbanly.board-template", {"version": 1, "name": "x"})
    assert migrated == {"version": 3, "heading": "x"}
    assert len(notes) == 2
    MIGRANTS.pop(("kanbanly.board-template", 1), None)
    MIGRANTS.pop(("kanbanly.board-template", 2), None)


def test_future_and_invalid_versions_rejected() -> None:
    with pytest.raises(ApiError) as future:
        migrate("kanbanly.board-template", {"version": 99})
    assert future.value.code == "unsupported_version"
    with pytest.raises(ApiError) as invalid:
        migrate("kanbanly.backup", {"version": "1"})
    assert invalid.value.code == "invalid_version"


def test_node_base_collects_extras() -> None:
    class Sample(Node):
        a: int

    assert Sample.model_validate({"a": 1, "b": 2}).__pydantic_extra__ == {"b": 2}


def test_committed_json_schema_is_current() -> None:
    """docs/schemas обновляются scripts/export_schemas.py и не отстают от моделей."""
    from scripts.export_schemas import schemas

    root = Path(__file__).resolve().parents[3] / "docs" / "schemas"
    for name, content in schemas().items():
        assert json.loads((root / name).read_text(encoding="utf-8")) == content, name
