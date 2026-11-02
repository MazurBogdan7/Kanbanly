"""Общая инфраструктура тестов.

По умолчанию — SQLite в памяти. С TEST_DATABASE_URL тот же набор идёт на PostgreSQL
(scripts/test_postgres.py поднимает встроенный сервер, CI — сервис postgres).
"""

import os
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool, StaticPool

from app.core.config import Settings
from app.core.db import Base, create_engine
from app.main import create_app
from app.services.mailer import MemoryMailer

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
STRONG_PASSWORD = "correct-horse-battery-7"


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "env": "test",
        "database_url": TEST_DATABASE_URL or "sqlite+aiosqlite://",
        "secret_key": "test-secret-key-test-secret-key-test-secret",
        "rate_limit_attempts": 5,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


class Api:
    """Клиент как браузер: cookie сессии плюс CSRF-заголовок."""

    def __init__(self, app: Any) -> None:
        self.app = app
        self.http = httpx.AsyncClient(transport=ASGITransport(app=app), base_url="https://test")
        self.csrf: str | None = None

    async def _ensure_csrf(self) -> None:
        if self.http.cookies.get("kanbanly_csrf") is None:
            await self.http.get("/api/v1/auth/csrf")

    async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        await self._ensure_csrf()
        headers = dict(kwargs.pop("headers", {}))
        headers.setdefault("X-CSRF-Token", self.http.cookies.get("kanbanly_csrf") or "")
        path = url if url.startswith("/api/") else f"/api/v1{url}"
        return await self.http.request(method, path, headers=headers, **kwargs)

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("POST", url, **kwargs)

    async def patch(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("PATCH", url, **kwargs)

    async def put(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("PUT", url, **kwargs)

    async def delete(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("DELETE", url, **kwargs)

    async def register(
        self, email: str = "user@example.com", password: str = STRONG_PASSWORD
    ) -> dict[str, Any]:
        response = await self.post("/auth/register", json={"email": email, "password": password})
        assert response.status_code == 201, response.text
        return response.json()


@pytest.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    if TEST_DATABASE_URL:
        test_engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
        async with test_engine.begin() as connection:
            await connection.execute(text("DROP SCHEMA public CASCADE"))
            await connection.execute(text("CREATE SCHEMA public"))
    else:
        test_engine = create_async_engine(
            "sqlite+aiosqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
        )
        _ = create_engine  # тот же PRAGMA foreign_keys, что и в приложении
        from sqlalchemy import event

        @event.listens_for(test_engine.sync_engine, "connect")
        def _fk(dbapi_connection: Any, _record: Any) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    async with test_engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield test_engine
    await test_engine.dispose()


@pytest.fixture
def mailer() -> MemoryMailer:
    return MemoryMailer()


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest.fixture
def app(engine: AsyncEngine, settings: Settings, mailer: MemoryMailer) -> Any:
    return create_app(settings, engine=engine, mailer=mailer)


@pytest.fixture
async def anon(app: Any) -> AsyncIterator[Api]:
    api = Api(app)
    yield api
    await api.http.aclose()


@pytest.fixture
async def client(app: Any) -> AsyncIterator[Api]:
    api = Api(app)
    await api.register("alice@example.com")
    yield api
    await api.http.aclose()


@pytest.fixture
async def other(app: Any) -> AsyncIterator[Api]:
    api = Api(app)
    await api.register("mallory@example.com")
    yield api
    await api.http.aclose()
