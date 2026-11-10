"""Импорт доски из CSV и JSON, превью доски для главной страницы."""

import json
from pathlib import Path
from typing import Any
from urllib.parse import quote

from tests.api.test_boards import add_card, all_cards, make_board, make_project
from tests.conftest import Api
from tests.reference import zif_template


async def import_file(client: Api, project_id: str, filename: str, data: bytes, **params: str) -> Any:
    return await client.post(
        f"/projects/{project_id}/boards/import",
        content=data,
        params=params,
        headers={"X-File-Name": quote(filename), "Content-Type": "application/octet-stream"},
    )


EXCEL_CSV = (
    "﻿Название;Описание;Статус;Приоритет;Метки;Оценка;Срок;Создана\r\n"
    "Логин;Форма входа;Бэклог;Высокий;backend, auth;3;2027-01-15;2026-01-01\r\n"
    "Регистрация;;В работе;Низкий;auth;5;15.02.2027;2026-01-01\r\n"
    "Отчёт;'=SUM(A1);Готово;Высокий;;8;;2026-01-01\r\n"
    ";пустая строка без названия;Бэклог;;;;;\r\n"
).encode()


async def test_csv_from_excel_becomes_board(client: Api) -> None:
    project = await make_project(client)
    response = await import_file(client, project["id"], "Спринт 1.csv", EXCEL_CSV)
    assert response.status_code == 201, response.text
    result = response.json()
    assert "Пропущено строк без названия: 1" in result["warnings"]
    board = result["boards"][0]
    assert board["name"] == "Спринт 1"
    config = board["config"]
    assert [(c["name"], c["kind"]) for c in config["columns"]] == [
        ("Бэклог", "backlog"),
        ("В работе", "in_progress"),
        ("Готово", "done"),
    ]
    dimensions = {d["name"]: d for d in config["dimensions"]}
    assert set(dimensions) == {"Приоритет", "Метки"}
    assert dimensions["Метки"]["type"] == "multi_select"
    assert {f["name"]: f["type"] for f in config["fields"]} == {"Оценка": "number"}
    cards = {card["title"]: card for card in await all_cards(client, board["id"])}
    assert set(cards) == {"Логин", "Регистрация", "Отчёт"}
    login = cards["Логин"]
    assert login["column"] == config["columns"][0]["key"]
    assert login["due_date"] == "2027-01-15"
    assert len(login["values"][dimensions["Метки"]["key"]]) == 2
    assert cards["Регистрация"]["due_date"] == "2027-02-15"
    # Апостроф защиты от формул из выгрузки Kanbanly снимается.
    assert cards["Отчёт"]["description"] == "=SUM(A1)"
    assert cards["Отчёт"]["fields"][config["fields"][0]["key"]] == 8


async def test_kanbanly_csv_export_round_trip(client: Api) -> None:
    project = await make_project(client)
    source = await make_board(client, project["id"], name="Исходная", template=zif_template())
    exported = (await client.get(f"/boards/{source['id']}/export.csv")).content
    response = await import_file(client, project["id"], "Исходная.csv", exported, name="Копия из CSV")
    assert response.status_code == 201, response.text
    board = response.json()["boards"][0]
    assert board["name"] == "Копия из CSV"
    # В таблице есть только колонки с карточками; их порядок сохраняется.
    used = {card["column"] for card in await all_cards(client, source["id"])}
    expected = [c["name"] for c in source["config"]["columns"] if c["key"] in used]
    assert [c["name"] for c in board["config"]["columns"]] == expected
    assert len(await all_cards(client, board["id"])) == 153


async def test_task_array_json(client: Api) -> None:
    project = await make_project(client)
    tasks = [
        {"id": 1, "title": "Арт", "status": "Идеи", "desc": "Концепт", "epic": "core"},
        {"id": 2, "title": "Код", "status": "Сделано", "epic": "extra"},
    ]
    response = await import_file(
        client, project["id"], "tasks.json", json.dumps(tasks, ensure_ascii=False).encode()
    )
    assert response.status_code == 201, response.text
    board = response.json()["boards"][0]
    assert [(c["name"], c["kind"]) for c in board["config"]["columns"]] == [
        ("Идеи", "backlog"),
        ("Сделано", "done"),
    ]
    cards = await all_cards(client, board["id"])
    assert {card["title"]: card["description"] for card in cards} == {"Арт": "Концепт", "Код": ""}


async def test_template_json(client: Api) -> None:
    project = await make_project(client)
    raw = json.dumps(zif_template(), ensure_ascii=False).encode()
    response = await import_file(client, project["id"], "zif.json", raw)
    assert response.status_code == 201, response.text
    board = response.json()["boards"][0]
    assert board["config"]["theme"]["tokens"]["accent"] == "#C9A84C"
    assert len(await all_cards(client, board["id"])) == 153


