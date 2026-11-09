"""Изоляция данных: чужой ресурс → 404 по каждому эндпоинту с идентификатором.

Список роутов берётся из приложения: новый эндпоинт автоматически попадает в проверку,
а эндпоинт с неизвестным параметром роняет тест, пока его не добавят в подстановки.
"""

import json
import re
from typing import Any

import pytest

from tests.api.test_boards import add_card, make_board, make_project
from tests.api.test_document_images import PNG, docx_with_images
from tests.conftest import Api

# Параметр пути → ключ в словаре ресурсов жертвы.
PARAMS = {
    "project_id": "project",
    "board_id": "board",
    "card_id": "card",
    "view_id": "view",
    "checklist_id": "checklist",
    "item_id": "item",
    "comment_id": "comment",
    "attachment_id": "attachment",
    "template_id": "template",
    "session_id": "session",
    "snapshot_id": "snapshot",
    "user_id": "member",
    "invite_id": "invite",
    "token": "invite_token",
    "tag_id": "tag",
    "document_id": "document",
    "number": "version",
    "index": "image",
    "document_comment_id": "document_comment",
}
DELETE_BODIES: dict[str, Any] = {
    "/auth/me": {"password": "x"},
    "/admin/users/{user_id}": {"confirm_email": "x@example.com"},
}
# Ссылка-приглашение выписана на чужой email: владелец проекта её тоже не откроет.
OWNER_EXEMPT = {"/invites/{token}"}
# Минимальные валидные тела: 404 должен случиться раньше прочих проверок, но 422 на схеме
# запроса скрыл бы ошибку, поэтому тела настоящие.
BODIES: dict[str, Any] = {
    "/projects/{project_id}": {"name": "x"},
    "/projects/{project_id}/boards": {"name": "x"},
    "/boards/{board_id}": {"name": "x"},
    "/boards/{board_id}/config": {"columns": [{"key": "a", "name": "A"}]},
    "/boards/{board_id}/template/apply": {
        "template": {"meta": {"name": "x"}, "columns": [{"key": "a", "name": "A"}]},
        "parts": ["theme"],
    },
    "/boards/{board_id}/reset": {"cards": False},
    "/boards/{board_id}/cards": {"title": "x", "column": "todo"},
    "/boards/{board_id}/views": {"key": "x", "name": "x"},
    "/views/{view_id}": {"key": "x", "name": "x"},
    "/cards/{card_id}": {"title": "x"},
    "/cards/{card_id}/move": {"column": "todo"},
    "/cards/{card_id}/checklists": {"title": "x"},
    "/checklists/{checklist_id}": {"title": "x"},
    "/checklists/{checklist_id}/items": {"text": "x"},
    "/checklist-items/{item_id}": {"done": True},
    "/cards/{card_id}/comments": {"body": "x"},
    "/comments/{comment_id}": {"body": "x"},
    "/cards/{card_id}/attachments": {"name": "x", "url": "https://example.com"},
    "/templates/{template_id}": {"name": "x"},
    "/projects/{project_id}/members/{user_id}": {"role": "viewer"},
    "/projects/{project_id}/invites": {"email": "x@example.com", "role": "editor"},
    "/projects/{project_id}/tags": {"name": "x", "color": "#112233"},
    "/tags/{tag_id}": {"name": "x"},
    "/documents/{document_id}": {"name": "x"},
    "/documents/{document_id}/comments": {"body": "x"},
    "/document-comments/{document_comment_id}": {"body": "x"},
    "/admin/users/{user_id}": {"is_active": False},
}


def all_routes(app: Any) -> list[tuple[str, str]]:
    return [
        (method.upper(), path.removeprefix("/api/v1"))
        for path, operations in app.openapi()["paths"].items()
        for method in operations
    ]


def routes_with_ids(app: Any) -> list[tuple[str, str]]:
    return [(m, p) for m, p in all_routes(app) if "{" in p and p != "/presets/{key}"]


