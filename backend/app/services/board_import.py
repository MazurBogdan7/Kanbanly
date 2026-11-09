"""Импорт доски из файла: CSV (Excel, выгрузка Kanbanly, Trello и т.п.) или JSON.

JSON бывает трёх видов: шаблон доски Kanbanly, бэкап Kanbanly (доски переносятся со всеми
карточками, комментариями и чек-листами) и массив задач вида [{"title", "status", ...}].
Таблицы и массивы задач превращаются в обычный шаблон доски с карточками, поэтому дальше
доска создаётся тем же кодом, что и из пресета.
"""

import csv
import io
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import ApiError, format_validation_errors
from app.models import Board, Project
from app.schemas.backup import BACKUP_FORMAT, ENCRYPTED_FORMAT
from app.schemas.template import BoardTemplate
from app.services import backup
from app.services import templates as template_service
from app.services.json_import import check_depth, validate_template

TEMPLATE_FORMAT = "kanbanly.board-template"
GZIP_MAGIC = b"\x1f\x8b"

MAX_COLUMNS = 50
MAX_DIMENSIONS = 30
MAX_FIELDS = 100
MAX_VALUES = 60
MAX_CARDS = 5000
MAX_TITLE = 500
MAX_DESCRIPTION = 20000

# Заголовки таблицы, которые узнаются по смыслу (сравнение без регистра).
TITLE_HEADERS = {"название", "заголовок", "задача", "title", "name", "summary", "task", "card name"}
DESCRIPTION_HEADERS = {"описание", "description", "desc", "details", "подробности", "текст"}
COLUMN_HEADERS = {"колонка", "статус", "column", "status", "list", "list name", "список", "этап", "stage"}
DUE_HEADERS = {"срок", "due", "due date", "due_date", "deadline", "дедлайн", "дата"}
SKIPPED_HEADERS = {
    "id",
    "создана",
    "завершена",
    "обновлена",
    "created",
    "created_at",
    "updated",
    "updated_at",
    "completed",
    "completed_at",
    "card id",
    "list id",
}
DONE_WORDS = ("готов", "сделано", "выполнен", "завершен", "закрыт", "done", "complete", "closed", "finished")
TODO_WORDS = ("к работе", "к выполнению", "сделать", "todo", "to do", "нов", "open")
BACKLOG_WORDS = ("бэклог", "backlog", "идеи", "ideas")
PROGRESS_WORDS = ("в работе", "в процессе", "progress", "doing", "делаем")
REVIEW_WORDS = ("провер", "ревью", "review", "тест")
FORMULA_ESCAPE = re.compile(r"^'(?=[=+\-@\t\r])")
DATE_FORMATS = ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%Y/%m/%d", "%d.%m.%y")
NUMBER = re.compile(r"^-?\d+(?:[.,]\d+)?$")


@dataclass
class ImportResult:
    boards: list[Board]
    warnings: list[str] = field(default_factory=list)


def _norm(value: str) -> str:
    return value.strip().lstrip("﻿").strip().lower()


def _clean(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict | list):
        return json.dumps(value, ensure_ascii=False)
    text = str(value).strip()
    # Выгрузка Kanbanly защищает ячейки от формул апострофом; при импорте он не нужен.
    return FORMULA_ESCAPE.sub("", text)


