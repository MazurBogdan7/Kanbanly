"""Безопасный разбор и строгая проверка загружаемого JSON (§7.3)."""

import json
from typing import Any

from pydantic import BaseModel, ValidationError

from app.core.config import Settings
from app.core.errors import ApiError, format_validation_errors
from app.core.textguard import contains_bad_text
from app.migrations_json import migrate
from app.schemas.template import BoardConfig, BoardTemplate


def parse_json(raw: bytes, max_bytes: int, max_depth: int) -> Any:
    if len(raw) > max_bytes:
        raise ApiError(413, "payload_too_large", f"Файл больше допустимых {max_bytes // 1024} КБ")
    try:
        document = json.loads(raw)
    except RecursionError as exc:
        raise ApiError(422, "too_deep", "Слишком глубокая вложенность JSON") from exc
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiError(422, "invalid_json", "Файл не является корректным JSON") from exc
    check_depth(document, max_depth)
    return document


def check_depth(document: Any, max_depth: int) -> None:
    stack: list[tuple[Any, int]] = [(document, 1)]
    while stack:
        value, depth = stack.pop()
        if depth > max_depth:
            raise ApiError(422, "too_deep", "Слишком глубокая вложенность JSON")
        if isinstance(value, dict):
            stack.extend((item, depth + 1) for item in value.values())
        elif isinstance(value, list):
            stack.extend((item, depth + 1) for item in value)
    if contains_bad_text(document):
        raise ApiError(422, "invalid_text", "Текст содержит недопустимые символы")


def strip_extras(model: BaseModel, path: str = "") -> list[str]:
    """Удаляет неизвестные поля и сообщает о них. _comment молча игнорируется."""
    warnings: list[str] = []
    extra = model.__pydantic_extra__
    if extra:
        for key in list(extra):
            if key != "_comment":
                warnings.append(f"Неизвестное поле проигнорировано: {path + '.' if path else ''}{key}")
        extra.clear()
    for name in type(model).model_fields:
        warnings.extend(_walk(getattr(model, name), f"{path}.{name}" if path else name))
    return warnings


def _walk(value: Any, path: str) -> list[str]:
    if isinstance(value, BaseModel):
        return strip_extras(value, path)
    if isinstance(value, list):
        return [w for index, item in enumerate(value) for w in _walk(item, f"{path}[{index}]")]
    if isinstance(value, dict):
        return [w for key, item in value.items() for w in _walk(item, f"{path}.{key}")]
    return []


def validate_template(document: Any) -> tuple[BoardTemplate, list[str]]:
    if not isinstance(document, dict):
        raise ApiError(422, "invalid_template", "Ожидается JSON-объект шаблона")
    if document.get("format") not in (None, "kanbanly.board-template"):
        raise ApiError(
            422,
            "invalid_format",
            "Это не шаблон доски",
            [{"path": "format", "message": "ожидается kanbanly.board-template"}],
        )
    migrated, notes = migrate("kanbanly.board-template", document)
    try:
        template = BoardTemplate.model_validate(migrated)
    except ValidationError as exc:
        problems = format_validation_errors(list(exc.errors()))
        raise ApiError(422, "invalid_template", "Шаблон не прошёл проверку", problems) from exc
    return template, notes + strip_extras(template)


def parse_template(raw: bytes, settings: Settings) -> tuple[BoardTemplate, list[str]]:
    document = parse_json(raw, settings.template_max_bytes, settings.json_max_depth)
    return validate_template(document)


def validate_config(document: BoardConfig) -> list[str]:
    return strip_extras(document)