@pytest.fixture
async def victim(client: Api) -> dict[str, str]:
    project = await make_project(client, "Секрет")
    board = await make_board(client, project["id"])
    card = await add_card(client, board["id"], "Тайная карточка")
    view = (await client.post(f"/boards/{board['id']}/views", json={"key": "v", "name": "V"})).json()
    checklist = (await client.post(f"/cards/{card['id']}/checklists", json={"title": "C"})).json()
    item = (await client.post(f"/checklists/{checklist['id']}/items", json={"text": "I"})).json()
    comment = (await client.post(f"/cards/{card['id']}/comments", json={"body": "B"})).json()
    attachment = (
        await client.post(f"/cards/{card['id']}/attachments", json={"name": "A", "url": "https://e.com/a"})
    ).json()
    template = (
        await client.post("/templates/from-board", json={"board_id": board["id"], "name": "T"})
    ).json()
    session = (await client.get("/auth/sessions")).json()[0]
    document = (await client.get("/export/backup")).content
    snapshot = (
        await client.post(
            "/import/backup", params={"mode": "replace", "confirm": "ЗАМЕНИТЬ"}, content=document
        )
    ).json()["snapshot_id"]
    project = (await client.get("/projects")).json()["items"][0]
    board_id = project["boards"][0]["id"]
    card_id = (await client.get(f"/boards/{board_id}/cards")).json()["items"][0]["id"]
    # Импорт пересоздал id: собираем дочерние сущности для актуальной карточки.
    view = (await client.post(f"/boards/{board_id}/views", json={"key": "w", "name": "W"})).json()
    checklist = (await client.post(f"/cards/{card_id}/checklists", json={"title": "C"})).json()
    item = (await client.post(f"/checklists/{checklist['id']}/items", json={"text": "I"})).json()
    comment = (await client.post(f"/cards/{card_id}/comments", json={"body": "B"})).json()
    attachment = (
        await client.post(f"/cards/{card_id}/attachments", json={"name": "A", "url": "https://e.com/a"})
    ).json()
    template = (await client.get("/templates")).json()["items"][0]
    member = (await client.get("/auth/me")).json()
    invite = (
        await client.post(f"/projects/{project['id']}/invites", json={"email": "bob@example.com"})
    ).json()
    tag = (
        await client.post(f"/projects/{project['id']}/tags", json={"name": "Секрет", "color": "#112233"})
    ).json()
    document = (
        await client.post(
            f"/projects/{project['id']}/documents",
            # Word с картинкой: проверяется и выдача картинок из документа.
            content=docx_with_images({"image1.png": PNG + b"secret"}),
            headers={"X-File-Name": "secret.docx", "Content-Type": "application/octet-stream"},
        )
    ).json()
    document_comment = (
        await client.post(f"/documents/{document['id']}/comments", json={"body": "Тайный"})
    ).json()
    return {
        "tag": tag["id"],
        "document": document["id"],
        "version": "1",
        "image": "0",
        "document_comment": document_comment["id"],
        "member": member["id"],
        "invite": invite["id"],
        "invite_token": invite["link"].rsplit("/", 1)[-1],
        "project": project["id"],
        "board": board_id,
        "card": card_id,
        "view": view["id"],
        "checklist": checklist["id"],
        "item": item["id"],
        "comment": comment["id"],
        "attachment": attachment["id"],
        "template": template["id"],
        "session": session["id"],
        "snapshot": snapshot,
    }


def fill(path: str, resources: dict[str, str]) -> str:
    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        assert name in PARAMS, f"Новый параметр пути {name}: добавьте его в PARAMS"
        return resources[PARAMS[name]]

    return re.sub(r"\{(\w+)\}", replace, path)


async def test_every_id_route_hides_foreign_resources(
    app: Any, client: Api, other: Api, victim: dict[str, str]
) -> None:
    routes = routes_with_ids(app)
    assert len(routes) >= 45
    failures = []
    for method, path in routes:
        kwargs: dict[str, Any] = {}
        if method in {"POST", "PATCH", "PUT"}:
            if path in BODIES:
                kwargs["json"] = BODIES[path]
        elif method == "DELETE" and path in DELETE_BODIES:
            kwargs["json"] = DELETE_BODIES[path]
        response = await other.request(method, fill(path, victim), **kwargs)
        if response.status_code != 404:
            failures.append(f"{method} {path} → {response.status_code} {response.text[:120]}")
        elif "Секрет" in response.text or "Тайная" in response.text:
            failures.append(f"{method} {path} раскрывает данные")
    assert failures == []


async def test_missing_ids_are_indistinguishable_from_foreign(app: Any, client: Api) -> None:
    missing = "00000000-0000-7000-8000-000000000000"
    for method, path in routes_with_ids(app):
        kwargs: dict[str, Any] = {}
        if method in {"POST", "PATCH", "PUT"} and path in BODIES:
            kwargs["json"] = BODIES[path]
        elif method == "DELETE" and path in DELETE_BODIES:
            kwargs["json"] = DELETE_BODIES[path]
        # Номер версии и картинки — числа, остальные параметры — несуществующий UUID.
        target = re.sub(r"\{(\w+)\}", lambda m: "1" if m.group(1) in {"number", "index"} else missing, path)
        response = await client.request(method, target, **kwargs)
        assert response.status_code == 404, f"{method} {path}: {response.status_code}"
        assert response.json()["error"]["message"] == "Не найдено"


