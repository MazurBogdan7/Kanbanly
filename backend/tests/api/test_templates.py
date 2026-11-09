import json
from typing import Any

import jsonschema
import pytest

from app.services import presets
from tests.api.test_boards import add_card, all_cards, make_board, make_project
from tests.conftest import Api
from tests.reference import zif_template


@pytest.fixture
async def project(client: Api) -> dict[str, Any]:
    return await make_project(client)


async def test_board_from_zif_preset(client: Api, project: dict[str, Any]) -> None:
    board = await make_board(client, project["id"], name="ZIF", template=zif_template())
    config = board["config"]
    assert [c["name"] for c in config["columns"]] == ["Бэклог", "К работе", "В работе", "Проверка", "Готово"]
    assert config["columns"][4]["card_style"]["title_strikethrough"] is True
    cards = await all_cards(client, board["id"])
    assert len(cards) == 153
    assert sum(c["column"] == "done" for c in cards) == 6
    first = next(c for c in cards if c["title"] == "Первый уровень (прототип)")
    assert first["values"] == {
        "epic": ["level"],
        "milestone": ["m1"],
        "work_type": ["code"],
        "assignee": ["none"],
    }
    roles = {d["key"]: d["roles"] for d in config["dimensions"]}
    assert roles["epic"] == ["accent", "badge", "filter_chips"]
    assert roles["milestone"] == ["badge", "filter_select", "progress"]


@pytest.mark.parametrize("key", ["design-studio", "scrum-lite", "personal", "content-plan"])
async def test_board_from_each_preset(client: Api, project: dict[str, Any], key: str) -> None:
    board = await make_board(client, project["id"], preset=key)
    assert await all_cards(client, board["id"])


async def test_preset_without_samples(client: Api, project: dict[str, Any]) -> None:
    board = await make_board(client, project["id"], preset="personal", include_samples=False)
    assert await all_cards(client, board["id"]) == []


async def test_presets_endpoint(client: Api) -> None:
    listing = (await client.get("/presets")).json()
    assert len(listing) == 4
    # ZIF — шаблон одного заказчика, в общий каталог не входит.
    assert "zif-gamedev" not in {item["key"] for item in listing}
    assert (await client.get("/presets/zif-gamedev")).status_code == 404
    assert (await client.get("/presets/nope")).status_code == 404


async def test_example_downloads_and_imports(client: Api, project: dict[str, Any]) -> None:
    response = await client.get("/templates/example")
    assert "kanbanly-template-example.json" in response.headers["content-disposition"]
    board = await make_board(client, project["id"], template=response.json())
    assert board["warnings"] == []
    cards = await all_cards(client, board["id"])
    full = next(c for c in cards if c["title"] == "Карточка со всеми значениями")
    assert full["fields"]["window"] == {"start": "2027-01-10", "end": "2027-02-20"}
    assert full["values"]["tags"] == ["bug", "idea"]
    assert full["checklist_total"] == 2
    assert len({f["type"] for f in board["config"]["fields"]}) == 11


async def test_export_reimport_is_equivalent(client: Api, project: dict[str, Any]) -> None:
    source = await make_board(client, project["id"], name="Источник", template=zif_template())
    exported = (await client.get(f"/boards/{source['id']}/template", params={"include_cards": True})).json()
    assert len(exported["sample_cards"]) == 153
    clone = await make_board(client, project["id"], name="Копия", template=exported)
    again = (await client.get(f"/boards/{clone['id']}/template", params={"include_cards": True})).json()
    exported["meta"]["name"] = again["meta"]["name"] = ""
    assert exported == again


async def test_import_preview_counts_and_errors(client: Api) -> None:
    good = presets.EXAMPLE_FILE.read_bytes()
    preview = (await client.post("/templates/import/preview", content=good)).json()
    assert preview["valid"] and preview["counts"]["columns"] == 6
    broken = json.loads(good)
    broken["columns"][3]["color"] = "red"
    bad = (await client.post("/templates/import/preview", content=json.dumps(broken))).json()
    assert not bad["valid"]
    assert bad["errors"] == [{"path": "columns[3].color", "message": "неверный формат цвета"}]
    junk = (await client.post("/templates/import/preview", content=b"not json")).json()
    assert junk["errors"][0]["message"] == "Файл не является корректным JSON"


async def test_template_library_crud(client: Api, project: dict[str, Any]) -> None:
    source = await make_board(client, project["id"], preset="personal")
    created = await client.post(
        "/templates/from-board", json={"board_id": source["id"], "name": "Мой", "include_cards": True}
    )
    assert created.status_code == 201
    template = created.json()
    assert len(template["data"]["sample_cards"]) == 3
    url = f"/templates/{template['id']}"
    renamed = await client.patch(url, json={"name": "Новый"}, headers={"If-Match": '"1"'})
    assert renamed.json()["data"]["meta"]["name"] == "Новый"
    assert (await client.patch(url, json={"name": "x"}, headers={"If-Match": '"1"'})).status_code == 409
    duplicate = (await client.post(f"{url}/duplicate")).json()
    assert duplicate["name"] == "Новый (копия)"
    board = await make_board(client, project["id"], template_id=template["id"])
    assert len(await all_cards(client, board["id"])) == 3
    assert (await client.get(f"{url}/download")).json()["meta"]["name"] == "Новый"
    assert (await client.delete(url)).status_code == 200
    assert (await client.get(url)).status_code == 404
    assert [t["id"] for t in (await client.get("/templates")).json()["items"]] == [duplicate["id"]]
    assert (await client.post(f"{url}/restore")).status_code == 200


