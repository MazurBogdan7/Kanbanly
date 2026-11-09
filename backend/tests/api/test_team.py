"""Ник, приглашения во входящие (принять, отклонить, пригласить снова), исполнитель, бэкапы в админке."""

import csv
import io
import json
from typing import Any

import pytest

from tests.api.test_boards import add_card, make_board, make_project
from tests.conftest import Api


async def set_nick(api: Api, nick: str) -> Any:
    return await api.patch("/auth/me", json={"username": nick})


@pytest.fixture
async def stranger(app: Any) -> Any:
    api = Api(app)
    await api.register("eve@example.com")
    yield api
    await api.http.aclose()


async def test_username_rules(client: Api, other: Api) -> None:
    response = await set_nick(client, "  @Alice_Dev ")
    assert response.status_code == 200 and response.json()["username"] == "alice_dev"
    assert (await set_nick(other, "ALICE_DEV")).json()["error"]["code"] == "username_taken"
    for bad in ("ab", "-start", "кириллица", "with space", "x" * 33):
        response = await set_nick(other, bad)
        assert response.status_code == 422, bad
    assert (await set_nick(client, "")).json()["username"] is None
    # Освободившийся ник можно занять.
    assert (await set_nick(other, "alice_dev")).status_code == 200


async def test_invite_by_nick_lands_in_inbox(client: Api, other: Api, stranger: Api) -> None:
    await set_nick(other, "mallory")
    project = await make_project(client, "Игра")
    sent = await client.post(
        f"/projects/{project['id']}/invites", json={"target": "@Mallory", "role": "viewer"}
    )
    assert sent.status_code == 201, sent.text
    assert sent.json()["invitee_username"] == "mallory"
    assert sent.json()["email"] == "mallory@example.com"

    inbox = (await other.get("/me/invites")).json()
    assert [(i["project_name"], i["role"], i["inviter"]) for i in inbox] == [("Игра", "viewer", "alice")]
    # Чужое приглашение не видно и не принимается.
    assert (await stranger.get("/me/invites")).json() == []
    assert (await stranger.post(f"/me/invites/{inbox[0]['id']}/accept")).status_code == 404

    joined = await other.post(f"/me/invites/{inbox[0]['id']}/accept")
    assert joined.status_code == 200 and joined.json()["role"] == "viewer"
    assert (await other.get("/me/invites")).json() == []
    assert (await other.post(f"/me/invites/{inbox[0]['id']}/accept")).status_code == 404
    members = (await client.get(f"/projects/{project['id']}/members")).json()
    assert {m["username"] for m in members} == {None, "mallory"}
    again = await client.post(f"/projects/{project['id']}/invites", json={"target": "mallory"})
    assert again.json()["error"]["code"] == "already_member"


async def test_decline_and_invite_again(client: Api, other: Api) -> None:
    project = await make_project(client, "Сайт")
    # Зарегистрированный по email тоже получает приглашение во входящие.
    await client.post(f"/projects/{project['id']}/invites", json={"target": "mallory@example.com"})
    [invite] = (await other.get("/me/invites")).json()
    assert (await other.post(f"/me/invites/{invite['id']}/decline")).status_code == 200
    assert (await other.get("/me/invites")).json() == []
    [owner_view] = (await client.get(f"/projects/{project['id']}/invites")).json()
    assert owner_view["status"] == "declined"
    assert owner_view["invitee_name"] == "mallory"

    # Случайно отклонили — владелец отправляет ещё раз.
    resent = await client.post(f"/projects/{project['id']}/invites", json={"target": "mallory@example.com"})
    assert resent.status_code == 201
    assert [i["status"] for i in (await client.get(f"/projects/{project['id']}/invites")).json()] == [
        "pending"
    ]
    [fresh] = (await other.get("/me/invites")).json()
    assert (await other.post(f"/me/invites/{fresh['id']}/accept")).status_code == 200


async def test_invite_errors(client: Api) -> None:
    project = await make_project(client)
    missing = await client.post(f"/projects/{project['id']}/invites", json={"target": "nobody"})
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "user_not_found"
    myself = await client.post(f"/projects/{project['id']}/invites", json={"target": "alice@example.com"})
    assert myself.json()["error"]["code"] == "already_member"
    empty = await client.post(f"/projects/{project['id']}/invites", json={"role": "editor"})
    assert empty.status_code == 422
    # Старый формат с полем email продолжает работать.
    legacy = await client.post(f"/projects/{project['id']}/invites", json={"email": "new@example.com"})
    assert legacy.status_code == 201 and legacy.json()["invitee_name"] is None


