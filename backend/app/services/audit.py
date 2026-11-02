from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditLog


def audit(
    db: AsyncSession,
    user_id: UUID | None,
    action: str,
    *,
    ip: str = "",
    target_type: str = "",
    target_id: UUID | str = "",
    **meta: Any,
) -> None:
    db.add(
        AuditLog(
            user_id=user_id,
            action=action,
            ip=ip,
            target_type=target_type,
            target_id=str(target_id),
            meta=meta,
        )
    )
