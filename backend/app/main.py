"""Сборка приложения."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import FileResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.api import admin, auth, backup, boards, cards, misc, people, projects, templates, workspace
from app.core.config import Settings, get_settings
from app.core.db import create_engine, create_session_factory
from app.core.errors import install_error_handlers, not_found
from app.core.logging import configure_logging
from app.core.middleware import BodyGuardMiddleware, CSRFMiddleware, SecurityHeadersMiddleware
from app.core.ratelimit import RateLimiter
from app.services.mailer import Mailer, build_mailer
from app.services.trash import purge_loop


def create_app(
    settings: Settings | None = None, engine: AsyncEngine | None = None, mailer: Mailer | None = None
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging()
    engine = engine or create_engine(settings.database_url)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        purge = asyncio.create_task(purge_loop(app.state.session_factory, settings.trash_retention_days))
        yield
        purge.cancel()
        await engine.dispose()

    is_prod = settings.env == "prod"
    app = FastAPI(
        title="Kanbanly API",
        version="1.0.0",
        lifespan=lifespan,
        openapi_url=None if is_prod else "/api/v1/openapi.json",
        docs_url=None if is_prod else "/api/v1/docs",
        redoc_url=None,
        # Одна схема на чтение и запись: TS-типы шаблона не раздваиваются.
        separate_input_output_schemas=False,
    )
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_factory = create_session_factory(engine)
    app.state.limiter = RateLimiter(settings.rate_limit_attempts, settings.rate_limit_window_seconds)
    app.state.mailer = mailer or build_mailer(settings)

    app.add_middleware(BodyGuardMiddleware, settings=settings)
    app.add_middleware(CSRFMiddleware, settings=settings)
    app.add_middleware(SecurityHeadersMiddleware, settings=settings)
    install_error_handlers(app)

    api = APIRouter(prefix="/api/v1")

    @api.get("/health", tags=["system"])
    async def health(request: Request) -> dict[str, str]:
        async with request.app.state.session_factory() as session:
            await session.execute(text("SELECT 1"))
        return {"status": "ok"}

    for module in (auth, people, projects, boards, cards, templates, backup, workspace, admin, misc):
        api.include_router(module.router)
    app.include_router(api)

    if settings.static_dir is not None:
        _mount_spa(app, settings.static_dir)
    return app


def _mount_spa(app: FastAPI, root: Path) -> None:
    """Раздача собранного фронта одним процессом: запуск без Docker и e2e с настоящим CSP."""
    resolved_root = root.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        if path.startswith("api/"):
            raise not_found()
        candidate = (resolved_root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(resolved_root):
            return FileResponse(candidate)
        return FileResponse(resolved_root / "index.html")


def app_factory() -> FastAPI:
    return create_app()
