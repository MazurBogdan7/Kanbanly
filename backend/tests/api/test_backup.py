import copy
import gzip
import json
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.config import Settings
from app.core.errors import ApiError
from app.models import AuditLog, BackupSnapshot, Project
from app.security import backup_crypto
from app.services import backup as service
from tests.api.test_boards import add_card, all_cards, make_board, make_project
from tests.conftest import Api

VOLATILE = {"source_id", "project_source_id"}


def normalize(value: Any) -> Any:
    """Сравнение слепков: id пересоздаются при импорте, остальное обязано совпасть."""
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items() if k not in VOLATILE}
    if isinstance(value, list):
        return [normalize(item) for item in value]
    return value


def data_of(document: dict[str, Any]) -> Any:
    data = normalize(document["data"])
    return {
        **data,
        "projects": sorted(data["projects"], key=lambda p: p["name"]),
        "boards": sorted(data["boards"], key=lambda b: b["name"]),
        "templates": sorted(data["templates"], key=lambda t: t["name"]),
    }


@pytest.fixture
async def seeded(client: Api) -> dict[str, Any]:
    project = await make_project(client, "Игра")
    board = await make_board(client, project["id"], name="ZIF", preset="zif-gamedev", include_samples=False)
    example = (await client.get("/templates/example")).json()
    rich = await make_board(client, project["id"], name="Пример", template=example)
    second = await make_project(client, "Личное")
    await make_board(client, second["id"], name="Дом", preset="personal")
    card = await add_card(client, board["id"], "С деталями", column="todo", description="Текст")
    checklist = (await client.post(f"/cards/{card['id']}/checklists", json={"title": "Шаги"})).json()
    await client.post(f"/checklists/{checklist['id']}/items", json={"text": "Раз"})
    await client.post(f"/cards/{card['id']}/comments", json={"body": "Комментарий"})
    await client.post(
        f"/cards/{card['id']}/attachments", json={"name": "Файл", "url": "https://example.com/f"}
    )
    await client.post("/templates/from-board", json={"board_id": rich["id"], "name": "Мой шаблон"})
    return {"project": project, "second": second, "board": board, "rich": rich}


async def export(client: Api, **params: Any) -> dict[str, Any]:
    response = await client.get("/export/backup", params=params)
    assert response.status_code == 200, response.text
    return json.loads(response.content)


async def test_export_shape_and_filename(client: Api, seeded: dict[str, Any]) -> None:
    response = await client.get("/export/backup")
    assert "kanbanly-backup-" in response.headers["content-disposition"]
    document = json.loads(response.content)
    assert document["format"] == "kanbanly.backup"
    assert document["checksum"] == service.compute_checksum(document["data"])
    assert document["data"]["profile"]["email"] == "alice@example.com"
    assert len(document["data"]["projects"]) == 2
    assert len(document["data"]["boards"]) == 3
    assert len(document["data"]["templates"]) == 1


async def test_backup_contains_no_secrets(client: Api, seeded: dict[str, Any]) -> None:
    raw = (await client.get("/export/backup")).text
    for forbidden in ("argon2", "password", "totp", "token_hash", "session"):
        assert forbidden not in raw.lower(), forbidden


async def test_scopes(client: Api, seeded: dict[str, Any]) -> None:
    project = await export(client, scope=f"project:{seeded['project']['id']}")
    assert len(project["data"]["projects"]) == 1 and len(project["data"]["boards"]) == 2
    assert project["data"]["templates"] == []
    board = await export(client, scope=f"board:{seeded['board']['id']}")
    assert [b["name"] for b in board["data"]["boards"]] == ["ZIF"]
    assert (await client.get("/export/backup", params={"scope": "bad"})).status_code == 422


async def test_gzip_export_round_trip(client: Api, seeded: dict[str, Any]) -> None:
    response = await client.get("/export/backup", params={"compress": True})
    assert response.headers["content-type"] == "application/gzip"
    assert ".json.gz" in response.headers["content-disposition"]
    raw = response.content
    assert json.loads(gzip.decompress(raw))["format"] == "kanbanly.backup"
    preview = (await client.post("/import/backup/preview", content=raw)).json()
    assert preview["valid"] and preview["counts"]["boards"] == 3


