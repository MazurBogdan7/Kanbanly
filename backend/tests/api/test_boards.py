from datetime import timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.db import utcnow
from app.models import Card, ProjectMember, User
from app.services.trash import purge_expired
from tests.conftest import Api


async def make_project(client: Api, name: str = "Проект") -> dict[str, Any]:
    response = await client.post("/projects", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def make_board(client: Api, project_id: str, **kwargs: Any) -> dict[str, Any]:
    payload = {"name": "Доска", **kwargs}
    response = await client.post(f"/projects/{project_id}/boards", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def all_cards(client: Api, board_id: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    cursor = None
    while True:
        params = {"cursor": cursor} if cursor else {}
        page = (await client.get(f"/boards/{board_id}/cards", params=params)).json()
        items += page["items"]
        cursor = page["next_cursor"]
        if cursor is None:
            return items


async def add_card(
    client: Api, board_id: str, title: str, column: str = "todo", **kwargs: Any
) -> dict[str, Any]:
    response = await client.post(
        f"/boards/{board_id}/cards", json={"title": title, "column": column, **kwargs}
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
async def board(client: Api) -> dict[str, Any]:
    project = await make_project(client)
    return await make_board(client, project["id"])


def column_order(cards: list[dict[str, Any]], column: str) -> list[str]:
    selected = [c for c in cards if c["column"] == column]
    return [c["title"] for c in sorted(selected, key=lambda c: c["position"])]


async def test_project_crud_with_etag(client: Api) -> None:
    project = await make_project(client, "Альфа")
    response = await client.get(f"/projects/{project['id']}")
    assert response.headers["etag"] == '"1"'
    ok = await client.patch(f"/projects/{project['id']}", json={"name": "Бета"}, headers={"If-Match": '"1"'})
    assert ok.status_code == 200 and ok.headers["etag"] == '"2"'
    stale = await client.patch(
        f"/projects/{project['id']}", json={"name": "Гамма"}, headers={"If-Match": '"1"'}
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "version_conflict"
    listing = (await client.get("/projects")).json()
    assert [p["name"] for p in listing["items"]] == ["Бета"]


async def test_project_pagination(client: Api) -> None:
    for number in range(5):
        await make_project(client, f"P{number}")
    first = (await client.get("/projects", params={"limit": 2})).json()
    assert len(first["items"]) == 2 and first["next_cursor"]
    second = (await client.get("/projects", params={"limit": 10, "cursor": first["next_cursor"]})).json()
    assert len(second["items"]) == 3 and second["next_cursor"] is None


async def test_project_soft_delete_and_restore(client: Api) -> None:
    project = await make_project(client)
    board = await make_board(client, project["id"])
    assert (await client.delete(f"/projects/{project['id']}")).status_code == 200
    assert (await client.get(f"/projects/{project['id']}")).status_code == 404
    assert (await client.get(f"/boards/{board['id']}")).status_code == 404
    trash = (await client.get("/trash")).json()
    assert any(item["type"] == "project" for item in trash)
    assert (await client.post(f"/projects/{project['id']}/restore")).status_code == 200
    assert (await client.get(f"/boards/{board['id']}")).status_code == 200


async def test_blank_board_has_default_columns(board: dict[str, Any]) -> None:
    assert [c["key"] for c in board["config"]["columns"]] == ["todo", "doing", "done"]
    assert board["has_source_template"] is True


async def test_board_rename_favorite_and_conflict(client: Api, board: dict[str, Any]) -> None:
    url = f"/boards/{board['id']}"
    ok = await client.patch(url, json={"name": "Новое", "is_favorite": True}, headers={"If-Match": '"1"'})
    assert ok.status_code == 200 and ok.json()["version"] == 2 and ok.json()["is_favorite"]
    stale = await client.patch(url, json={"name": "Старое"}, headers={"If-Match": '"1"'})
    assert stale.status_code == 409


async def test_card_crud_and_history(client: Api, board: dict[str, Any]) -> None:
    card = await add_card(client, board["id"], "Первая", description="**текст**")
    url = f"/cards/{card['id']}"
    updated = await client.patch(url, json={"title": "Изменённая"}, headers={"If-Match": '"1"'})
    assert updated.status_code == 200 and updated.json()["version"] == 2
    assert (await client.patch(url, json={"title": "Х"}, headers={"If-Match": '"1"'})).status_code == 409
    activity = (await client.get(f"{url}/activity")).json()["items"]
    assert [event["action"] for event in activity] == ["updated", "created"]
    assert (await client.delete(url)).status_code == 200
    assert (await client.get(url)).status_code == 404
    assert (await client.post(f"{url}/restore")).status_code == 200
    assert (await client.get(url)).status_code == 200


async def test_move_keeps_neighbours_untouched(client: Api, board: dict[str, Any]) -> None:
    a = await add_card(client, board["id"], "A")
    b = await add_card(client, board["id"], "B")
    c = await add_card(client, board["id"], "C")
    positions = {a["id"]: a["position"], b["id"]: b["position"]}

    moved = await client.post(
        f"/cards/{c['id']}/move", json={"column": "todo", "before_id": a["id"], "after_id": b["id"]}
    )
    assert moved.status_code == 200
    cards = await all_cards(client, board["id"])
    assert column_order(cards, "todo") == ["A", "C", "B"]
    assert {x["id"]: x["position"] for x in cards if x["id"] != c["id"]} == positions

    to_other = await client.post(f"/cards/{a['id']}/move", json={"column": "done"})
    assert to_other.json()["column"] == "done"
    top = await client.post(f"/cards/{b['id']}/move", json={"column": "todo", "after_id": c["id"]})
    assert top.status_code == 200
    assert column_order(await all_cards(client, board["id"]), "todo") == ["B", "C"]


async def test_move_rejects_invalid_targets(client: Api, board: dict[str, Any]) -> None:
    a = await add_card(client, board["id"], "A")
    b = await add_card(client, board["id"], "B", column="doing")
    assert (await client.post(f"/cards/{a['id']}/move", json={"column": "nope"})).status_code == 422
    stale = await client.post(f"/cards/{a['id']}/move", json={"column": "todo", "before_id": b["id"]})
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "stale_position"
    self_ref = await client.post(f"/cards/{a['id']}/move", json={"column": "todo", "before_id": a["id"]})
    assert self_ref.status_code == 422


CONFIG: dict[str, Any] = {
    "columns": [
        {"key": "todo", "name": "Сделать", "kind": "todo", "wip_limit": 3},
        {"key": "done", "name": "Готово", "kind": "done", "card_style": {"opacity": 0.6}},
    ],
    "dimensions": [
        {
            "key": "tag",
            "name": "Теги",
            "type": "multi_select",
            "values": [{"key": "a", "name": "А"}, {"key": "b", "name": "Б", "color": "{accent}"}],
        },
        {
            "key": "prio",
            "name": "Приоритет",
            "type": "ordered_select",
            "required": True,
            "default": "low",
            "values": [{"key": "low", "name": "Низкий"}, {"key": "high", "name": "Высокий"}],
        },
    ],
    "fields": [
        {"key": "pts", "name": "Оценка", "type": "number", "validation": {"min": 0, "max": 100}},
        {"key": "site", "name": "Сайт", "type": "url"},
    ],
    "rules": [{"key": "r1", "type": "set_completed_on_kind", "column_kind": "done"}],
    "views": [{"key": "all", "name": "Все", "type": "table", "group_by": "prio", "is_default": True}],
    "layout": {"card": {"accent": {"source": "dimension:prio"}}},
}


async def test_put_config_round_trip_and_defaults(client: Api, board: dict[str, Any]) -> None:
    card = await add_card(client, board["id"], "В удаляемой колонке", column="doing")
    url = f"/boards/{board['id']}/config"
    response = await client.put(url, json=CONFIG, headers={"If-Match": '"1"'})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["version"] == 2
    assert [c["name"] for c in data["config"]["columns"]] == ["Сделать", "Готово"]
    assert data["config"]["columns"][0]["wip_limit"] == 3
    assert data["config"]["columns"][1]["card_style"]["opacity"] == 0.6
    roles = {d["key"]: d["roles"] for d in data["config"]["dimensions"]}
    assert roles["prio"] == ["accent", "table_group"]
    assert any("перенесены" in warning for warning in data["warnings"])
    moved = (await client.get(f"/cards/{card['id']}")).json()
    assert moved["column"] == "todo"
    assert (await client.put(url, json=CONFIG, headers={"If-Match": '"1"'})).status_code == 409

    created = await add_card(client, board["id"], "С полями", values={"tag": ["a", "b"]}, fields={"pts": 5})
    assert created["values"] == {"tag": ["a", "b"], "prio": ["low"]}
    assert created["fields"] == {"pts": 5}


async def test_config_errors_have_paths(client: Api, board: dict[str, Any]) -> None:
    broken = {**CONFIG, "columns": [{"key": "x", "name": "X", "color": "red"}]}
    response = await client.put(f"/boards/{board['id']}/config", json=broken)
    assert response.status_code == 422
    assert {"path": "columns[0].color", "message": "неверный формат цвета"} in response.json()["error"][
        "details"
    ]


async def test_removed_dimension_clears_card_values(client: Api, board: dict[str, Any]) -> None:
    await client.put(f"/boards/{board['id']}/config", json=CONFIG)
    card = await add_card(client, board["id"], "Карточка", values={"tag": "a"})
    trimmed = {**CONFIG, "dimensions": CONFIG["dimensions"][1:]}
    assert (await client.put(f"/boards/{board['id']}/config", json=trimmed)).status_code == 200
    assert "tag" not in (await client.get(f"/cards/{card['id']}")).json()["values"]


@pytest.mark.parametrize(
    ("payload", "code"),
    [
        ({"values": {"prio": ["low", "high"]}}, "single_value_only"),
        ({"values": {"prio": "nope"}}, "unknown_value"),
        ({"values": {"nope": "low"}}, "unknown_dimension"),
        ({"fields": {"nope": 1}}, "unknown_field"),
        ({"fields": {"pts": 101}}, "invalid_field"),
        ({"fields": {"pts": "text"}}, "invalid_field"),
        ({"fields": {"site": "javascript:alert(1)"}}, "invalid_field"),
    ],
)
async def test_card_value_validation(
    client: Api, board: dict[str, Any], payload: dict[str, Any], code: str
) -> None:
    await client.put(f"/boards/{board['id']}/config", json=CONFIG)
    response = await client.post(
        f"/boards/{board['id']}/cards", json={"title": "x", "column": "todo", **payload}
    )
    assert response.status_code == 422 and response.json()["error"]["code"] == code


async def test_done_rule_sets_and_clears_completed_date(client: Api, board: dict[str, Any]) -> None:
    await client.put(f"/boards/{board['id']}/config", json=CONFIG)
    card = await add_card(client, board["id"], "Карточка")
    moved = (await client.post(f"/cards/{card['id']}/move", json={"column": "done"})).json()
    assert moved["completed_at"] is not None
    back = (await client.post(f"/cards/{card['id']}/move", json={"column": "todo"})).json()
    assert back["completed_at"] is None


async def test_checklists_comments_attachments(client: Api, board: dict[str, Any]) -> None:
    card = await add_card(client, board["id"], "Детали")
    url = f"/cards/{card['id']}"
    checklist = (await client.post(f"{url}/checklists", json={"title": "Шаги"})).json()
    item = (await client.post(f"/checklists/{checklist['id']}/items", json={"text": "Раз"})).json()
    await client.post(f"/checklists/{checklist['id']}/items", json={"text": "Два"})
    assert (await client.patch(f"/checklist-items/{item['id']}", json={"done": True})).json()["done"]
    assert (await client.patch(f"/checklists/{checklist['id']}", json={"title": "Этапы"})).status_code == 200

    comment = (await client.post(f"{url}/comments", json={"body": "Привет"})).json()
    assert comment["author_name"] == "alice"
    edited = await client.patch(f"/comments/{comment['id']}", json={"body": "Пока"})
    assert edited.json()["body"] == "Пока"
    attachment = await client.post(
        f"{url}/attachments", json={"name": "Макет", "url": "https://figma.com/file/1"}
    )
    assert attachment.status_code == 201
    bad = await client.post(f"{url}/attachments", json={"name": "x", "url": "javascript:alert(1)"})
    assert bad.status_code == 422

    full = (await client.get(url)).json()
    assert full["checklist_done"] == 1 and full["checklist_total"] == 2
    assert full["comments_count"] == 1 and full["attachments_count"] == 1
    assert full["checklists"][0]["title"] == "Этапы"

    assert (await client.delete(f"/checklist-items/{item['id']}")).status_code == 200
    assert (await client.delete(f"/checklists/{checklist['id']}")).status_code == 200
    assert (await client.delete(f"/comments/{comment['id']}")).status_code == 200
    assert (await client.delete(f"/attachments/{attachment.json()['id']}")).status_code == 200


async def test_views_crud(client: Api, board: dict[str, Any]) -> None:
    url = f"/boards/{board['id']}/views"
    view = (await client.post(url, json={"key": "mine", "name": "Мои", "is_default": True})).json()
    duplicate = await client.post(url, json={"key": "mine", "name": "Ещё"})
    assert duplicate.status_code == 409
    second = (await client.post(url, json={"key": "two", "name": "Два", "is_default": True})).json()
    views = {v["key"]: v for v in (await client.get(url)).json()}
    assert not views["mine"]["is_default"] and views["two"]["is_default"]
    patched = await client.patch(
        f"/views/{view['id']}",
        json={"key": "mine", "name": "Мои 2", "type": "table", "filters": {"search": "x"}},
    )
    assert patched.json()["filters"]["search"] == "x"
    assert (await client.delete(f"/views/{second['id']}")).status_code == 200


async def test_search(client: Api, board: dict[str, Any]) -> None:
    await add_card(client, board["id"], "Find me please")
    hits = (await client.get("/search", params={"q": "find"})).json()
    assert [hit["type"] for hit in hits] == ["card"]
    literal = (await client.get("/search", params={"q": "%"})).json()
    assert literal == []


async def test_purge_expired(client: Api, board: dict[str, Any], engine: AsyncEngine) -> None:
    card = await add_card(client, board["id"], "Старая")
    await client.delete(f"/cards/{card['id']}")
    async with AsyncSession(engine) as session:
        assert await purge_expired(session, 30) == 0
        await session.execute(update(Card).values(deleted_at=utcnow() - timedelta(days=31)))
        assert await purge_expired(session, 30) == 1
        await session.commit()
    assert (await client.post(f"/cards/{card['id']}/restore")).status_code == 404


async def test_viewer_cannot_write(
    client: Api, other: Api, board: dict[str, Any], engine: AsyncEngine
) -> None:
    async with AsyncSession(engine) as session:
        user = (await session.execute(select(User).where(User.email == "mallory@example.com"))).scalar_one()
        session.add(ProjectMember(project_id=UUID(board["project_id"]), user_id=user.id, role="viewer"))
        await session.commit()
    assert (await other.get(f"/boards/{board['id']}")).json()["role"] == "viewer"
    denied = await other.post(f"/boards/{board['id']}/cards", json={"title": "x", "column": "todo"})
    assert denied.status_code == 403
