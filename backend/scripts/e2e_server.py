"""API и собранный фронт на временной SQLite: запуск для Playwright и локального просмотра."""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

import uvicorn

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from app.core.config import Settings  # noqa: E402
from app.core.db import Base, create_engine  # noqa: E402
from app.main import create_app  # noqa: E402
from app.services.mailer import FileMailer  # noqa: E402


def main() -> None:
    port = int(os.environ.get("PORT", "8123"))
    directory = Path(tempfile.mkdtemp(prefix="kanbanly-e2e-"))
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        env="test",
        database_url=f"sqlite+aiosqlite:///{(directory / 'e2e.sqlite').as_posix()}",
        secret_key="e2e-secret-key-e2e-secret-key-e2e-secret-key",  # noqa: S106
        cookie_secure=False,
        rate_limit_attempts=10_000,
        static_dir=BACKEND.parent / "frontend" / "dist",
        public_url=f"http://127.0.0.1:{port}",
    )
    engine = create_engine(settings.database_url)

    async def prepare() -> None:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(prepare())
    mail_dir = Path(os.environ.get("E2E_MAIL_DIR", directory / "mail"))
    app = create_app(settings, engine=engine, mailer=FileMailer(mail_dir))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