async def test_backup_json_keeps_comments_and_tags(client: Api) -> None:
    source_project = await make_project(client, "Старый")
    board = await make_board(
        client, source_project["id"], name="Рабочая", preset="personal", include_samples=False
    )
    tag = (
        await client.post(
            f"/projects/{source_project['id']}/tags", json={"name": "Срочно", "color": "#C92A2A"}
        )
    ).json()
    card = await add_card(client, board["id"], "С комментарием", column=board["config"]["columns"][0]["key"])
    await client.patch(f"/cards/{card['id']}", json={"tags": [tag["id"]], "color": "#1971C2"})
    await client.post(f"/cards/{card['id']}/comments", json={"body": "Важно"})
    backup = (await client.get("/export/backup", params={"scope": f"board:{board['id']}"})).content

    target = await make_project(client, "Новый")
    response = await import_file(client, target["id"], "board.json", backup)
    assert response.status_code == 201, response.text
    imported = response.json()["boards"][0]
    assert imported["name"] == "Рабочая"
    assert imported["project_id"] == target["id"]
    [copy] = await all_cards(client, imported["id"])
    assert copy["comments_count"] == 1
    assert copy["color"] == "#1971C2"
    tags = (await client.get(f"/projects/{target['id']}/tags")).json()
    assert [t["name"] for t in tags] == ["Срочно"]
    assert copy["tags"] == [tags[0]["id"]]


async def test_bad_files_are_rejected(client: Api) -> None:
    project = await make_project(client)
    cases = [
        ("empty.csv", b"", "empty_file"),
        ("broken.json", b"{not json", "invalid_json"),
        ("other.json", b'{"hello": 1}', "unsupported_file"),
        ("numbers.json", b"[1, 2]", "unsupported_file"),
    ]
    for filename, data, code in cases:
        response = await import_file(client, project["id"], filename, data)
        assert response.status_code == 422, filename
        assert response.json()["error"]["code"] == code, filename
    many = "Название;Статус\r\n" + "".join(f"Задача {n};Статус {n}\r\n" for n in range(60))
    response = await import_file(client, project["id"], "many.csv", many.encode())
    assert response.json()["error"]["code"] == "too_many_columns"
    assert (await all_cards(client, (await make_board(client, project["id"]))["id"])) == []


async def test_import_requires_editor(client: Api, other: Api) -> None:
    project = await make_project(client)
    response = await import_file(other, project["id"], "a.csv", "Название\r\nА\r\n".encode())
    assert response.status_code == 404


async def test_cp1251_and_comma_csv(client: Api) -> None:
    project = await make_project(client)
    raw = "Title,Status\r\nОдин,To Do\r\nДва,Done\r\n".encode("cp1251")
    board = (await import_file(client, project["id"], "win.csv", raw)).json()["boards"][0]
    assert [c["kind"] for c in board["config"]["columns"]] == ["todo", "done"]
    assert {c["title"] for c in await all_cards(client, board["id"])} == {"Один", "Два"}


async def test_board_preview_limits_cards(client: Api) -> None:
    project = await make_project(client)
    board = await make_board(client, project["id"], template=zif_template())
    preview = (await client.get(f"/boards/{board['id']}/preview")).json()
    assert preview["name"] == board["name"]
    assert preview["config"]["theme"] == board["config"]["theme"]
    per_column: dict[str, int] = {}
    for card in preview["cards"]:
        per_column[card["column"]] = per_column.get(card["column"], 0) + 1
    assert per_column and max(per_column.values()) <= 6


GENESIS = Path(__file__).resolve().parent.parent / "fixtures" / "genesis-short.json"


async def test_board_import_button_adds_template_cards(client: Api) -> None:
    """Кнопка «Импорт» на доске: шаблон с карточками добавляет и карточки, а не только оформление."""
    template = json.loads(GENESIS.read_text(encoding="utf-8"))
    project = await make_project(client)
    board = await make_board(client, project["id"], template=template, include_samples=False)
    assert await all_cards(client, board["id"]) == []
    response = await client.post(
        f"/boards/{board['id']}/template/apply",
        json={"template": template, "parts": ["theme", "typography", "layout", "structure"], "cards": True},
    )
    assert response.status_code == 200, response.text
    cards = {card["title"]: card for card in await all_cards(client, board["id"])}
    assert set(cards) == {
        "Дизайн-документ Genesis v1",
        "Разрезать ГДД на контекст-пакеты для ИИ",
        "Сайт: кнопка «в канбан»",
    }
    done = cards["Дизайн-документ Genesis v1"]
    assert done["column"] == "done"
    assert done["values"]["tags"] == ["manual"]
    assert done["fields"]["gdd"] == "весь"


async def test_cards_only_into_other_structure_skip_what_does_not_fit(client: Api) -> None:
    template = json.loads(GENESIS.read_text(encoding="utf-8"))
    project = await make_project(client)
    board = await make_board(client, project["id"], preset="personal", include_samples=False)
    before = board["config"]
    response = await client.post(
        f"/boards/{board['id']}/template/apply", json={"template": template, "cards": True}
    )
    assert response.status_code == 200, response.text
    # Оформление не тронуто, карточки из чужих колонок пропущены с объяснением.
    assert response.json()["config"]["theme"] == before["theme"]
    assert any("без подходящей колонки" in note for note in response.json()["warnings"])
    nothing = await client.post(f"/boards/{board['id']}/template/apply", json={"template": template})
    assert nothing.status_code == 422
