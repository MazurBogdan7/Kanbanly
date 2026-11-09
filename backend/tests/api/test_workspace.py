"""Блокировка входа, админка, теги, цвета карточек, документы проекта."""

import io
import json
import re
import zipfile
from typing import Any
from urllib.parse import quote

import pytest
from openpyxl import Workbook  # type: ignore[import-untyped]

from app.main import create_app
from app.services.mailer import MemoryMailer
from tests.api.test_backup import data_of
from tests.api.test_boards import add_card, make_board, make_project
from tests.conftest import STRONG_PASSWORD, Api, make_settings

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def docx(body_xml: str) -> bytes:
    """Минимальный корректный .docx: mammoth читает document.xml."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>",
        )
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            "</Relationships>",
        )
        archive.writestr(
            "word/document.xml",
            '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body>{body_xml}</w:body></w:document>",
        )
    return buffer.getvalue()


def xlsx() -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "План"
    sheet.append(["Задача", "Срок"])
    sheet.append(["<script>alert(1)</script>", "2026-12-01"])
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


async def upload(api: Api, project_id: str, filename: str, data: bytes, **params: str) -> Any:
    return await api.post(
        f"/projects/{project_id}/documents",
        content=data,
        params=params,
        headers={"X-File-Name": quote(filename), "Content-Type": "application/octet-stream"},
    )


@pytest.fixture
def settings() -> Any:
    """Счётчик блокировки проверяется без вмешательства ограничителя частоты."""
    return make_settings(rate_limit_attempts=1000)


# ---------- вход и блокировка ----------


async def test_first_user_is_admin_and_registration_can_close(anon: Api, app: Any) -> None:
    assert (await anon.get("/auth/registration")).json() == {"open": True}
    first = await anon.register("boss@example.com")
    assert first["is_admin"] is True
    second = Api(app)
    assert (await second.register("worker@example.com"))["is_admin"] is False
    assert (await anon.put("/admin/settings", json={"registration_open": False})).status_code == 200
    third = Api(app)
    closed = await third.post("/auth/register", json={"email": "x@example.com", "password": STRONG_PASSWORD})
    assert closed.status_code == 403 and closed.json()["error"]["code"] == "registration_closed"
    assert (await third.get("/auth/registration")).json() == {"open": False}
    await second.http.aclose()
    await third.http.aclose()


async def test_account_locks_after_threshold(client: Api, anon: Api, mailer: MemoryMailer) -> None:
    wrong = {"email": "alice@example.com", "password": "wrong-password-1"}
    for _ in range(19):
        assert (await anon.post("/auth/login", json=wrong)).status_code == 401
    locked = await anon.post("/auth/login", json=wrong)
    assert locked.status_code == 423
    message = locked.json()["error"]["message"]
    assert "администратор" in message and "20" in message
    right = await anon.post("/auth/login", json={**wrong, "password": STRONG_PASSWORD})
    assert right.status_code == 423, "верный пароль не снимает блокировку"

    await anon.post("/auth/password-reset/request", json={"email": "alice@example.com"})
    token = re.search(r"token=([\w\-]+)", mailer.sent[-1]["body"]).group(1)  # type: ignore[union-attr]
    new_password = "fresh-password-after-lock"
    await anon.post("/auth/password-reset/confirm", json={"token": token, "new_password": new_password})
    assert (await anon.post("/auth/login", json={**wrong, "password": new_password})).status_code == 200


async def test_success_resets_failure_counter(client: Api, anon: Api) -> None:
    wrong = {"email": "alice@example.com", "password": "wrong-password-1"}
    for _ in range(15):
        await anon.post("/auth/login", json=wrong)
    assert (await anon.post("/auth/login", json={**wrong, "password": STRONG_PASSWORD})).status_code == 200
    for _ in range(15):
        assert (await anon.post("/auth/login", json=wrong)).status_code == 401


async def test_admin_unlocks_disables_and_manages(client: Api, other: Api, app: Any) -> None:
    """client (alice) — первый пользователь и администратор, other (mallory) — обычный."""
    assert (await other.get("/admin/stats")).status_code == 404
    victim = (await other.get("/auth/me")).json()
    stranger = Api(app)
    for _ in range(20):
        await stranger.post(
            "/auth/login", json={"email": "mallory@example.com", "password": "nope-nope-nope"}
        )
    users = (await client.get("/admin/users", params={"q": "mallory"})).json()["items"]
    assert [(u["email"], u["locked"], u["failed_logins"]) for u in users] == [
        ("mallory@example.com", True, 20)
    ]
    assert (await client.post(f"/admin/users/{victim['id']}/unlock")).json()["locked"] is False
    login = {"email": "mallory@example.com", "password": STRONG_PASSWORD}
    assert (await stranger.post("/auth/login", json=login)).status_code == 200

    disabled = await client.patch(f"/admin/users/{victim['id']}", json={"is_active": False})
    assert disabled.json()["is_active"] is False
    assert (await other.get("/auth/me")).status_code == 401, "сессии отключённого не действуют"
    refused = await stranger.post("/auth/login", json=login)
    assert refused.status_code == 403 and "администратор" in refused.json()["error"]["message"]
    await client.patch(f"/admin/users/{victim['id']}", json={"is_active": True, "is_admin": True})
    assert (await stranger.post("/auth/login", json=login)).json()["is_admin"] is True

    me = (await client.get("/auth/me")).json()
    assert (await client.patch(f"/admin/users/{me['id']}", json={"is_admin": False})).status_code == 409
    assert (await client.post(f"/admin/users/{victim['id']}/logout-all")).status_code == 200
    assert (await stranger.get("/auth/me")).status_code == 401
    bad = await client.request(
        "DELETE", f"/admin/users/{victim['id']}", json={"confirm_email": "x@example.com"}
    )
    assert bad.status_code == 422
    ok = await client.request(
        "DELETE", f"/admin/users/{victim['id']}", json={"confirm_email": "Mallory@example.com"}
    )
    assert ok.status_code == 200
    stats = (await client.get("/admin/stats")).json()
    assert stats["users"] == 1 and stats["admins"] == 1
    actions = [event["action"] for event in (await client.get("/admin/audit")).json()]
    assert {"auth.locked", "admin.user_unlocked", "admin.user_deleted"} <= set(actions)
    await stranger.http.aclose()


async def test_cli_make_admin(client: Api, other: Api, app: Any) -> None:
    from app import cli

    engine = app.state.engine
    assert await cli.run("make-admin", "Mallory@example.com", engine) == 0
    assert (await other.get("/auth/me")).json()["is_admin"] is True
    assert await cli.run("make-admin", "nobody@example.com", engine) == 1
    assert await cli.run("bad-command", "mallory@example.com", engine) == 2


# ---------- теги и цвета ----------


@pytest.fixture
async def project(client: Api) -> dict[str, Any]:
    return await make_project(client, "Рабочий")


async def test_project_tags_on_cards(client: Api, other: Api, project: dict[str, Any]) -> None:
    board = await make_board(client, project["id"])
    url = f"/projects/{project['id']}/tags"
    urgent = (await client.post(url, json={"name": "Срочно", "color": "#c92a2a"})).json()
    assert urgent["color"] == "#C92A2A"
    design = (await client.post(url, json={"name": "Дизайн", "color": "#3B5BDB"})).json()
    assert (await client.post(url, json={"name": "Срочно", "color": "#000000"})).status_code == 409
    assert (await client.post(url, json={"name": "X", "color": "red"})).status_code == 422

    card = await add_card(client, board["id"], "С тегами", tags=[urgent["id"], design["id"]], color="#FFE8A3")
    assert card["tags"] == [urgent["id"], design["id"]] and card["color"] == "#FFE8A3"
    updated = (
        await client.patch(f"/cards/{card['id']}", json={"tags": [design["id"]], "color": None})
    ).json()
    assert updated["tags"] == [design["id"]] and updated["color"] is None
    assert (await client.patch(f"/cards/{card['id']}", json={"color": "#12"})).status_code == 422

    foreign_project = await make_project(other, "Чужой")
    foreign = (
        await other.post(
            f"/projects/{foreign_project['id']}/tags", json={"name": "Чужой", "color": "#000000"}
        )
    ).json()
    bad = await client.patch(f"/cards/{card['id']}", json={"tags": [foreign["id"]]})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "unknown_tag"

    renamed = (await client.patch(f"/tags/{design['id']}", json={"name": "UI"})).json()
    assert renamed["name"] == "UI"
    assert (await client.delete(f"/tags/{design['id']}")).status_code == 200
    assert (await client.get(f"/cards/{card['id']}")).json()["tags"] == []
    assert [t["name"] for t in (await client.get(url)).json()] == ["Срочно"]


# ---------- документы ----------


def test_sanitize_keeps_only_embedded_images() -> None:
    from app.services.documents import sanitize

    html = sanitize(
        '<img src="https://evil.example/p.png"><img src="data:image/png;base64,AA" alt="x">'
        '<a href="data:text/html,x">a</a><a href="https://ok.example">b</a><script>x</script>'
    )
    assert "evil.example" not in html and "data:image/png;base64,AA" in html
    assert "data:text" not in html and "https://ok.example" in html and "<script" not in html


async def test_document_kinds_and_previews(client: Api, project: dict[str, Any]) -> None:
    pid = project["id"]
    cases = {
        "ТЗ.docx": (docx("<w:p><w:r><w:t>Техническое задание</w:t></w:r></w:p>"), "docx", "html"),
        "План.xlsx": (xlsx(), "xlsx", "html"),
        "notes.md": ("# Заголовок\n\nТекст".encode(), "markdown", "markdown"),
        "log.txt": (b"plain text", "text", "text"),
        "spec.pdf": (b"%PDF-1.4\n%fake", "pdf", "pdf"),
        "shot.png": (PNG, "png", "image"),
        "evil.svg": (b"<svg onload=alert(1)></svg>", "file", "none"),
        "page.html": (b"<script>alert(1)</script>", "file", "none"),
        "fake.docx": (b"<html>not a zip</html>", "file", "none"),
    }
    for name, (data, kind, preview_kind) in cases.items():
        response = await upload(client, pid, name, data)
        assert response.status_code == 201, (name, response.text)
        document = response.json()
        assert document["current"]["kind"] == kind, name
        assert document["current"]["uploader_name"] == "alice"
        preview = (await client.get(f"/documents/{document['id']}/versions/1/preview")).json()
        assert preview["kind"] == preview_kind, name
        if name == "ТЗ.docx":
            assert "Техническое задание" in preview["html"]
        if name == "План.xlsx":
            assert "<script>" not in preview["html"] and "&lt;script&gt;" in preview["html"]
            assert "<table>" in preview["html"]
    listing = (await client.get(f"/projects/{pid}/documents")).json()
    assert len(listing) == len(cases)


async def test_docx_html_is_sanitized(client: Api, project: dict[str, Any]) -> None:
    body = "<w:p><w:r><w:t>&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;x&lt;/script&gt;</w:t></w:r></w:p>"
    document = (await upload(client, project["id"], "x.docx", docx(body))).json()
    html = (await client.get(f"/documents/{document['id']}/versions/1/preview")).json()["html"]
    assert "<img" not in html and "<script" not in html
    assert "&lt;img" in html


async def test_content_headers_never_render_untrusted_files(client: Api, project: dict[str, Any]) -> None:
    page = (await upload(client, project["id"], "page.html", b"<script>alert(1)</script>")).json()
    response = await client.get(f"/documents/{page['id']}/versions/1/content", params={"inline": True})
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-disposition"].startswith("attachment")
    assert "sandbox" in response.headers["content-security-policy"]
    assert response.headers["x-content-type-options"] == "nosniff"

    image = (await upload(client, project["id"], "Схема.png", PNG)).json()
    shown = await client.get(f"/documents/{image['id']}/versions/1/content", params={"inline": True})
    assert shown.headers["content-type"] == "image/png"
    assert shown.headers["content-disposition"].startswith("inline")
    assert "filename*=UTF-8''%D0%A1%D1%85%D0%B5%D0%BC%D0%B0.png" in shown.headers["content-disposition"]
    assert shown.content == PNG


async def test_versions_history_and_metadata(client: Api, other: Api, project: dict[str, Any]) -> None:
    pid = project["id"]
    created = (await upload(client, pid, "spec.txt", b"v1", name="ТЗ", description="Исходное")).json()
    assert created["name"] == "ТЗ" and created["description"] == "Исходное"
    url = f"/documents/{created['id']}"
    second = await client.post(
        f"{url}/versions", content=b"v2", headers={"X-File-Name": "spec-v2.txt", "Content-Type": "text/plain"}
    )
    assert second.status_code == 201
    detail = second.json()
    assert [v["number"] for v in detail["versions"]] == [2, 1]
    assert detail["current"]["filename"] == "spec-v2.txt"
    assert (await client.get(f"{url}/versions/1/content")).content == b"v1"
    assert (await client.get(f"{url}/versions/2/content")).content == b"v2"
    assert (await client.get(f"{url}/versions/3/content")).status_code == 404

    tag = (await client.post(f"/projects/{pid}/tags", json={"name": "ТЗ", "color": "#2F9E44"})).json()
    patched = (
        await client.patch(url, json={"name": "ТЗ v2", "description": "Обновлено", "tags": [tag["id"]]})
    ).json()
    assert patched["tags"] == [tag["id"]] and patched["name"] == "ТЗ v2"

    comment = (await client.post(f"{url}/comments", json={"body": "Проверьте раздел 3"})).json()
    assert comment["author_name"] == "alice"
    assert (await client.get(url)).json()["comments"][0]["body"] == "Проверьте раздел 3"

    invite = await client.post(f"/projects/{pid}/invites", json={"email": "mallory@example.com"})
    await other.post(f"/invites/{invite.json()['link'].rsplit('/', 1)[-1]}/accept")
    own = (await other.post(f"{url}/comments", json={"body": "Ок"})).json()
    assert own["author_name"] == "mallory"
    assert (await other.patch(f"/document-comments/{comment['id']}", json={"body": "x"})).status_code == 403
    assert (await other.delete(f"/document-comments/{comment['id']}")).status_code == 403
    assert (await client.delete(f"/document-comments/{own['id']}")).status_code == 200, "владелец модерирует"

    assert (await client.delete(url)).status_code == 200
    assert (await client.get(url)).status_code == 404
    trash = (await client.get("/trash")).json()
    assert any(item["type"] == "document" and item["name"] == "ТЗ v2" for item in trash)
    assert (await client.post(f"{url}/restore")).status_code == 200


async def test_viewer_reads_but_cannot_change_documents(
    client: Api, other: Api, project: dict[str, Any]
) -> None:
    pid = project["id"]
    document = (await upload(client, pid, "a.txt", b"text")).json()
    invite = await client.post(
        f"/projects/{pid}/invites", json={"email": "mallory@example.com", "role": "viewer"}
    )
    await other.post(f"/invites/{invite.json()['link'].rsplit('/', 1)[-1]}/accept")
    assert (await other.get(f"/documents/{document['id']}")).json()["role"] == "viewer"
    assert (await other.get(f"/documents/{document['id']}/versions/1/content")).content == b"text"
    assert (await upload(other, pid, "b.txt", b"x")).status_code == 403
    assert (await other.post(f"/documents/{document['id']}/comments", json={"body": "x"})).status_code == 403


async def test_upload_limits_and_validation(engine: Any, mailer: MemoryMailer) -> None:
    app = create_app(make_settings(file_max_bytes=64), engine=engine, mailer=mailer)
    api = Api(app)
    await api.register("owner@example.com")
    project = await make_project(api)
    assert (await upload(api, project["id"], "big.txt", b"x" * 65)).status_code == 413
    assert (await upload(api, project["id"], "empty.txt", b"")).status_code == 422
    missing = await api.post(f"/projects/{project['id']}/documents", content=b"x")
    assert missing.json()["error"]["code"] == "filename_required"
    await api.http.aclose()


async def test_zip_bomb_docx_is_not_parsed(client: Api, project: dict[str, Any]) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", b"0" * (210 * 1024 * 1024))
    document = (await upload(client, project["id"], "bomb.docx", buffer.getvalue())).json()
    preview = (await client.get(f"/documents/{document['id']}/versions/1/preview")).json()
    assert preview == {"kind": "none", "html": None, "text": None, "reason": "unsafe_archive"}


async def test_backup_keeps_tags_colors_and_documents(client: Api, project: dict[str, Any]) -> None:
    pid = project["id"]
    board = await make_board(client, pid, preset="personal", include_samples=False)
    tag = (await client.post(f"/projects/{pid}/tags", json={"name": "Срочно", "color": "#C92A2A"})).json()
    await add_card(client, board["id"], "Цветная", column="inbox", color="#FFE8A3", tags=[tag["id"]])
    document = (await upload(client, pid, "ТЗ.docx", docx("<w:p><w:r><w:t>ТЗ</w:t></w:r></w:p>"))).json()
    await client.post(
        f"/documents/{document['id']}/versions", content=b"v2", headers={"X-File-Name": "tz.txt"}
    )
    await client.patch(f"/documents/{document['id']}", json={"tags": [tag["id"]], "description": "Главный"})
    await client.post(f"/documents/{document['id']}/comments", json={"body": "Замечание"})

    original = json.loads((await client.get("/export/backup")).content)
    files = original["data"]["projects"][0]["documents"]
    assert [v["filename"] for v in files[0]["versions"]] == ["ТЗ.docx", "tz.txt"]
    assert (await client.delete(f"/projects/{pid}")).status_code == 200
    restored = await client.post("/import/backup", content=json.dumps(original))
    assert restored.status_code == 200, restored.text
    assert restored.json()["counts"]["documents"] == 1
    again = json.loads((await client.get("/export/backup")).content)
    assert data_of(again) == data_of(original)

    new_project = (await client.get("/projects")).json()["items"][0]
    new_doc = (await client.get(f"/projects/{new_project['id']}/documents")).json()[0]
    detail = (await client.get(f"/documents/{new_doc['id']}")).json()
    assert detail["description"] == "Главный" and len(detail["tags"]) == 1
    assert (await client.get(f"/documents/{new_doc['id']}/versions/1/preview")).json()["kind"] == "html"
    card = (await client.get(f"/boards/{new_project['boards'][0]['id']}/cards")).json()["items"][0]
    assert card["color"] == "#FFE8A3" and len(card["tags"]) == 1
