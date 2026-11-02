"""Пресеты — обычные JSON-шаблоны в каталоге; кода под конкретный пресет нет."""

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.core.errors import not_found
from app.schemas.template import BoardTemplate
from app.services.json_import import validate_template

PRESETS_DIR = Path(__file__).resolve().parent.parent / "presets"
EXAMPLE_FILE = PRESETS_DIR / "example" / "kanbanly-template-example.json"


@lru_cache(maxsize=1)
def _load() -> dict[str, BoardTemplate]:
    presets: dict[str, BoardTemplate] = {}
    for path in sorted(PRESETS_DIR.glob("preset-*.json")):
        template, _ = validate_template(json.loads(path.read_text(encoding="utf-8")))
        presets[path.stem.removeprefix("preset-")] = template
    return presets


def list_presets() -> dict[str, BoardTemplate]:
    return _load()


def get_preset(key: str) -> BoardTemplate:
    template = _load().get(key)
    if template is None:
        raise not_found()
    return template.model_copy(deep=True)


def example_document() -> dict[str, Any]:
    document: dict[str, Any] = json.loads(EXAMPLE_FILE.read_text(encoding="utf-8"))
    return document