def _parse_date(value: str) -> date | None:
    text = value.strip()[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", value.strip()) else value.strip()
    for pattern in DATE_FORMATS:
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    return None


def _column_kind(name: str, index: int, total: int) -> str:
    lowered = name.lower()
    for words, kind in (
        (DONE_WORDS, "done"),
        (REVIEW_WORDS, "review"),
        (PROGRESS_WORDS, "in_progress"),
        (TODO_WORDS, "todo"),
        (BACKLOG_WORDS, "backlog"),
    ):
        if any(word in lowered for word in words):
            return kind
    if index == 0:
        return "todo"
    if index == total - 1 and total > 1:
        return "done"
    return "in_progress"


def _decode(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1251"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ApiError(422, "invalid_csv", "Не удалось прочитать файл: сохраните таблицу в кодировке UTF-8")


def read_csv(raw: bytes) -> tuple[list[str], list[dict[str, str]]]:
    text = _decode(raw)
    sample = text[:20000]
    try:
        delimiter = csv.Sniffer().sniff(sample, delimiters=";,\t").delimiter
    except csv.Error:
        delimiter = ";" if sample.count(";") >= sample.count(",") else ","
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    try:
        rows = [row for row in reader if any(cell.strip() for cell in row)]
    except csv.Error as exc:
        raise ApiError(422, "invalid_csv", f"Таблица повреждена: {exc}") from exc
    if not rows:
        raise ApiError(422, "invalid_csv", "Таблица пустая")
    headers = [cell.strip().lstrip("﻿") or f"Столбец {number + 1}" for number, cell in enumerate(rows[0])]
    records = [
        {header: (row[number] if number < len(row) else "") for number, header in enumerate(headers)}
        for row in rows[1:]
    ]
    return headers, records


def _pick(headers: list[str], names: set[str]) -> str | None:
    return next((header for header in headers if _norm(header) in names), None)


def _split(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def template_from_rows(
    name: str, headers: list[str], rows: list[dict[str, str]]
) -> tuple[BoardTemplate, list[str]]:
    """Строки таблицы → шаблон доски: колонки из «Статуса», повторяющиеся значения → измерения."""
    warnings: list[str] = []
    title_header = _pick(headers, TITLE_HEADERS) or headers[0]
    description_header = _pick(headers, DESCRIPTION_HEADERS)
    column_header = _pick(headers, COLUMN_HEADERS)
    due_header = _pick(headers, DUE_HEADERS)
    used = {title_header, description_header, column_header, due_header}
    rest = [header for header in headers if header not in used and _norm(header) not in SKIPPED_HEADERS]

    records = [
        {header: _clean(value) for header, value in row.items()}
        for row in rows
        if _clean(row.get(title_header))
    ]
    skipped = len(rows) - len(records)
    if skipped:
        warnings.append(f"Пропущено строк без названия: {skipped}")
    if len(records) > MAX_CARDS:
        warnings.append(f"Импортированы первые {MAX_CARDS} карточек из {len(records)}")
        records = records[:MAX_CARDS]

    column_names: list[str] = []
    if column_header:
        column_names = list(
            dict.fromkeys(record[column_header] for record in records if record[column_header])
        )
    if not column_names:
        column_names = ["К работе", "В работе", "Готово"]
    if len(column_names) > MAX_COLUMNS:
        raise ApiError(
            422,
            "too_many_columns",
            f"В столбце «{column_header}» {len(column_names)} разных значений, "
            f"а колонок может быть не больше {MAX_COLUMNS}",
        )
    columns = [
        {
            "key": f"col-{number + 1}",
            "name": column[:120],
            "kind": _column_kind(column, number, len(column_names)),
        }
        for number, column in enumerate(column_names)
    ]
    column_keys = {column: f"col-{number + 1}" for number, column in enumerate(column_names)}

    dimensions: list[dict[str, Any]] = []
    fields: list[dict[str, Any]] = []
    value_keys: dict[str, tuple[str, dict[str, str]]] = {}
    field_keys: dict[str, tuple[str, str]] = {}
    for header in rest:
        cells = [record[header] for record in records if record[header]]
        if not cells:
            continue
        values = list(dict.fromkeys(part for cell in cells for part in _split(cell)))
        multi = any(len(_split(cell)) > 1 for cell in cells)
        repeated = len(values) <= max(3, len(records) // 2)
        is_dimension = (
            len(values) <= MAX_VALUES
            and repeated
            and all(len(value) <= 60 for value in values)
            and not all(NUMBER.match(value) for value in values)
            and len(dimensions) < MAX_DIMENSIONS
        )
        if is_dimension:
            key = f"dim-{len(dimensions) + 1}"
            value_keys[header] = (key, {value: f"v{number + 1}" for number, value in enumerate(values)})
            dimensions.append(
                {
                    "key": key,
                    "name": header[:120],
                    "type": "multi_select" if multi else "select",
                    "roles": ["badge", "filter_select"] if len(dimensions) < 3 else [],
                    "values": [
                        {"key": f"v{number + 1}", "name": value} for number, value in enumerate(values)
                    ],
                }
            )
            continue
        if len(fields) >= MAX_FIELDS:
            warnings.append(f"Столбец «{header}» пропущен: слишком много полей")
            continue
        if all(NUMBER.match(cell) for cell in cells):
            kind = "number"
        elif all(_parse_date(cell) for cell in cells):
            kind = "date"
        elif all(cell.startswith(("http://", "https://")) for cell in cells):
            kind = "url"
        else:
            kind = "long_text" if any(len(cell) > 120 for cell in cells) else "text"
        key = f"field-{len(fields) + 1}"
        field_keys[header] = (key, kind)
        fields.append({"key": key, "name": header[:120], "type": kind, "show_on_face": len(fields) < 2})

    cards: list[dict[str, Any]] = []
    bad_dates = 0
    for number, record in enumerate(records):
        title = record[title_header]
        description = record[description_header] if description_header else ""
        if len(title) > MAX_TITLE or len(description) > MAX_DESCRIPTION:
            warnings.append(f"Слишком длинный текст карточки «{title[:40]}» обрезан")
        card: dict[str, Any] = {
            "key": f"card-{number + 1}",
            "column": column_keys.get(record[column_header], columns[0]["key"])
            if column_header
            else columns[0]["key"],
            "title": title[:MAX_TITLE],
            "description": description[:MAX_DESCRIPTION],
        }
        if due_header and record[due_header]:
            due = _parse_date(record[due_header])
            if due is None:
                bad_dates += 1
            else:
                card["due_date"] = due.isoformat()
        card_values: dict[str, list[str]] = {}
        for header, (dimension, mapping) in value_keys.items():
            chosen = [mapping[part] for part in _split(record[header]) if part in mapping]
            if chosen:
                card_values[dimension] = chosen
        if card_values:
            card["values"] = card_values
        card_fields: dict[str, Any] = {}
        for header, (key, kind) in field_keys.items():
            cell = record[header]
            if not cell:
                continue
            if kind == "number":
                card_fields[key] = float(cell.replace(",", "."))
            elif kind == "date":
                parsed = _parse_date(cell)
                card_fields[key] = parsed.isoformat() if parsed else None
            else:
                card_fields[key] = cell[:MAX_DESCRIPTION]
        if card_fields:
            card["fields"] = card_fields
        cards.append(card)
    if bad_dates:
        warnings.append(f"Не распознаны даты в {bad_dates} строках — срок не заполнен")

    document = {
        "format": TEMPLATE_FORMAT,
        "version": 1,
        "meta": {"name": name[:200] or "Импорт"},
        "columns": columns,
        "dimensions": dimensions,
        "fields": fields,
        "sample_cards": cards,
    }
    try:
        template = BoardTemplate.model_validate(document)
    except ValidationError as exc:
        problems = format_validation_errors(list(exc.errors()))
        raise ApiError(422, "invalid_table", "Таблицу не удалось превратить в доску", problems) from exc
    return template, warnings


def rows_from_tasks(tasks: list[Any]) -> tuple[list[str], list[dict[str, str]]]:
    """Массив задач [{title, status, desc, ...}] → строки таблицы."""
    headers: list[str] = []
    rows: list[dict[str, str]] = []
    for task in tasks:
        if not isinstance(task, dict):
            raise ApiError(422, "unsupported_file", "Массив должен состоять из объектов-задач")
        row: dict[str, str] = {}
        for key, value in task.items():
            header = {"desc": "description"}.get(str(key), str(key))
            if header not in headers:
                headers.append(header)
            row[header] = ", ".join(map(str, value)) if isinstance(value, list) else _clean(value)
        rows.append(row)
    if not rows or _pick(headers, TITLE_HEADERS) is None:
        raise ApiError(422, "unsupported_file", "У задач нет поля title или name")
    return headers, [{header: row.get(header, "") for header in headers} for row in rows]


def _looks_like_json(filename: str, raw: bytes) -> bool:
    if raw.startswith(GZIP_MAGIC) or filename.lower().endswith((".json", ".gz")):
        return True
    head = raw.lstrip(b"\xef\xbb\xbf \t\r\n")[:1]
    return head in (b"{", b"[")


def _stem(filename: str) -> str:
    base = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return re.sub(r"\.(csv|json|gz|txt|tsv)$", "", base, flags=re.IGNORECASE).strip() or "Импорт"


async def import_file(
    db: AsyncSession,
    settings: Settings,
    project: Project,
    user_id: UUID,
    filename: str,
    raw: bytes,
    *,
    name: str | None = None,
    password: str | None = None,
) -> ImportResult:
    if not raw:
        raise ApiError(422, "empty_file", "Файл пустой")
    if len(raw) > settings.backup_max_bytes:
        raise ApiError(413, "payload_too_large", "Файл больше допустимого размера")
    title = (name or "").strip() or _stem(filename)
    if not _looks_like_json(filename, raw):
        headers, rows = read_csv(raw)
        return await _create(db, project, user_id, title, *template_from_rows(title, headers, rows))

    document = backup.load_json(raw.removeprefix(b"\xef\xbb\xbf"), settings)
    if isinstance(document, list):
        headers, rows = rows_from_tasks(document)
        return await _create(db, project, user_id, title, *template_from_rows(title, headers, rows))
    if not isinstance(document, dict):
        raise ApiError(422, "unsupported_file", "Неизвестный формат файла")
    kind = document.get("format")
    if kind in (BACKUP_FORMAT, ENCRYPTED_FORMAT):
        return await _from_backup(db, settings, project, raw, name, password)
    if kind == TEMPLATE_FORMAT or "columns" in document:
        check_depth(document, settings.json_max_depth)
        template, warnings = validate_template(document)
        board_name = (name or "").strip() or template.meta.name
        return await _create(db, project, user_id, board_name, template, warnings)
    raise ApiError(
        422,
        "unsupported_file",
        "Файл не похож ни на доску Kanbanly, ни на таблицу задач: подойдут CSV, шаблон или бэкап Kanbanly",
    )


async def _create(
    db: AsyncSession, project: Project, user_id: UUID, name: str, template: BoardTemplate, warnings: list[str]
) -> ImportResult:
    board, config_warnings = await template_service.create_board(
        db, project, name[:200], template, include_samples=True, user_id=user_id
    )
    return ImportResult([board], warnings + config_warnings)


async def _from_backup(
    db: AsyncSession,
    settings: Settings,
    project: Project,
    raw: bytes,
    name: str | None,
    password: str | None,
) -> ImportResult:
    """Доски из бэкапа переносятся в выбранный проект целиком; документы проекта не трогаются."""
    parsed = backup.read_backup(raw, settings, password)
    sources = parsed.document.data.boards
    if not sources:
        raise ApiError(422, "no_boards", "В бэкапе нет ни одной доски")
    tags: dict[str, UUID] = {}
    for source_project in parsed.document.data.projects:
        tags = await backup.ensure_tags(db, project, source_project.tags)
    boards: list[Board] = []
    for source in sources:
        if name and name.strip() and len(sources) == 1:
            source = source.model_copy(update={"name": name.strip()[:200]})
        boards.append(await backup.restore_board(db, project, source, tags))
    return ImportResult(boards, parsed.warnings)
