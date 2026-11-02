"""Свойство: экспорт → импорт → экспорт даёт эквивалентные данные."""

import json
from typing import Any

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.core.db import Base
from app.main import create_app
from app.services.mailer import MemoryMailer
from tests.api.test_backup import data_of
from tests.api.test_boards import make_board, make_project
from tests.conftest import Api, make_settings

keys = st.text(alphabet="abcdefghij0123456789", min_size=1, max_size=8).filter(lambda k: k[0].isalpha())
text = st.text(alphabet=st.characters(blacklist_categories=("Cs", "Cc")), min_size=1, max_size=30).filter(
    lambda s: s.strip() == s
)
colors = st.from_regex(r"\A#[0-9A-F]{6}\Z")
kinds = st.sampled_from(["backlog", "todo", "in_progress", "review", "done", "custom"])


@st.composite
def templates(draw: Any) -> dict[str, Any]:
    column_keys = draw(st.lists(keys, min_size=1, max_size=4, unique=True))
    columns = [
        {
            "key": key,
            "name": draw(text),
            "kind": draw(kinds),
            "wip_limit": draw(st.one_of(st.none(), st.integers(1, 9))),
            "color": draw(st.one_of(st.none(), colors, st.just("{accent}"))),
        }
        for key in column_keys
    ]
    dimensions = []
    for key in draw(st.lists(keys, max_size=3, unique=True)):
        values = [
            {"key": v, "name": draw(text), "color": draw(st.one_of(st.none(), colors))}
            for v in draw(st.lists(keys, min_size=1, max_size=4, unique=True))
        ]
        dimensions.append(
            {
                "key": key,
                "name": draw(text),
                "type": draw(st.sampled_from(["select", "multi_select", "ordered_select", "user"])),
                "values": values,
            }
        )
    cards = []
    for number in range(draw(st.integers(0, 6))):
        values: dict[str, Any] = {}
        for dimension in dimensions:
            if draw(st.booleans()):
                choice = draw(st.sampled_from(dimension["values"]))["key"]
                values[dimension["key"]] = [choice] if dimension["type"] == "multi_select" else choice
        cards.append(
            {
                "key": f"c{number}",
                "column": draw(st.sampled_from(column_keys)),
                "title": draw(text),
                "description": draw(
                    st.text(alphabet=st.characters(exclude_categories=("Cs", "Cc")), max_size=40)
                ),
                "values": values,
            }
        )
    return {
        "format": "kanbanly.board-template",
        "version": 1,
        "meta": {"name": "Шаблон"},
        "theme": {"mode": draw(st.sampled_from(["light", "dark"])), "tokens": {"accent": draw(colors)}},
        "columns": columns,
        "dimensions": dimensions,
        "sample_cards": cards,
    }


@settings(max_examples=25, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(document=templates())
async def test_backup_round_trip_preserves_everything(engine: Any, document: dict[str, Any]) -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.drop_all)
        await connection.run_sync(Base.metadata.create_all)
    app = create_app(make_settings(rate_limit_attempts=10_000), engine=engine, mailer=MemoryMailer())
    api = Api(app)
    await api.register("prop@example.com")
    project = await make_project(api, "P")
    await make_board(api, project["id"], name="B", template=document)

    first = json.loads((await api.get("/export/backup")).content)
    assert (await api.delete(f"/projects/{project['id']}")).status_code == 200
    restored = await api.post("/import/backup", content=json.dumps(first))
    assert restored.status_code == 200, restored.text
    second = json.loads((await api.get("/export/backup")).content)
    assert data_of(first) == data_of(second)
    await api.http.aclose()


@settings(max_examples=25, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(document=templates())
async def test_template_export_import_is_stable(engine: Any, document: dict[str, Any]) -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.drop_all)
        await connection.run_sync(Base.metadata.create_all)
    app = create_app(make_settings(rate_limit_attempts=10_000), engine=engine, mailer=MemoryMailer())
    api = Api(app)
    await api.register("prop@example.com")
    project = await make_project(api, "P")
    board = await make_board(api, project["id"], name="B", template=document)
    exported = (await api.get(f"/boards/{board['id']}/template", params={"include_cards": True})).json()
    clone = await make_board(api, project["id"], name="B", template=exported)
    again = (await api.get(f"/boards/{clone['id']}/template", params={"include_cards": True})).json()
    assert exported == again
    await api.http.aclose()
