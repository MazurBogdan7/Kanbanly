"""UUIDv7 (RFC 9562): сортируется по времени, поэтому годится как курсор пагинации."""

import os
import threading
import time
import uuid

_lock = threading.Lock()
_last_ms = 0
_sequence = 0


def uuid7() -> uuid.UUID:
    global _last_ms, _sequence
    with _lock:
        now_ms = time.time_ns() // 1_000_000
        if now_ms <= _last_ms:
            # Монотонность внутри одной миллисекунды обеспечиваем счётчиком в rand_a.
            _sequence += 1
            if _sequence > 0xFFF:
                _last_ms += 1
                _sequence = 0
            now_ms = _last_ms
        else:
            _last_ms = now_ms
            _sequence = 0
        rand_a = _sequence
    rand_b = int.from_bytes(os.urandom(8), "big") & ((1 << 62) - 1)
    value = (now_ms & ((1 << 48) - 1)) << 80 | 0x7 << 76 | rand_a << 64 | 0b10 << 62 | rand_b
    return uuid.UUID(int=value)
