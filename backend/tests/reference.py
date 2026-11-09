"""Эталонный шаблон ZIF (исходный файл заказчика): в приложении его нет, только в тестах."""

import json
from pathlib import Path
from typing import Any

ZIF_PATH = Path(__file__).resolve().parents[2] / "docs" / "reference" / "preset-zif-gamedev.json"


def zif_template() -> dict[str, Any]:
    document: dict[str, Any] = json.loads(ZIF_PATH.read_text(encoding="utf-8"))
    return document
