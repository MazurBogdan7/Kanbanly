import csv
import io
import re
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.db import utcnow
from app.models import ProjectInvite, UserSession
from app.services.mailer import MemoryMailer
from tests.api.test_boards import add_card, make_board, make_project
from tests.conftest import Api
from tests.reference import zif_template


def token_of(link: str) -> str:
    return link.rsplit("/", 1)[-1]


@pytest.fixture
async def shared(client: Api, other: Api) -> dict[str, Any]:
    project = await make_project(client, "Общий")
    board = await make_board(client, project["id"], name="Доска")
    invite = await client.post(
        f"/projects/{project['id']}/invites", json={"email": "Mallory@Example.com", "role": "editor"}
    )
    assert invite.status_code == 201, invite.text
    return {"project": project, "board": board, "invite": invite.json()}


async def test_invite_flow(client: Api, other: Api, shared: dict[str, Any], mailer: MemoryMailer) -> None:
    link = shared["invite"]["link"]
    assert shared["invite"]["email"] == "mallory@example.com"
    assert link in mailer.sent[-1]["body"]
    token = token_of(link)

    preview = (await other.get(f"/invites/{token}")).json()
    assert preview["project_name"] == "Общий" and preview["role"] == "editor"
    assert preview["inviter"] == "alice"
    accepted = await other.post(f"/invites/{token}/accept")
    assert accepted.status_code == 200 and accepted.json()["role"] == "editor"

    assert (await other.get(f"/boards/{shared['board']['id']}")).status_code == 200
    card = await add_card(other, shared["board"]["id"], "От участника")
    assert card["title"] == "От участника"
    assert (await other.post(f"/invites/{token}/accept")).status_code == 404, "ссылка одноразовая"

    members = (await client.get(f"/projects/{shared['project']['id']}/members")).json()
    assert {(m["email"], m["role"], m["is_you"]) for m in members} == {
        ("alice@example.com", "owner", True),
        ("mallory@example.com", "editor", False),
    }


async def test_invite_only_for_its_email(client: Api, shared: dict[str, Any], app: Any) -> None:
    stranger = Api(app)
    await stranger.register("eve@example.com")
    token = token_of(shared["invite"]["link"])
    assert (await stranger.get(f"/invites/{token}")).status_code == 404
    assert (await stranger.post(f"/invites/{token}/accept")).status_code == 404
    assert (await stranger.get(f"/boards/{shared['board']['id']}")).status_code == 404
    await stranger.http.aclose()


async def test_expired_and_revoked_invites(
    client: Api, other: Api, shared: dict[str, Any], engine: AsyncEngine
) -> None:
    project_id = shared["project"]["id"]
    pending = (await client.get(f"/projects/{project_id}/invites")).json()
    assert [item["email"] for item in pending] == ["mallory@example.com"]
    assert pending[0]["link"] is None, "ссылка показывается только при создании"

    async with AsyncSession(engine) as session:
        await session.execute(update(ProjectInvite).values(expires_at=utcnow() - timedelta(minutes=1)))
        await session.commit()
    assert (await other.post(f"/invites/{token_of(shared['invite']['link'])}/accept")).status_code == 404

    fresh = (
        await client.post(f"/projects/{project_id}/invites", json={"email": "mallory@example.com"})
    ).json()
    assert (await client.delete(f"/projects/{project_id}/invites/{fresh['id']}")).status_code == 200
    assert (await other.get(f"/invites/{token_of(fresh['link'])}")).status_code == 404


async def test_new_invite_replaces_old_link(client: Api, other: Api, shared: dict[str, Any]) -> None:
    project_id = shared["project"]["id"]
    second = (
        await client.post(
            f"/projects/{project_id}/invites", json={"email": "mallory@example.com", "role": "viewer"}
        )
    ).json()
    assert (await other.get(f"/invites/{token_of(shared['invite']['link'])}")).status_code == 404
    accepted = await other.post(f"/invites/{token_of(second['link'])}/accept")
    assert accepted.json()["role"] == "viewer"


async def test_roles_and_leaving(client: Api, other: Api, shared: dict[str, Any]) -> None:
    project_id = shared["project"]["id"]
    await other.post(f"/invites/{token_of(shared['invite']['link'])}/accept")
    me = (await other.get("/auth/me")).json()
    owner = (await client.get("/auth/me")).json()

    viewer = await client.patch(f"/projects/{project_id}/members/{me['id']}", json={"role": "viewer"})
    assert viewer.json()["role"] == "viewer"
    denied = await other.post(f"/boards/{shared['board']['id']}/cards", json={"title": "x", "column": "todo"})
    assert denied.status_code == 403
    assert (
        await other.post(f"/projects/{project_id}/invites", json={"email": "x@example.com"})
    ).status_code == 403
    assert (await other.delete(f"/projects/{project_id}/members/{owner['id']}")).status_code == 403
    assert (
        await client.patch(f"/projects/{project_id}/members/{owner['id']}", json={"role": "viewer"})
    ).status_code == 409
    assert (
        await client.patch(f"/projects/{project_id}/members/{me['id']}", json={"role": "owner"})
    ).status_code == 422
    assert (await client.delete(f"/projects/{project_id}/members/{owner['id']}")).status_code == 409

    assert (await other.delete(f"/projects/{project_id}/members/{me['id']}")).status_code == 200
    assert (await other.get(f"/boards/{shared['board']['id']}")).status_code == 404


async def test_owner_removes_member(client: Api, other: Api, shared: dict[str, Any]) -> None:
    project_id = shared["project"]["id"]
    await other.post(f"/invites/{token_of(shared['invite']['link'])}/accept")
    me = (await other.get("/auth/me")).json()
    assert (await client.delete(f"/projects/{project_id}/members/{me['id']}")).status_code == 200
    assert (await other.get(f"/projects/{project_id}")).status_code == 404


