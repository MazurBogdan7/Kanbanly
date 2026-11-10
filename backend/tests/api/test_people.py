"""Аватар (виден только коллегам по проекту) и статус: онлайн, занят, офлайн."""

from datetime import timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.db import utcnow
from app.models import UserSession
from tests.api.test_boards import make_project
from tests.conftest import Api

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 32


async def put_avatar(api: Api, data: bytes) -> Any:
    return await api.put(
        "/auth/me/avatar", content=data, headers={"Content-Type": "application/octet-stream"}
    )


async def team(client: Api, other: Api) -> dict[str, Any]:
    project = await make_project(client, "Команда")
    await client.post(f"/projects/{project['id']}/invites", json={"target": "mallory@example.com"})
    [invite] = (await other.get("/me/invites")).json()
    await other.post(f"/me/invites/{invite['id']}/accept")
    return project


async def test_avatar_upload_replace_delete(client: Api) -> None:
    me = (await client.get("/auth/me")).json()
    assert me["avatar_version"] == 0
    saved = await put_avatar(client, PNG)
    assert saved.status_code == 200 and saved.json()["avatar_version"] == 1
    picture = await client.get(f"/users/{me['id']}/avatar")
    assert picture.status_code == 200
    assert picture.headers["content-type"] == "image/png"
    assert picture.headers["x-content-type-options"] == "nosniff"
    assert picture.content == PNG
    assert (await put_avatar(client, WEBP)).json()["avatar_version"] == 2
    assert (await client.get(f"/users/{me['id']}/avatar")).headers["content-type"] == "image/webp"
    assert (await client.delete("/auth/me/avatar")).json()["avatar_version"] == 0
    assert (await client.get(f"/users/{me['id']}/avatar")).status_code == 404


async def test_avatar_rejects_non_images(client: Api) -> None:
    for data, status in (
        (b"", 422),
        (b"<svg onload=alert(1)>", 422),
        (b"GIF89a....", 422),
        (PNG + b"\x00" * (1024 * 1024), 413),
    ):
        assert (await put_avatar(client, data)).status_code == status


async def test_avatar_visible_only_to_teammates(client: Api, other: Api, app: Any) -> None:
    await put_avatar(other, PNG)
    mallory = (await other.get("/auth/me")).json()["id"]
    stranger = Api(app)
    await stranger.register("eve@example.com")
    # Без общего проекта чужой аватар не виден (alice — администратор, ей виден всегда).
    assert (await stranger.get(f"/users/{mallory}/avatar")).status_code == 404
    project = await team(client, other)
    assert (await client.get(f"/users/{mallory}/avatar")).status_code == 200
    members = (await client.get(f"/projects/{project['id']}/members")).json()
    assert {m["email"]: m["avatar_version"] for m in members}["mallory@example.com"] == 1
    assert (await stranger.get(f"/users/{mallory}/avatar")).status_code == 404
    # Стал коллегой — видит.
    await client.post(f"/projects/{project['id']}/invites", json={"target": "eve@example.com"})
    [invite] = (await stranger.get("/me/invites")).json()
    await stranger.post(f"/me/invites/{invite['id']}/accept")
    assert (await stranger.get(f"/users/{mallory}/avatar")).status_code == 200
    await stranger.http.aclose()


async def test_status_online_busy_invisible_offline(client: Api, other: Api, engine: AsyncEngine) -> None:
    project = await team(client, other)

    async def status_of(email: str) -> str:
        members = (await client.get(f"/projects/{project['id']}/members")).json()
        return next(m["status"] for m in members if m["email"] == email)

    assert await status_of("mallory@example.com") == "online"
    assert (await other.patch("/auth/me", json={"presence": "busy"})).json()["presence"] == "busy"
    assert await status_of("mallory@example.com") == "busy"
    await other.patch("/auth/me", json={"presence": "invisible"})
    assert await status_of("mallory@example.com") == "offline"
    await other.patch("/auth/me", json={"presence": "auto"})
    assert await status_of("mallory@example.com") == "online"
    assert (await other.patch("/auth/me", json={"presence": "away"})).status_code == 422

    # Давно не заходил — офлайн, даже если выбран «занят».
    await other.patch("/auth/me", json={"presence": "busy"})
    mallory = (await other.get("/auth/me")).json()["id"]
    async with AsyncSession(engine) as session:
        await session.execute(
            update(UserSession)
            .where(UserSession.user_id == UUID(mallory))
            .values(last_seen_at=utcnow() - timedelta(minutes=10))
        )
        await session.commit()
    assert await status_of("mallory@example.com") == "offline"
    assert await status_of("alice@example.com") == "online"
