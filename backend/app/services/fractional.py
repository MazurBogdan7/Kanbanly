"""Fractional indexing (порт rocicorp/fractional-indexing): порядок без перезаписи соседей."""

DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
INTEGER_ZERO = "a0"
SMALLEST_INTEGER = "A" + "0" * 26


def _midpoint(a: str, b: str | None) -> str:
    if b is not None and a >= b:
        raise ValueError(f"{a} >= {b}")
    if a.endswith("0") or (b is not None and b.endswith("0")):
        raise ValueError("Завершающий ноль недопустим")
    if b is not None:
        prefix = 0
        while (a[prefix] if prefix < len(a) else "0") == b[prefix]:
            prefix += 1
        if prefix > 0:
            return b[:prefix] + _midpoint(a[prefix:], b[prefix:])
    digit_a = DIGITS.index(a[0]) if a else 0
    digit_b = DIGITS.index(b[0]) if b is not None else len(DIGITS)
    if digit_b - digit_a > 1:
        # Округление половины вверх, как Math.round: ключи совпадают с библиотекой на фронте.
        return DIGITS[(digit_a + digit_b + 1) // 2]
    if b is not None and len(b) > 1:
        return b[:1]
    return DIGITS[digit_a] + _midpoint(a[1:], None)


def _integer_length(head: str) -> int:
    if "a" <= head <= "z":
        return ord(head) - ord("a") + 2
    if "A" <= head <= "Z":
        return ord("Z") - ord(head) + 2
    raise ValueError(f"Некорректный ключ: {head}")


def _integer_part(key: str) -> str:
    length = _integer_length(key[0])
    if length > len(key):
        raise ValueError(f"Некорректный ключ: {key}")
    return key[:length]


def _validate(key: str) -> None:
    if key == SMALLEST_INTEGER:
        raise ValueError(f"Некорректный ключ: {key}")
    fraction = key[len(_integer_part(key)) :]
    if fraction.endswith("0"):
        raise ValueError(f"Некорректный ключ: {key}")


def _increment(value: str) -> str | None:
    head, tail = value[0], list(value[1:])
    carry = True
    index = len(tail) - 1
    while carry and index >= 0:
        digit = DIGITS.index(tail[index]) + 1
        if digit == len(DIGITS):
            tail[index] = "0"
        else:
            tail[index] = DIGITS[digit]
            carry = False
        index -= 1
    if not carry:
        return head + "".join(tail)
    if head == "Z":
        return "a0"
    if head == "z":
        return None
    new_head = chr(ord(head) + 1)
    if new_head > "a":
        tail.append("0")
    else:
        tail.pop()
    return new_head + "".join(tail)


def _decrement(value: str) -> str | None:
    head, tail = value[0], list(value[1:])
    borrow = True
    index = len(tail) - 1
    while borrow and index >= 0:
        digit = DIGITS.index(tail[index]) - 1
        if digit == -1:
            tail[index] = DIGITS[-1]
        else:
            tail[index] = DIGITS[digit]
            borrow = False
        index -= 1
    if not borrow:
        return head + "".join(tail)
    if head == "a":
        return "Z" + DIGITS[-1]
    if head == "A":
        return None
    new_head = chr(ord(head) - 1)
    if new_head < "Z":
        tail.append(DIGITS[-1])
    else:
        tail.pop()
    return new_head + "".join(tail)


def key_between(a: str | None, b: str | None) -> str:
    """Ключ строго между a и b; None означает край списка."""
    if a is not None:
        _validate(a)
    if b is not None:
        _validate(b)
    if a is not None and b is not None and a >= b:
        raise ValueError(f"{a} >= {b}")
    if a is None:
        if b is None:
            return INTEGER_ZERO
        integer = _integer_part(b)
        fraction = b[len(integer) :]
        if integer == SMALLEST_INTEGER:
            return integer + _midpoint("", fraction)
        if integer < b:
            return integer
        result = _decrement(integer)
        if result is None:
            raise ValueError("Не удаётся уменьшить ключ")
        return result
    integer = _integer_part(a)
    fraction = a[len(integer) :]
    if b is None:
        result = _increment(integer)
        return integer + _midpoint(fraction, None) if result is None else result
    integer_b = _integer_part(b)
    fraction_b = b[len(integer_b) :]
    if integer == integer_b:
        return integer + _midpoint(fraction, fraction_b)
    result = _increment(integer)
    if result is None:
        raise ValueError("Не удаётся увеличить ключ")
    if result < b:
        return result
    return integer + _midpoint(fraction, None)


def sequence(count: int, start: str | None = None) -> list[str]:
    keys: list[str] = []
    previous = start
    for _ in range(count):
        previous = key_between(previous, None)
        keys.append(previous)
    return keys