async def test_cannot_invite_existing_member(client: Api, shared: dict[str, Any]) -> None:
    response = await client.post(
        f"/projects/{shared['project']['id']}/invites", json={"email": "alice@example.com"}
    )
    assert response.status_code == 409


async def test_mail_failure_still_returns_link(client: Api, mailer: MemoryMailer, monkeypatch: Any) -> None:
    async def broken(*_: Any) -> None:
        raise OSError("smtp down")

    monkeypatch.setattr(mailer, "send", broken)
    project = await make_project(client)
    invite = await client.post(f"/projects/{project['id']}/invites", json={"email": "new@example.com"})
    assert invite.status_code == 201 and re.search(r"/invite/[\w-]+$", invite.json()["link"])


async def test_revision_changes_with_any_board_activity(client: Api) -> None:
    project = await make_project(client)
    board = await make_board(client, project["id"])
    url = f"/boards/{board['id']}/revision"

    async def revision() -> str:
        return str((await client.get(url)).json()["revision"])

    seen = {await revision()}
    card = await add_card(client, board["id"], "Карточка")
    seen.add(await revision())
    checklist = (await client.post(f"/cards/{card['id']}/checklists", json={"title": "Шаги"})).json()
    item = (await client.post(f"/checklists/{checklist['id']}/items", json={"text": "Пункт"})).json()
    seen.add(await revision())
    await client.patch(f"/checklist-items/{item['id']}", json={"done": True})
    seen.add(await revision())
    await client.post(f"/cards/{card['id']}/comments", json={"body": "Привет"})
    seen.add(await revision())
    await client.post(f"/cards/{card['id']}/move", json={"column": "done"})
    seen.add(await revision())
    await client.patch(f"/boards/{board['id']}", json={"name": "Другое"})
    seen.add(await revision())
    assert len(seen) == 7
    assert await revision() == await revision(), "без изменений метка стабильна"


async def test_csv_export(client: Api) -> None:
    project = await make_project(client)
    board = await make_board(client, project["id"], preset="design-studio")
    await add_card(
        client, board["id"], '=HYPERLINK("http://evil")', column="brief", description="Строка; с разделителем"
    )
    response = await client.get(f"/boards/{board['id']}/export.csv")
    assert response.headers["content-type"].startswith("text/csv")
    assert "attachment" in response.headers["content-disposition"]
    text = response.content.decode("utf-8")
    assert text.startswith("﻿")
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿")), delimiter=";"))
    assert rows[0][:5] == ["Название", "Описание", "Колонка", "Тип работ", "Платформа"]
    assert len(rows) == 1 + 6
    injected = next(row for row in rows if "HYPERLINK" in row[0])
    assert injected[0].startswith("'=")
    assert injected[1] == "Строка; с разделителем"
    assert rows[1][2] == "Бриф"


async def test_session_cookie_renewed_on_activity(client: Api, engine: AsyncEngine) -> None:
    quiet = await client.get("/auth/me")
    assert not any(h.startswith("kanbanly_session") for h in quiet.headers.get_list("set-cookie"))
    async with AsyncSession(engine) as session:
        await session.execute(update(UserSession).values(last_seen_at=utcnow() - timedelta(days=3)))
        await session.commit()
    active = await client.get("/auth/me")
    renewed = [h for h in active.headers.get_list("set-cookie") if h.startswith("kanbanly_session")]
    assert renewed and "Max-Age=604800" in renewed[0]


async def test_csv_archive_of_all_boards(client: Api, other: Api) -> None:
    import zipfile

    mine = await make_project(client, "Игра: релиз/2026")
    await make_board(client, mine["id"], name="ZIF", template=zif_template())
    await make_board(client, mine["id"], name="ZIF", preset="personal")
    await make_board(client, mine["id"], name="Пустая")
    foreign = await make_project(other, "Студия")
    await make_board(other, foreign["id"], name="Макеты", preset="design-studio")
    invite = await other.post(f"/projects/{foreign['id']}/invites", json={"email": "alice@example.com"})
    await client.post(f"/invites/{token_of(invite.json()['link'])}/accept")

    response = await client.get("/export/csv")
    assert response.headers["content-type"] == "application/zip"
    assert "kanbanly-tables-" in response.headers["content-disposition"]
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert sorted(archive.namelist()) == [
        "Игра_ релиз_2026/ZIF (2).csv",
        "Игра_ релиз_2026/ZIF.csv",
        "Игра_ релиз_2026/Пустая.csv",
        "Студия/Макеты.csv",
    ]
    rows = {name: archive.read(name).decode("utf-8") for name in archive.namelist()}
    assert all(text.startswith("﻿") for text in rows.values())
    assert sum(len(text.strip().split("\r\n")) - 1 for text in rows.values()) == 153 + 3 + 0 + 5

    project_only = zipfile.ZipFile(
        io.BytesIO((await client.get("/export/csv", params={"scope": f"project:{foreign['id']}"})).content)
    )
    assert project_only.namelist() == ["Студия/Макеты.csv"]


async def test_csv_archive_of_foreign_scope_is_hidden(client: Api, other: Api) -> None:
    project = await make_project(client, "Секрет")
    board = await make_board(client, project["id"])
    for scope in (f"project:{project['id']}", f"board:{board['id']}"):
        assert (await other.get("/export/csv", params={"scope": scope})).status_code == 404
    empty = (await other.get("/export/csv")).content
    import zipfile

    assert zipfile.ZipFile(io.BytesIO(empty)).namelist() == []
