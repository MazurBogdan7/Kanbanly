"""Выгрузка досок в CSV для Excel: одна доска — файл, несколько — ZIP-архив с файлом на доску.

У каждой доски свои колонки, измерения и поля, поэтому в один лист их не свести без потерь.
"""

import csv
import io
import json
import re
import zipfile
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Board, Project
from app.repositories import access
from app.services import cards as card_service
from app.services import templates as template_service
from app.services.backup import Scope
from app.services.board_config import load_board
from app.services.cards import build_index

CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
UNSAFE_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')
BOM = "﻿"


def csv_cell(value: object) -> str:
    text = "" if value is None else str(value)
    # Защита от CSV-инъекции: Excel не должен принять текст карточки за формулу.
    return f"'{text}" if text.startswith(CSV_FORMULA_PREFIXES) else text


async def board_csv(db: AsyncSession, board_id: UUID) -> bytes:
    """Разделитель «;» и BOM, чтобы кириллица открылась в Excel без настроек."""
    board = await load_board(db, board_id)
    index = build_index(board)
    cards = await template_service.board_cards(db, board_id)
    rows = await card_service.serialize_many(db, cards, index)
    order = {column.key: number for number, column in enumerate(board.columns)}
    rows.sort(key=lambda card: (order.get(card.column, 0), card.position))
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
    writer.writerow(
        [
            "Название",
            "Описание",
            "Колонка",
            *[dimension.name for dimension in board.dimensions],
            *[field.name for field in board.fields],
            "Срок",
            "Создана",
            "Завершена",
        ]
    )
    for card in rows:
        dimensions = [
            ", ".join(
                value.name for value in dimension.values if value.key in card.values.get(dimension.key, [])
            )
            for dimension in board.dimensions
        ]
        fields = [
            json.dumps(card.fields[field.key], ensure_ascii=False)
            if isinstance(card.fields.get(field.key), dict | list)
            else card.fields.get(field.key)
            for field in board.fields
        ]
        writer.writerow(
            [
                csv_cell(cell)
                for cell in [
                    card.title,
                    card.description,
                    index.columns_by_key[card.column].name,
                    *dimensions,
                    *fields,
                    card.due_date,
                    card.created_at.date(),
                    card.completed_at.date() if card.completed_at else None,
                ]
            ]
        )
    return (BOM + buffer.getvalue()).encode("utf-8")


def safe_name(name: str, fallback: str) -> str:
    """Имя файла из названия: без символов, запрещённых в Windows, и не длиннее 80 знаков."""
    cleaned = UNSAFE_NAME.sub("_", name).strip(" .")[:80]
    return cleaned or fallback


async def _boards_in_scope(db: AsyncSession, user_id: UUID, scope: Scope) -> list[tuple[Project, Board]]:
    if scope.type == "board" and scope.id is not None:
        found = await access.get_board(db, user_id, scope.id)
        project = await access.get_project(db, user_id, found.board.project_id)
        return [(project.project, found.board)]
    if scope.type == "project" and scope.id is not None:
        projects = [(await access.get_project(db, user_id, scope.id)).project]
    else:
        # Все проекты, к которым есть доступ: и свои, и те, куда пригласили.
        rows = await db.execute(access.visible_projects(user_id).order_by(Project.name))
        projects = [project for project, _ in rows]
    by_id = {project.id: project for project in projects}
    boards = await db.execute(
        select(Board)
        .where(Board.project_id.in_(by_id), Board.deleted_at.is_(None))
        .order_by(Board.name, Board.id)
    )
    return [(by_id[board.project_id], board) for board in boards.scalars()]


async def csv_archive(db: AsyncSession, user_id: UUID, scope: Scope) -> bytes:
    """ZIP: папка на проект, CSV на доску. Одинаковые названия получают номер."""
    buffer = io.BytesIO()
    used: set[str] = set()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for project, board in await _boards_in_scope(db, user_id, scope):
            base = f"{safe_name(project.name, 'project')}/{safe_name(board.name, 'board')}"
            path = f"{base}.csv"
            number = 2
            while path.lower() in used:
                path = f"{base} ({number}).csv"
                number += 1
            used.add(path.lower())
            archive.writestr(path, await board_csv(db, board.id))
    return buffer.getvalue()


def archive_filename(now: datetime | None = None) -> str:
    stamp = (now or datetime.now(UTC)).strftime("%Y-%m-%d-%H%M")
    return f"kanbanly-tables-{stamp}.zip"