async def test_owner_still_reaches_get_routes(app: Any, client: Api, victim: dict[str, str]) -> None:
    """Контроль теста: те же URL работают у владельца, значит 404 выше — не из-за опечаток."""
    for method, path in routes_with_ids(app):
        if method == "GET" and path not in OWNER_EXEMPT:
            response = await client.get(fill(path, victim))
            assert response.status_code == 200, f"{path}: {response.status_code}"


async def test_anonymous_gets_401_everywhere(app: Any, anon: Api, victim: dict[str, str]) -> None:
    public = {
        "/health",
        "/auth/csrf",
        "/auth/register",
        "/auth/login",
        "/auth/password-strength",
        "/auth/password-reset/request",
        "/auth/password-reset/confirm",
        "/auth/registration",
    }
    routes = [(m, p) for m, p in all_routes(app) if p not in public]
    assert len(routes) >= 70
    for method, path in routes:
        target = fill(path, victim) if "{" in path and path != "/presets/{key}" else path
        response = await anon.request(method, target, json=BODIES.get(path, {}))
        assert response.status_code in {401, 422}, f"{method} {path}: {response.status_code}"
        if method == "GET":
            assert response.status_code == 401, path


async def test_every_mutating_route_requires_csrf(app: Any, client: Api, victim: dict[str, str]) -> None:
    routes = [(m, p) for m, p in all_routes(app) if m in {"POST", "PUT", "PATCH", "DELETE"}]
    assert len(routes) >= 45
    for method, path in routes:
        target = fill(path, victim) if "{" in path else path
        response = await client.http.request(method, f"/api/v1{target}", json=BODIES.get(path, {}))
        assert response.status_code == 403, f"{method} {path}: {response.status_code}"
        assert response.json()["error"]["code"] == "csrf_failed"


async def test_lists_never_contain_foreign_data(client: Api, other: Api, victim: dict[str, str]) -> None:
    assert (await other.get("/projects")).json()["items"] == []
    assert (await other.get("/templates")).json()["items"] == []
    assert (await other.get("/trash")).json() == []
    assert (await other.get("/search", params={"q": "Тайная"})).json() == []
    backup = json.loads((await other.get("/export/backup")).content)
    assert backup["data"]["projects"] == [] and backup["data"]["boards"] == []


async def test_foreign_scope_in_backup(other: Api, victim: dict[str, str]) -> None:
    for scope in (f"board:{victim['board']}", f"project:{victim['project']}"):
        assert (await other.get("/export/backup", params={"scope": scope})).status_code == 404
        response = await other.post("/export/backup", json={"scope": scope})
        assert response.status_code == 404


async def test_foreign_ids_in_bodies_are_rejected(other: Api, victim: dict[str, str]) -> None:
    project = await make_project(other)
    stolen = await other.post(
        f"/projects/{project['id']}/boards", json={"name": "x", "template_id": victim["template"]}
    )
    assert stolen.status_code == 404
    template = await other.post("/templates/from-board", json={"board_id": victim["board"], "name": "x"})
    assert template.status_code == 404


async def test_move_cannot_reference_foreign_cards(other: Api, victim: dict[str, str]) -> None:
    project = await make_project(other)
    board = await make_board(other, project["id"])
    card = await add_card(other, board["id"], "Своя")
    response = await other.post(
        f"/cards/{card['id']}/move", json={"column": "todo", "before_id": victim["card"]}
    )
    assert response.status_code == 409


XSS = ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "javascript:alert(1)", "{{7*7}}"]


@pytest.mark.parametrize("payload", XSS)
async def test_xss_payloads_stored_as_inert_json(client: Api, payload: str) -> None:
    project = await make_project(client, payload)
    board = await make_board(client, project["id"], name=payload)
    card = await add_card(client, board["id"], payload, description=payload)
    response = await client.get(f"/cards/{card['id']}")
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.json()["title"] == payload


async def test_template_import_rejects_oversized_payload(client: Api, settings: Any) -> None:
    response = await client.post(
        "/templates/import/preview", content=b" " * (settings.template_max_bytes + 1)
    )
    assert response.status_code == 413
