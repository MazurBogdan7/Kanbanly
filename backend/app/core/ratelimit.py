"""Rate limiting: скользящее окно + экспоненциальная блокировка после превышения.

Хранилище в памяти процесса: один воркер API. Для нескольких воркеров нужен общий
бэкенд с тем же интерфейсом (см. docs/DECISIONS.md).
"""

import hashlib
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

from app.core.errors import ApiError

MAX_LOCK_SECONDS = 3600


@dataclass
class _Bucket:
    hits: deque[float] = field(default_factory=deque)
    strikes: int = 0
    locked_until: float = 0.0


class RateLimiter:
    def __init__(self, attempts: int, window: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.attempts = attempts
        self.window = window
        self.clock = clock
        self._buckets: dict[str, _Bucket] = {}

    @staticmethod
    def key(action: str, ip: str, identity: str) -> str:
        # Ключ хэшируем, чтобы email не лежал в памяти процесса открытым текстом.
        return hashlib.sha256(f"{action}|{ip}|{identity.strip().lower()}".encode()).hexdigest()

    def hit(self, key: str) -> None:
        now = self.clock()
        bucket = self._buckets.setdefault(key, _Bucket())
        if bucket.locked_until > now:
            raise self._error(bucket.locked_until - now)
        while bucket.hits and bucket.hits[0] <= now - self.window:
            bucket.hits.popleft()
        if len(bucket.hits) >= self.attempts:
            bucket.strikes += 1
            delay = min(self.window * 2 ** (bucket.strikes - 1), MAX_LOCK_SECONDS)
            bucket.locked_until = now + delay
            bucket.hits.clear()
            raise self._error(delay)
        bucket.hits.append(now)
        self._evict(now)

    def reset(self, key: str) -> None:
        self._buckets.pop(key, None)

    def _evict(self, now: float) -> None:
        if len(self._buckets) < 10_000:
            return
        horizon = now - self.window
        stale = [
            k
            for k, b in self._buckets.items()
            if b.locked_until < now and (not b.hits or b.hits[-1] < horizon)
        ]
        for k in stale:
            del self._buckets[k]

    @staticmethod
    def _error(seconds: float) -> ApiError:
        retry = max(1, int(seconds + 0.999))
        return ApiError(
            429,
            "rate_limited",
            "Слишком много попыток. Повторите позже.",
            {"retry_after": retry},
            headers={"Retry-After": str(retry)},
        )
