"""Текст, который PostgreSQL не примет: NUL и одиночные суррогаты.

SQLite такие строки хранит, поэтому проблема видна только в проде: запрос падает с 500.
"""

from typing import Any

SURROGATES = range(0xD800, 0xE000)


def is_bad_text(value: str) -> bool:
    return any(char == "\x00" or ord(char) in SURROGATES for char in value)


def contains_bad_text(document: Any) -> bool:
    stack = [document]
    while stack:
        value = stack.pop()
        if isinstance(value, str):
            if is_bad_text(value):
                return True
        elif isinstance(value, dict):
            stack.extend(value.keys())
            stack.extend(value.values())
        elif isinstance(value, list):
            stack.extend(value)
    return False