async def test_full_cycle_delete_restore_identical(client: Api, seeded: dict[str, Any]) -> None:
    original = await export(client)
    for project in (seeded["project"], seeded["second"]):
        await client.delete(f"/projects/{project['id']}")
    for template in (await client.get("/templates")).json()["items"]:
        await client.delete(f"/templates/{template['id']}")

    preview = (await client.post("/import/backup/preview", content=json.dumps(original))).json()
    assert preview["valid"] and preview["conflicts"] == []
    assert preview["counts"] == {"projects": 2, "boards": 3, "cards": 10, "templates": 1}
    result = await client.post("/import/backup", content=json.dumps(original))
    assert result.status_code == 200, result.text

    restored = await export(client)
    assert data_of(restored) == data_of(original)
    new_ids = {b["source_id"] for b in restored["data"]["boards"]}
    assert new_ids.isdisjoint({b["source_id"] for b in original["data"]["boards"]})


async def test_copy_mode_keeps_originals(client: Api, seeded: dict[str, Any]) -> None:
    document = await export(client)
    preview = (await client.post("/import/backup/preview", content=json.dumps(document))).json()
    assert {c["name"] for c in preview["conflicts"]} == {"Игра", "Личное", "Мой шаблон"}
    assert (await client.post("/import/backup", content=json.dumps(document))).status_code == 200
    names = sorted(p["name"] for p in (await client.get("/projects")).json()["items"])
    assert names == ["Игра", "Игра (копия)", "Личное", "Личное (копия)"]


async def test_replace_requires_confirmation_and_snapshots(
    client: Api, seeded: dict[str, Any], engine: AsyncEngine
) -> None:
    document = await export(client)
    await add_card(client, seeded["board"]["id"], "После бэкапа", column="todo")
    denied = await client.post("/import/backup", params={"mode": "replace"}, content=json.dumps(document))
    assert denied.status_code == 422 and denied.json()["error"]["code"] == "confirmation_required"
    result = await client.post(
        "/import/backup",
        params={"mode": "replace", "confirm": service.REPLACE_CONFIRMATION},
        content=json.dumps(document),
    )
    assert result.status_code == 200, result.text
    snapshot_id = result.json()["snapshot_id"]
    assert snapshot_id
    assert sorted(p["name"] for p in (await client.get("/projects")).json()["items"]) == ["Игра", "Личное"]
    restored = await export(client)
    assert data_of(restored) == data_of(document)

    snapshot = await client.get(f"/backups/snapshots/{snapshot_id}")
    before_replace = json.loads(gzip.decompress(snapshot.content))
    titles = [c["title"] for b in before_replace["data"]["boards"] for c in b["cards"]]
    assert "После бэкапа" in titles
    history = (await client.get("/backups")).json()
    assert history["snapshots"][0]["id"] == snapshot_id
    assert {e["action"] for e in history["events"]} == {"backup.exported", "backup.imported"}


async def test_replace_board_scope_keeps_siblings(client: Api, seeded: dict[str, Any]) -> None:
    document = await export(client, scope=f"board:{seeded['board']['id']}")
    await add_card(client, seeded["board"]["id"], "Лишняя", column="todo")
    result = await client.post(
        "/import/backup",
        params={"mode": "replace", "confirm": service.REPLACE_CONFIRMATION},
        content=json.dumps(document),
    )
    assert result.status_code == 200, result.text
    project = (await client.get(f"/projects/{seeded['project']['id']}")).json()
    assert sorted(b["name"] for b in project["boards"]) == ["ZIF", "Пример"]
    board_id = next(b["id"] for b in project["boards"] if b["name"] == "ZIF")
    assert [c["title"] for c in await all_cards(client, board_id)] == ["С деталями"]


async def test_import_is_atomic(client: Api, seeded: dict[str, Any], engine: AsyncEngine) -> None:
    document = await export(client)
    broken = copy.deepcopy(document)
    broken["data"]["boards"][-1]["cards"].append(
        {**broken["data"]["boards"][1]["cards"][0], "column": "no-such-column"}
    )
    broken["checksum"] = service.compute_checksum(broken["data"])
    response = await client.post("/import/backup", content=json.dumps(broken))
    assert response.status_code == 422
    async with AsyncSession(engine) as session:
        projects = (await session.execute(select(Project))).scalars().all()
    assert len(projects) == 2