async def test_import_template_file(client: Api) -> None:
    response = await client.post("/templates/import", content=presets.EXAMPLE_FILE.read_bytes())
    assert response.status_code == 201
    assert response.json()["name"] == "Пример со всеми функциями"


async def test_save_as_template_endpoint(client: Api, project: dict[str, Any]) -> None:
    board = await make_board(client, project["id"], preset="personal")
    saved = await client.post(f"/boards/{board['id']}/template/save", params={"name": "Сохранённый"})
    assert saved.status_code == 201
    assert (await client.get(f"/templates/{saved.json()['id']}")).json()["name"] == "Сохранённый"


async def test_two_source_conflict(client: Api, project: dict[str, Any]) -> None:
    response = await client.post(
        f"/projects/{project['id']}/boards",
        json={"name": "X", "preset": "personal", "template": {"meta": {}}},
    )
    assert response.status_code == 422 and response.json()["error"]["code"] == "ambiguous_source"


async def test_partial_apply_changes_only_its_section(client: Api, project: dict[str, Any]) -> None:
    target = await make_board(client, project["id"], preset="scrum-lite")
    theme_source = zif_template()
    before = target["config"]
    response = await client.post(
        f"/boards/{target['id']}/template/apply", json={"template": theme_source, "parts": ["theme"]}
    )
    after = response.json()["config"]
    assert after["theme"]["tokens"]["accent"] == "#C9A84C"
    for section in ("typography", "layout", "columns", "dimensions"):
        assert after[section] == before[section], section


async def test_partial_typography(client: Api, project: dict[str, Any]) -> None:
    target = await make_board(client, project["id"], preset="scrum-lite")
    source = zif_template()
    after = (
        await client.post(
            f"/boards/{target['id']}/template/apply", json={"template": source, "parts": ["typography"]}
        )
    ).json()["config"]
    assert after["typography"]["board_title"]["font"] == "Cormorant SC"
    assert after["theme"] == target["config"]["theme"]


async def test_partial_structure_prunes_dangling_layout(client: Api, project: dict[str, Any]) -> None:
    target = await make_board(client, project["id"], template=zif_template(), include_samples=False)
    source = (await client.get("/presets/personal")).json()["data"]
    response = await client.post(
        f"/boards/{target['id']}/template/apply", json={"template": source, "parts": ["structure"]}
    )
    assert response.status_code == 200, response.text
    config = response.json()["config"]
    assert [d["key"] for d in config["dimensions"]] == ["area"]
    assert config["layout"]["card"]["badges"] == []
    assert config["theme"]["tokens"]["accent"] == "#C9A84C"


async def test_unknown_part_rejected(client: Api, project: dict[str, Any]) -> None:
    target = await make_board(client, project["id"], preset="personal")
    source = (await client.get("/presets/personal")).json()["data"]
    response = await client.post(
        f"/boards/{target['id']}/template/apply", json={"template": source, "parts": ["secrets"]}
    )
    assert response.status_code == 422


@pytest.mark.parametrize("part", ["theme", "typography", "layout", "structure"])
async def test_partial_export_is_valid_template(client: Api, project: dict[str, Any], part: str) -> None:
    board = await make_board(client, project["id"], preset="personal")
    document = (await client.get(f"/boards/{board['id']}/template", params={"part": part})).json()
    preview = (await client.post("/templates/import/preview", content=json.dumps(document))).json()
    assert preview["valid"], preview
    assert "sample_cards" not in document


async def test_reset_to_template(client: Api, project: dict[str, Any]) -> None:
    board = await make_board(client, project["id"], preset="personal")
    config = json.loads(json.dumps(board["config"]))
    config["theme"]["tokens"]["accent"] = "#000000"
    config["columns"][0]["name"] = "Изменено"
    await client.put(f"/boards/{board['id']}/config", json=config)
    await add_card(client, board["id"], "Новая", column="inbox")
    reset = await client.post(f"/boards/{board['id']}/reset", json={"cards": False})
    assert reset.json()["config"]["columns"][0]["name"] == "Входящие"
    assert reset.json()["config"]["theme"]["tokens"]["accent"] != "#000000"
    assert len(await all_cards(client, board["id"])) == 4
    await client.post(f"/boards/{board['id']}/reset", json={"cards": True})
    assert len(await all_cards(client, board["id"])) == 3


def _template_schema() -> dict[str, Any]:
    from scripts.export_schemas import schemas

    return schemas()["board-template.schema.json"]


@pytest.mark.parametrize("path", sorted(presets.PRESETS_DIR.glob("preset-*.json")), ids=lambda p: p.stem)
def test_presets_valid_against_generated_json_schema(path: Any) -> None:
    document = json.loads(path.read_text(encoding="utf-8"))
    jsonschema.validate(document, _template_schema())


def test_example_valid_against_generated_json_schema() -> None:
    jsonschema.validate(presets.example_document(), _template_schema())
