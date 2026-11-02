"""Встроенный PostgreSQL для машин без Docker: pgserver из dev-зависимостей.

uv run python scripts/pg.py test [аргументы pytest]   прогнать тесты на Postgres
uv run python scripts/pg.py migrate                   применить миграции
uv run python scripts/pg.py revision "сообщение"      автогенерация миграции
uv run python scripts/pg.py serve                     держать сервер и печатать URL
"""

import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pgserver

DATA_DIR = Path(tempfile.gettempdir()) / "kanbanly-pg"


def urls() -> tuple[object, str]:
    server = pgserver.get_server(DATA_DIR, cleanup_mode="stop")
    sync_uri: str = server.get_uri()
    server.psql("SELECT 1;")
    return server, sync_uri.replace("postgresql://", "postgresql+asyncpg://", 1)


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "test"
    server, url = urls()
    print(f"PostgreSQL: {url}", flush=True)
    env = {**os.environ, "KANBANLY_DATABASE_URL": url, "TEST_DATABASE_URL": url}
    try:
        if command == "test":
            return subprocess.call(["pytest", *sys.argv[2:]], env=env)
        if command == "migrate":
            return subprocess.call(["alembic", "upgrade", "head"], env=env)
        if command == "revision":
            return subprocess.call(["alembic", "revision", "--autogenerate", "-m", sys.argv[2]], env=env)
        if command == "verify":
            server.psql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")  # type: ignore[attr-defined]
            for step in (["upgrade", "head"], ["check"], ["downgrade", "base"], ["upgrade", "head"]):
                code = subprocess.call(["alembic", *step], env=env)
                if code:
                    return code
            return 0
        if command == "serve":
            while True:
                time.sleep(3600)
    finally:
        del server
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
