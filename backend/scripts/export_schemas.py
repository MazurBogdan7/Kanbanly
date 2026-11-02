"""Генерирует docs/schemas/*.schema.json и OpenAPI для TS-клиента из Pydantic-моделей."""

import json
import sys
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from app.schemas.backup import BackupDocument, EncryptedBackup  # noqa: E402
from app.schemas.template import BoardSettings, BoardTemplate  # noqa: E402

ROOT = BACKEND.parent


def _titled(model: Any, schema_id: str) -> dict[str, Any]:
    schema: dict[str, Any] = model.model_json_schema(by_alias=True, mode="validation")
    return {"$id": schema_id, "$schema": "https://json-schema.org/draft/2020-12/schema", **schema}


def schemas() -> dict[str, dict[str, Any]]:
    return {
        "board-template.schema.json": _titled(
            BoardTemplate, "https://kanbanly.local/schemas/board-template.v1.json"
        ),
        "board-settings.schema.json": _titled(
            BoardSettings, "https://kanbanly.local/schemas/board-settings.v1.json"
        ),
        "backup.schema.json": _titled(BackupDocument, "https://kanbanly.local/schemas/backup.v1.json"),
        "backup-encrypted.schema.json": _titled(
            EncryptedBackup, "https://kanbanly.local/schemas/backup-encrypted.v1.json"
        ),
    }


def relax_defaults(document: dict[str, Any]) -> None:
    """Поля с default необязательны на вводе: TS-типы шаблона не требуют полного объекта."""
    for schema in document["components"]["schemas"].values():
        properties = schema.get("properties", {})
        required = [key for key in schema.get("required", []) if "default" not in properties.get(key, {})]
        if required:
            schema["required"] = required
        else:
            schema.pop("required", None)


def main() -> None:
    from app.core.config import Settings
    from app.main import create_app

    target = ROOT / "docs" / "schemas"
    target.mkdir(parents=True, exist_ok=True)
    for name, content in schemas().items():
        (target / name).write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    app = create_app(
        Settings(_env_file=None, env="dev", database_url="sqlite+aiosqlite://")  # type: ignore[call-arg]
    )
    document = app.openapi()
    relax_defaults(document)
    (ROOT / "frontend" / "openapi.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