async def test_foreign_backup_lands_in_own_account(client: Api, other: Api, seeded: dict[str, Any]) -> None:
    document = await export(client)
    assert (await other.post("/import/backup", content=json.dumps(document))).status_code == 200
    assert len((await other.get("/projects")).json()["items"]) == 2
    assert len((await client.get("/projects")).json()["items"]) == 2
    assert (await other.get("/auth/me")).json()["email"] == "mallory@example.com"
    assert (await other.get(f"/boards/{seeded['board']['id']}")).status_code == 404


async def test_encrypted_backup_round_trip(client: Api, seeded: dict[str, Any]) -> None:
    response = await client.post(
        "/export/backup", json={"scope": "account", "password": "backup-secret-1", "gzip": True}
    )
    assert response.status_code == 200, response.text
    wrapper = response.json()
    assert wrapper["format"] == "kanbanly.backup.encrypted"
    assert set(wrapper) >= {"ciphertext", "salt", "nonce", "kdf_params"}
    assert "alice@example.com" not in response.text

    locked = (await client.post("/import/backup/preview", content=response.content)).json()
    assert locked["password_required"] and not locked["valid"]
    wrong = await client.post(
        "/import/backup/preview", content=response.content, headers={"X-Backup-Password": "wrong-pass"}
    )
    assert not wrong.json()["valid"]
    bad_import = await client.post(
        "/import/backup", content=response.content, headers={"X-Backup-Password": "wrong-pass"}
    )
    assert bad_import.status_code == 400 and bad_import.json()["error"]["code"] == "wrong_password"
    good = await client.post(
        "/import/backup/preview", content=response.content, headers={"X-Backup-Password": "backup-secret-1"}
    )
    assert good.json()["valid"] and good.json()["encrypted"]


async def test_tampered_ciphertext_detected(client: Api, seeded: dict[str, Any]) -> None:
    wrapper = (await client.post("/export/backup", json={"password": "backup-secret-1"})).json()
    tampered = dict(wrapper)
    tampered["ciphertext"] = ("A" if wrapper["ciphertext"][0] != "A" else "B") + wrapper["ciphertext"][1:]
    response = await client.post(
        "/import/backup", content=json.dumps(tampered), headers={"X-Backup-Password": "backup-secret-1"}
    )
    assert response.status_code == 400
    changed_kdf = {**wrapper, "kdf_params": {**wrapper["kdf_params"], "n": 1 << 14}}
    response = await client.post(
        "/import/backup", content=json.dumps(changed_kdf), headers={"X-Backup-Password": "backup-secret-1"}
    )
    assert response.status_code == 400


async def test_plain_post_export_and_invalid_inputs(client: Api, seeded: dict[str, Any]) -> None:
    response = await client.post("/export/backup", json={"scope": "account"})
    assert json.loads(response.content)["format"] == "kanbanly.backup"
    assert (await client.post("/import/backup", content=b"[]")).status_code == 422
    assert (await client.post("/import/backup", content=b"{}")).status_code == 422
    wrong = {"format": "kanbanly.board-template"}
    assert (await client.post("/import/backup", content=json.dumps(wrong))).json()["error"][
        "code"
    ] == "invalid_format"


async def test_corrupted_file_detected(client: Api, seeded: dict[str, Any]) -> None:
    document = await export(client)
    document["data"]["projects"][0]["name"] = "Подмена"
    response = await client.post("/import/backup", content=json.dumps(document))
    assert response.json()["error"]["code"] == "checksum_mismatch"
    preview = (await client.post("/import/backup/preview", content=json.dumps(document))).json()
    assert not preview["valid"]


async def test_dangling_project_reference(client: Api, seeded: dict[str, Any]) -> None:
    document = await export(client)
    document["data"]["boards"][0]["project_source_id"] = "00000000-0000-7000-8000-000000000000"
    document["checksum"] = service.compute_checksum(document["data"])
    response = await client.post("/import/backup", content=json.dumps(document))
    assert response.status_code == 422
    assert "project_source_id" in response.json()["error"]["details"][0]["path"]


