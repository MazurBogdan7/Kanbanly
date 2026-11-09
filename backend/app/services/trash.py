"""Окончательное удаление того, что пролежало в корзине дольше срока хранения."""

import asyncio
import logging
from datetime import timedelta

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.db import utcnow
from app.models import Board, Card, Document, Project, Template

logger = logging.getLogger(__name__)
PURGE_INTERVAL_SECONDS = 3600


async def purge_expired(db: AsyncSession, retention_days: int) -> int:
    threshold = utcnow() - timedelta(days=retention_days)
    removed = 0
    for model in (Card, Document, Board, Project, Template):
        result = await db.execute(delete(model).where(model.deleted_at < threshold))
        removed += int(result.rowcount)  # type: ignore[attr-defined]
    return removed


async def purge_loop(factory: async_sessionmaker[AsyncSession], retention_days: int) -> None:
    while True:
        await asyncio.sleep(PURGE_INTERVAL_SECONDS)
        try:
            async with factory() as session:
                await purge_expired(session, retention_days)
                await session.commit()
        except Exception:
            logger.exception("Не удалось очистить корзину")
