"""Настройки сервера, которые меняет администратор."""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AppSetting

DEFAULTS: dict[str, Any] = {"registration_open": True}


async def get(db: AsyncSession, key: str) -> Any:
    row = await db.get(AppSetting, key)
    return DEFAULTS.get(key) if row is None else row.value


async def put(db: AsyncSession, key: str, value: Any) -> None:
    row = await db.get(AppSetting, key)
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value


async def all_settings(db: AsyncSession) -> dict[str, Any]:
    return {key: await get(db, key) for key in DEFAULTS}
