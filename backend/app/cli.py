"""Команды обслуживания сервера.

    python -m app.cli make-admin EMAIL     выдать права администратора
    python -m app.cli unlock EMAIL         снять блокировку после неудачных входов

В Docker: docker compose exec api .venv/bin/python -m app.cli make-admin you@example.com
"""

import asyncio
import sys

from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import get_settings
from app.core.db import create_engine, create_session_factory
from app.services import auth


async def run(command: str, email: str, engine: AsyncEngine | None = None) -> int:
    own = engine is None
    engine = engine or create_engine(get_settings().database_url)
    try:
        async with create_session_factory(engine)() as db:
            user = await auth.find_user(db, email)
            if user is None:
                print(f"Пользователь {email} не найден", file=sys.stderr)
                return 1
            if command == "make-admin":
                user.is_admin = True
                user.is_active = True
            elif command == "unlock":
                auth.unlock(user)
            else:
                print(__doc__, file=sys.stderr)
                return 2
            await db.commit()
            print(f"Готово: {command} {user.email}")
            return 0
    finally:
        if own:
            await engine.dispose()


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    return asyncio.run(run(sys.argv[1], sys.argv[2]))


if __name__ == "__main__":
    raise SystemExit(main())