async def _member_project(client: Api, other: Api) -> tuple[dict[str, Any], dict[str, Any], str]:
    project = await make_project(client, "Команда")
    board = await make_board(client, project["id"], preset="personal", include_samples=False)
    await client.post(f"/projects/{project['id']}/invites", json={"target": "mallory@example.com"})
    [invite] = (await other.get("/me/invites")).json()
    await other.post(f"/me/invites/{invite['id']}/accept")
    mallory = next(
        m["user_id"]
        for m in (await client.get(f"/projects/{project['id']}/members")).json()
        if m["email"] == "mallory@example.com"
    )
    return project, board, mallory


async def test_assignee_must_be_member(client: Api, other: Api, stranger: Api) -> None:
    project, board, mallory = await _member_project(client, other)
    column = board["config"]["columns"][0]["key"]
    card = await add_card(client, board["id"], "Задача", column=column, assignee_id=mallory)
    assert card["assignee_id"] == mallory
    me = (await stranger.get("/auth/me")).json()["id"]
    bad = await client.patch(f"/cards/{card['id']}", json={"assignee_id": me})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "unknown_assignee"
    cleared = await client.patch(f"/cards/{card['id']}", json={"assignee_id": None})
    assert cleared.json()["assignee_id"] is None
    # Поле без assignee_id не трогает исполнителя.
    await client.patch(f"/cards/{card['id']}", json={"assignee_id": mallory})
    kept = await client.patch(f"/cards/{card['id']}", json={"title": "Новое имя"})
    assert kept.json()["assignee_id"] == mallory

    activity = (await client.get(f"/cards/{card['id']}/activity")).json()["items"]
    assert any("assignee_id" in event["data"].get("fields", []) for event in activity)

    table = (await client.get(f"/boards/{board['id']}/export.csv")).content.decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(table), delimiter=";"))
    assert rows[0]["Исполнитель"] == "mallory"

    # Участник ушёл из проекта — назначение снимается.
    await other.delete(f"/projects/{project['id']}/members/{mallory}")
    [after] = (await client.get(f"/boards/{board['id']}/cards")).json()["items"]
    assert after["assignee_id"] is None


async def test_assignee_survives_backup(client: Api) -> None:
    project = await make_project(client)
    board = await make_board(client, project["id"], preset="personal", include_samples=False)
    me = (await client.get("/auth/me")).json()["id"]
    column = board["config"]["columns"][0]["key"]
    await add_card(client, board["id"], "Моя", column=column, assignee_id=me)
    raw = (await client.get("/export/backup", params={"scope": f"board:{board['id']}"})).content
    assert json.loads(raw)["data"]["boards"][0]["cards"][0]["assignee_email"] == "alice@example.com"
    target = await make_project(client, "Копия")
    imported = await client.post(
        f"/projects/{target['id']}/boards/import",
        content=raw,
        headers={"X-File-Name": "b.json", "Content-Type": "application/octet-stream"},
    )
    copy = imported.json()["boards"][0]
    [card] = (await client.get(f"/boards/{copy['id']}/cards")).json()["items"]
    assert card["assignee_id"] == me


async def test_admin_downloads_foreign_boards(client: Api, other: Api) -> None:
    # alice зарегистрирована первой — она администратор.
    project = await make_project(other, "Чужой проект")
    board = await make_board(other, project["id"], name="Секретная доска", preset="personal")
    assert (await other.get("/admin/boards")).status_code == 404

    listing = (await client.get("/admin/boards", params={"q": "Секрет"})).json()["items"]
    assert [(b["name"], b["project_name"], b["owner_email"]) for b in listing] == [
        ("Секретная доска", "Чужой проект", "mallory@example.com")
    ]
    assert listing[0]["cards"] > 0

    response = await client.get(f"/admin/boards/{board['id']}/backup")
    assert response.status_code == 200
    assert "attachment" in response.headers["content-disposition"]
    document = json.loads(response.content)
    assert [b["name"] for b in document["data"]["boards"]] == ["Секретная доска"]
    # Бэкап из админки восстанавливается как обычный.
    target = await make_project(client, "Разбор")
    restored = await client.post(
        f"/projects/{target['id']}/boards/import",
        content=response.content,
        headers={"X-File-Name": "b.json", "Content-Type": "application/octet-stream"},
    )
    assert restored.status_code == 201

    owner = listing[0]["owner_id"]
    account = json.loads((await client.get(f"/admin/users/{owner}/backup")).content)
    assert [p["name"] for p in account["data"]["projects"]] == ["Чужой проект"]
    assert (await other.get(f"/admin/users/{owner}/backup")).status_code == 404
    assert (await client.get("/admin/boards/00000000-0000-0000-0000-000000000000/backup")).status_code == 404

    events = [e["action"] for e in (await client.get("/admin/audit")).json()]
    assert "admin.board_exported" in events and "admin.user_exported" in events