def test_zip_bomb_rejected() -> None:
    settings = Settings(_env_file=None, env="test", backup_max_bytes=1024)
    bomb = gzip.compress(b"0" * 1_000_000)
    assert len(bomb) < 1024 * 2
    with pytest.raises(ApiError) as caught:
        service.read_backup(bomb, settings, None)
    assert caught.value.status == 413


def test_oversized_file_rejected() -> None:
    settings = Settings(_env_file=None, env="test", backup_max_bytes=10)
    with pytest.raises(ApiError) as caught:
        service.read_backup(b"x" * 11, settings, None)
    assert caught.value.status == 413


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        (b"not json", "invalid_json"),
        (b"\x1f\x8b broken gzip", "corrupted_backup"),
        (b"[" * 200_000, "too_deep"),
        (gzip.compress(b"[]"), "invalid_backup"),
        (b'{"format": "kanbanly.backup", "version": 99}', "unsupported_version"),
        (b'{"format": "kanbanly.backup.encrypted"}', "password_required"),
    ],
)
def test_malformed_backups(raw: bytes, code: str) -> None:
    settings = Settings(_env_file=None, env="test")
    with pytest.raises(ApiError) as caught:
        service.read_backup(raw, settings, None)
    assert caught.value.code == code


def test_encrypted_wrapper_validation() -> None:
    settings = Settings(_env_file=None, env="test")
    broken = json.dumps({"format": "kanbanly.backup.encrypted", "salt": "x"}).encode()
    with pytest.raises(ApiError) as missing:
        service.read_backup(broken, settings, "password-1")
    assert missing.value.code == "corrupted_backup"
    wrapper = backup_crypto.encrypt(b"[1]", "password-1")
    with pytest.raises(ApiError) as not_object:
        service.read_backup(json.dumps(wrapper).encode(), settings, "password-1")
    assert not_object.value.code == "invalid_backup"
    for patch in ({"salt": "@@@"}, {"kdf_params": {"algorithm": "scrypt", "n": 3, "r": 8, "p": 1}}):
        with pytest.raises(ApiError) as corrupted:
            service.read_backup(json.dumps({**wrapper, **patch}).encode(), settings, "password-1")
        assert corrupted.value.code == "corrupted_backup"


def test_backup_with_invalid_schema_reports_paths() -> None:
    settings = Settings(_env_file=None, env="test")
    data = {"projects": [{"name": 5}]}
    document = {
        "format": "kanbanly.backup",
        "version": 1,
        "data": data,
        "checksum": service.compute_checksum(data),
    }
    with pytest.raises(ApiError) as caught:
        service.read_backup(json.dumps(document).encode(), settings, None)
    assert caught.value.code == "invalid_backup"
    assert any(item["path"].startswith("data.projects[0]") for item in caught.value.details)


def test_scope_parser_and_filename() -> None:
    assert service.parse_scope("account").label == "account"
    with pytest.raises(ApiError):
        service.parse_scope("project:not-a-uuid")
    with pytest.raises(ApiError):
        service.parse_scope("account:x")
    assert service.backup_filename().startswith("kanbanly-backup-")


async def test_audit_covers_export_import(client: Api, seeded: dict[str, Any], engine: AsyncEngine) -> None:
    document = await export(client)
    await client.post("/import/backup", content=json.dumps(document))
    await client.delete(f"/boards/{seeded['board']['id']}")
    async with AsyncSession(engine) as session:
        actions = set((await session.execute(select(AuditLog.action))).scalars())
        assert {"backup.exported", "backup.imported", "board.deleted"} <= actions
        assert (await session.execute(select(BackupSnapshot))).first() is None


async def test_snapshot_of_foreign_user_hidden(client: Api, other: Api, seeded: dict[str, Any]) -> None:
    document = await export(client)
    result = await client.post(
        "/import/backup",
        params={"mode": "replace", "confirm": service.REPLACE_CONFIRMATION},
        content=json.dumps(document),
    )
    snapshot_id = result.json()["snapshot_id"]
    assert (await other.get(f"/backups/snapshots/{snapshot_id}")).status_code == 404
