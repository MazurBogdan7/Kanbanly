"""Миграции версий JSON: цепочка функций vN → vN+1 на каждый формат.

Чтобы выпустить v2: поднять CURRENT, зарегистрировать мигрант от 1 к 2 и добавить в
tests/unit/fixtures файл старой версии. Тест прогоняет каждую версию до текущей.
"""

from collections.abc import Callable
from typing import Any

from app.core.errors import ApiError

Document = dict[str, Any]
Migrant = Callable[[Document], Document]

CURRENT: dict[str, int] = {"kanbanly.board-template": 1, "kanbanly.backup": 1}
MIGRANTS: dict[tuple[str, int], Migrant] = {}


def register(format_name: str, from_version: int) -> Callable[[Migrant], Migrant]:
    def decorator(function: Migrant) -> Migrant:
        MIGRANTS[(format_name, from_version)] = function
        return function

    return decorator


def migrate(format_name: str, document: Document) -> tuple[Document, list[str]]:
    version = document.get("version", 1)
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ApiError(
            422,
            "invalid_version",
            "Некорректная версия файла",
            [{"path": "version", "message": "ожидается целое ≥ 1"}],
        )
    current = CURRENT[format_name]
    if version > current:
        raise ApiError(
            422,
            "unsupported_version",
            f"Файл создан более новой версией Kanbanly (v{version}, поддерживается v{current})",
        )
    notes: list[str] = []
    while version < current:
        migrant = MIGRANTS.get((format_name, version))
        if migrant is None:
            raise ApiError(422, "unsupported_version", f"Нет миграции с версии {version}")
        document = migrant(dict(document))
        version += 1
        document["version"] = version
        notes.append(f"Формат обновлён до версии {version}")
    return document, notes
